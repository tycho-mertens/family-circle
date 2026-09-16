using FamilyCircle.Relay.Locations;
using System.Threading.RateLimiting;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.HttpOverrides;
using System.Net;
using FamilyCircle.Relay.Contracts;
using FamilyCircle.Relay.Data;
using FamilyCircle.Relay.Models;
using FamilyCircle.Relay.Repositories;
using FamilyCircle.Relay.Services;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.AspNetCore.Http.Metadata;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using Microsoft.EntityFrameworkCore;

const int maxCiphertextBytes = 256 * 1024;
// Event IDs are client-generated protocol metadata; the cap keeps a SQLite index
// entry from outgrowing the payload it identifies.
const int maxEventIdCharacters = 512;
// Application envelopes use a 12-byte AEAD nonce, control traffic a one-byte
// sentinel. Headroom for future algorithms, still bounded.
const int maxEnvelopeNonceBytes = 64;
const int defaultTtlSeconds = 7 * 24 * 60 * 60;
const int maxTtlSeconds = 30 * 24 * 60 * 60;
// A backup blob holds a device's full MLS state across every joined Circle, not a
// single message, so it needs far more headroom than one envelope.
const int maxBackupBytes = 4 * 1024 * 1024;
// HKDF-SHA256 output: an HMAC key of fixed protocol size, never a seed phrase.
const int backupAuthVerifierBytes = 32;
// JSON byte arrays arrive base64 encoded; these budgets include that expansion so
// routes other than backup upload don't inherit the multi-megabyte allowance.
const long maxEnvelopeRequestBodyBytes = 384 * 1024;
const long maxBackupRequestBodyBytes = 6 * 1024 * 1024;
const long maxSmallRequestBodyBytes = 32 * 1024;

// HMAC-SHA256(backup.AuthVerifier, decoded nonce) == proof, shared by the update
// and fetch endpoints below. Compared in constant time: the proof's value must not
// be distinguishable by timing, though its length need not be secret.
static bool VerifyBackupProof(byte[] authVerifier, string nonceBase64, byte[] proof)
{
    byte[] nonceBytes;
    try
    {
        nonceBytes = Convert.FromBase64String(nonceBase64);
    }
    catch (FormatException)
    {
        return false;
    }

    using var hmac = new System.Security.Cryptography.HMACSHA256(authVerifier);
    var expected = hmac.ComputeHash(nonceBytes);
    return System.Security.Cryptography.CryptographicOperations.FixedTimeEquals(expected, proof);
}

var builder = WebApplication.CreateBuilder(args);

builder.WebHost.ConfigureKestrel(o =>
{
    // Per-endpoint metadata narrows this further; Kestrel only needs to admit the
    // largest supported route, which is backup upload.
    o.Limits.MaxRequestBodySize = maxBackupRequestBodyBytes;
});

builder.Services.AddOpenApi();
builder.Services.AddDataProtection();
builder.Services.AddSingleton<InstallationAccess>();
builder.Services.Configure<ForwardedHeadersOptions>(options =>
{
    options.ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto;
    foreach (var proxy in builder.Configuration.GetSection("Access:TrustedProxies").Get<string[]>() ?? [])
        options.KnownProxies.Add(IPAddress.Parse(proxy));
});
builder.Services.AddSignalR(options =>
{
    options.MaximumReceiveMessageSize = 8192;
    options.MaximumParallelInvocationsPerClient = 1;
    options.HandshakeTimeout = TimeSpan.FromSeconds(15);
    // Three minutes, not the 15-second default: a frequent heartbeat keeps mobile
    // radios awake. Allow enough silence for clients and NATs to sleep.
    options.KeepAliveInterval = TimeSpan.FromMinutes(3);
    options.ClientTimeoutInterval = TimeSpan.FromMinutes(10);
    options.EnableDetailedErrors = false;
});
builder.Services.AddSingleton<SyncHubLimits>();
builder.Services.AddSingleton<SyncNotifications>();
builder.Services.AddHostedService(sp => sp.GetRequiredService<SyncNotifications>());
builder.Services.AddSingleton<LocationStore>();
builder.Services.AddHostedService<LocationCleanup>();
builder.Services.AddProblemDetails();

// Resolve configuration when creating the context so WebApplicationFactory
// overrides select each test's database instead of the shared fallback file.
builder.Services.AddDbContext<RelayDbContext>((serviceProvider, options) =>
{
    var configuration = serviceProvider.GetRequiredService<IConfiguration>();
    var connectionString = configuration.GetConnectionString("Relay") ?? "Data Source=relay.dev.db";
    options.UseSqlite(connectionString);
});
builder.Services.AddScoped<IMailboxRepository, SqliteMailboxRepository>();
builder.Services.AddScoped<IBackupRepository, SqliteBackupRepository>();
// Singleton, not scoped: issue and redeem arrive on separate requests.
builder.Services.AddSingleton<BackupChallengeStore>();
builder.Services.AddHostedService<TtlCleanupService>();
builder.Services.AddHostedService<BackupChallengeCleanupService>();

builder.Services.AddRateLimiter(options =>
{
    options.RejectionStatusCode = StatusCodes.Status429TooManyRequests;
    options.OnRejected = (context, _) =>
    {
        context.HttpContext.Response.Headers.RetryAfter = "60";
        return ValueTask.CompletedTask;
    };

    // Chained: a request must pass the per-IP window and, once enrolled, the
    // per-installation one. IP partitioning alone collapses every device behind a
    // NAT onto one bucket, which is why the installation partition exists.
    options.GlobalLimiter = PartitionedRateLimiter.CreateChained(
        PartitionedRateLimiter.Create<HttpContext, string>(ctx =>
            RateLimitPartition.GetFixedWindowLimiter(
                ctx.Connection.RemoteIpAddress?.ToString() ?? "unknown",
                _ => new FixedWindowRateLimiterOptions
                {
                    PermitLimit = ctx.RequestServices.GetRequiredService<IConfiguration>()
                        .GetValue("Limits:RequestsPerIpMinute", 12000),
                    Window = TimeSpan.FromMinutes(1),
                    QueueLimit = 0,
                })),
        PartitionedRateLimiter.Create<HttpContext, string>(ctx => ctx.Items["installation"] is string id
            ? RateLimitPartition.GetFixedWindowLimiter(
                id,
                _ => new FixedWindowRateLimiterOptions
                {
                    PermitLimit = ctx.RequestServices.GetRequiredService<IConfiguration>()
                        .GetValue("Limits:RequestsPerInstallationMinute", 1200),
                    Window = TimeSpan.FromMinutes(1),
                    QueueLimit = 0,
                })
            : RateLimitPartition.GetNoLimiter("anonymous")));

    options.AddPolicy("enrollment", ctx =>
        RateLimitPartition.GetFixedWindowLimiter(
            ctx.Connection.RemoteIpAddress?.ToString() ?? "unknown",
            _ => new FixedWindowRateLimiterOptions
            {
                PermitLimit = 60,
                Window = TimeSpan.FromHours(1),
                QueueLimit = 0,
            }));
});

var app = builder.Build();
app.Services.GetRequiredService<InstallationAccess>().ValidateConfiguration();
app.MapLocations();
if (app.Configuration.GetValue("Sync:Enabled", true))
{
    app.MapHub<SyncHub>("/v1/sync", options =>
    {
        options.ApplicationMaxBufferSize = 32768;
        options.TransportMaxBufferSize = 32768;
    });
}

if (app.Environment.IsDevelopment())
{
    app.MapOpenApi();
}

// Require HTTPS outside Development; LanDemo uses HTTP on the private LAN.
// Read configured URLs because TestServer does not populate app.Urls.
// If HTTPS endpoints move to Kestrel-specific configuration, update this guard too.
if (!app.Environment.IsDevelopment())
{
    var configuredUrls = app.Configuration["urls"] ?? "";
    var hasHttpsUrl = configuredUrls
        .Split(';', StringSplitOptions.RemoveEmptyEntries)
        .Any(u => u.StartsWith("https://", StringComparison.OrdinalIgnoreCase));
    if (!hasHttpsUrl)
    {
        throw new InvalidOperationException(
            "Refusing to start outside Development without an HTTPS endpoint configured. " +
            "Configure an https:// endpoint via ASPNETCORE_URLS or --urls, or run under " +
            "ASPNETCORE_ENVIRONMENT=Development for local-LAN dev testing only.");
    }
}

// Creates the SQLite schema directly; there are no EF Core migrations yet.
// Revisit before moving off SQLite.
using (var scope = app.Services.CreateScope())
{
    var db = scope.ServiceProvider.GetRequiredService<RelayDbContext>();
    await db.Database.EnsureCreatedAsync();
    var membershipDays = Math.Clamp(app.Configuration.GetValue("Retention:MembershipDays", 30), 7, 365);
    var retentionModifier = $"+{membershipDays} days";
    await db.Database.ExecuteSqlInterpolatedAsync($"UPDATE Envelopes SET ExpiresAt=datetime(CreatedAt,{retentionModifier}) WHERE Kind IN ('commit','leave') AND ExpiresAt IS NOT NULL AND ExpiresAt<datetime(CreatedAt,{retentionModifier})");
    // Additive migration for existing installations. A conservative initial head
    // makes old clients catch up even if earlier commits already expired.
    await db.Database.ExecuteSqlRawAsync("CREATE TABLE IF NOT EXISTS MembershipHeads (MailboxId TEXT PRIMARY KEY, SequenceId INTEGER NOT NULL); INSERT OR IGNORE INTO MembershipHeads SELECT MailboxId, MAX(SequenceId) FROM Envelopes GROUP BY MailboxId;");
}

app.UseExceptionHandler();
app.UseForwardedHeaders();
app.UseRouting();
// Kestrel's global limit admits the largest supported backup, so apply the smaller
// per-endpoint budgets before model binding reads the request stream.
app.Use(async (ctx, next) =>
{
    var limit = ctx.GetEndpoint()?.Metadata.GetMetadata<IRequestSizeLimitMetadata>()?.MaxRequestBodySize;
    var feature = ctx.Features.Get<IHttpMaxRequestBodySizeFeature>();
    if (limit is not null && feature is { IsReadOnly: false })
    {
        feature.MaxRequestBodySize = limit;
    }

    await next(ctx);
});
app.Use(RelayMetrics.Measure);
app.Use(async (ctx, next) =>
{
    var access = ctx.RequestServices.GetRequiredService<InstallationAccess>();
    var token = ctx.Request.Headers["X-Installation-Token"].ToString();
    var id = access.Read(token);
    if (id is not null)
    {
        ctx.Items["installation"] = id;
    }

    // Enrolment and capability discovery must stay reachable without a token;
    // everything else under /v1 requires one.
    var needsToken = access.Required && id is null &&
        ctx.Request.Path.StartsWithSegments("/v1") &&
        ctx.Request.Path != "/v1/installations" &&
        ctx.Request.Path != "/v1/capabilities";
    if (needsToken)
    {
        ctx.Response.StatusCode = 401;
        return;
    }

    await next(ctx);
});
// LanDemo uses HTTP so local devices do not need a development certificate.
// Without an HTTPS endpoint, redirection logs a warning and leaves HTTP requests alone.
app.UseHttpsRedirection();
if (!app.Environment.IsDevelopment())
{
    // Strict-Transport-Security, so a client that has once reached this relay over
    // HTTPS refuses to downgrade later. Gated to match the HTTP-only Development
    // posture above, where there is no transport security to pin.
    app.UseHsts();
}
app.UseRateLimiter();

// Intentionally no request/response body logging middleware anywhere in this
// pipeline: envelopes carry ciphertext and must not reach the logs.

var api = app.MapGroup("/v1");
api.MapPost("/installations", (EnrollmentRequest request, InstallationAccess access) =>
    access.CanEnroll(request.Code) ? Results.Ok(new { token = access.Issue() }) : Results.Unauthorized())
    .RequireRateLimiting("enrollment")
    .WithMetadata(new RequestSizeLimitAttribute(maxSmallRequestBodyBytes));
api.MapGet("/capabilities", (IConfiguration configuration) => Results.Ok(new
{
    membershipAdmission = configuration.GetValue("Sync:MembershipAdmission", true) ? "membership-v1" : null,
    locationBatch = configuration.GetValue("Locations:BatchEnabled", true),
    syncHub = configuration.GetValue("Sync:Enabled", true) ? "/v1/sync" : null,
}));

api.MapPost("/devices", async Task<IResult> (IMailboxRepository repo, IConfiguration configuration, CancellationToken ct) =>
{
    // Mailboxes persist indefinitely, so cap their total count as well as request rate.
    // Resolve configuration from DI, as above. The repository checks capacity and
    // inserts atomically to prevent concurrent registrations from exceeding the cap.
    var maxMailboxes = configuration.GetValue("Limits:MaxMailboxes", 100_000);
    var mailboxId = await repo.TryRegisterMailboxIfUnderCapAsync(maxMailboxes, ct);
    if (mailboxId is null)
    {
        return Results.StatusCode(StatusCodes.Status503ServiceUnavailable);
    }

    return Results.Created($"/v1/mailboxes/{mailboxId}", new RegisterMailboxResponse(mailboxId));
})
.WithName("RegisterDevice");

api.MapPost("/mailboxes/{id}/events", async Task<Results<Created<EnvelopeResponse>, Ok<EnvelopeResponse>, ValidationProblem, NotFound, Conflict<MailboxChangedResponse>>> (
    string id, UploadEnvelopeRequest request, IMailboxRepository repo, IConfiguration configuration, SyncNotifications notifications, CancellationToken ct) =>
{
    if (!await repo.MailboxExistsAsync(id, ct))
    {
        return TypedResults.NotFound();
    }

    var errors = new Dictionary<string, string[]>();
    if (string.IsNullOrWhiteSpace(request.EventId) || request.EventId.Length > maxEventIdCharacters)
    {
        errors["eventId"] = [$"required, max {maxEventIdCharacters} characters"];
    }
    if (string.IsNullOrWhiteSpace(request.Kind) || request.Kind.Length > 32)
    {
        errors["kind"] = ["required, max 32 characters"];
    }
    if (request.Nonce is not { Length: > 0 and <= maxEnvelopeNonceBytes })
    {
        errors["nonce"] = [$"required, max {maxEnvelopeNonceBytes} bytes"];
    }
    if (request.Ciphertext is not { Length: > 0 and <= maxCiphertextBytes })
    {
        errors["ciphertext"] = [$"required, max {maxCiphertextBytes} bytes"];
    }
    if (request.TtlSeconds is < 1 or > maxTtlSeconds)
    {
        errors["ttlSeconds"] = [$"must be between 1 and {maxTtlSeconds}"];
    }
    if (request.ExpectedSequenceId is < 0 || request.Admission is not (null or "membership-v1"))
        errors["admission"] = ["invalid admission mode or cursor"];
    if (errors.Count > 0)
    {
        return TypedResults.ValidationProblem(errors);
    }

    var now = DateTime.UtcNow;
    var envelope = new Envelope
    {
        MailboxId = id,
        EventId = request.EventId,
        Epoch = request.Epoch,
        Kind = request.Kind,
        Nonce = request.Nonce,
        Ciphertext = request.Ciphertext,
        CreatedAt = now,
        ExpiresAt = now.AddSeconds(request.Kind is "commit" or "leave"
            ? Math.Max(request.TtlSeconds ?? defaultTtlSeconds, Math.Clamp(configuration.GetValue("Retention:MembershipDays", 30), 7, 365) * 86400)
            : request.TtlSeconds ?? defaultTtlSeconds),
    };

    bool inserted;
    try { inserted = await repo.TryAddEventAsync(envelope, ct, request.ExpectedSequenceId, request.Admission == "membership-v1"); }
    catch (MailboxChangedException) { return TypedResults.Conflict(new MailboxChangedResponse("mailbox-changed")); }
    if (inserted) { notifications.Changed(id); }
    var response = new EnvelopeResponse(
        envelope.SequenceId, envelope.EventId, envelope.Epoch, envelope.Kind, envelope.Nonce, envelope.Ciphertext, envelope.CreatedAt);

    // Idempotent: a duplicate eventId is not an error and stores no second event.
    return inserted
        ? TypedResults.Created($"/v1/mailboxes/{id}/events/{envelope.EventId}", response)
        : TypedResults.Ok(response);
})
.WithName("UploadEvent")
.WithMetadata(new RequestSizeLimitAttribute(maxEnvelopeRequestBodyBytes));

api.MapGet("/mailboxes/{id}/events", async Task<Results<Ok<IReadOnlyList<EnvelopeResponse>>, NotFound>> (
    string id, long? after, int? limit, IMailboxRepository repo, CancellationToken ct) =>
{
    if (!await repo.MailboxExistsAsync(id, ct))
    {
        return TypedResults.NotFound();
    }

    var events = await repo.GetEventsAfterAsync(id, after ?? 0, Math.Clamp(limit ?? 100, 1, 500), ct);
    var response = events
        .Select(e => new EnvelopeResponse(e.SequenceId, e.EventId, e.Epoch, e.Kind, e.Nonce, e.Ciphertext, e.CreatedAt))
        .ToList();
    return TypedResults.Ok<IReadOnlyList<EnvelopeResponse>>(response);
})
.WithName("GetEvents");

api.MapPost("/mailboxes/{id}/ack", async Task<Results<NoContent, NotFound>> (
    string id, AckRequest request, IMailboxRepository repo, CancellationToken ct) =>
{
    if (!await repo.MailboxExistsAsync(id, ct))
    {
        return TypedResults.NotFound();
    }

    await repo.AckAsync(id, request.SequenceId, ct);
    return TypedResults.NoContent();
})
.WithName("AckEvents")
.WithMetadata(new RequestSizeLimitAttribute(maxSmallRequestBodyBytes));

// Backup registration claims a new ID; subsequent reads and writes require
// a fresh HMAC challenge response. The encryption key stays on the client.

var backups = app.MapGroup("/v1/backups");

backups.MapPost("/{backupId}/challenge", async Task<Results<Ok<BackupChallengeResponse>, NotFound>> (
    string backupId, IBackupRepository repo, BackupChallengeStore challenges, CancellationToken ct) =>
{
    if (await repo.FindAsync(backupId, ct) is null)
    {
        return TypedResults.NotFound();
    }

    return TypedResults.Ok(new BackupChallengeResponse(challenges.Issue(backupId)));
})
.WithName("RequestBackupChallenge");

backups.MapPost("/{backupId}", async Task<IResult> (
    string backupId, RegisterBackupRequest request, IBackupRepository repo, IConfiguration configuration, CancellationToken ct) =>
{
    var errors = new Dictionary<string, string[]>();
    if (request.AuthVerifier is not { Length: backupAuthVerifierBytes })
    {
        errors["authVerifier"] = [$"must be exactly {backupAuthVerifierBytes} bytes"];
    }
    if (request.Ciphertext is not { Length: > 0 and <= maxBackupBytes })
    {
        errors["ciphertext"] = [$"required, max {maxBackupBytes} bytes"];
    }
    if (errors.Count > 0)
    {
        return TypedResults.ValidationProblem(errors);
    }

    // Backups don't expire on their own either; same capping and same per-request
    // configuration resolution as the mailbox endpoint above.
    var now = DateTime.UtcNow;
    var backup = new Backup
    {
        BackupId = backupId,
        AuthVerifier = request.AuthVerifier,
        Ciphertext = request.Ciphertext,
        UpdatedAt = now,
    };

    var maxBackups = configuration.GetValue("Limits:MaxBackups", 100_000);
    var outcome = await repo.TryRegisterIfUnderCapAsync(backup, maxBackups, ct);
    return outcome switch
    {
        // Registration cannot replace an existing verifier or ciphertext.
        // The owner must update through PUT with a fresh challenge proof.
        BackupRegistrationOutcome.Registered =>
            TypedResults.Created($"/v1/backups/{backupId}", new BackupResponse(backup.Ciphertext, now)),
        BackupRegistrationOutcome.AlreadyExists => TypedResults.Conflict(),
        _ => Results.StatusCode(StatusCodes.Status503ServiceUnavailable),
    };
})
.WithName("RegisterBackup")
.WithMetadata(new RequestSizeLimitAttribute(maxBackupRequestBodyBytes));

backups.MapPut("/{backupId}", async Task<Results<Ok<BackupResponse>, NotFound, UnauthorizedHttpResult, ValidationProblem>> (
    string backupId, UpdateBackupRequest request, IBackupRepository repo, BackupChallengeStore challenges, CancellationToken ct) =>
{
    var backup = await repo.FindAsync(backupId, ct);
    if (backup is null)
    {
        return TypedResults.NotFound();
    }

    if (request.Ciphertext is not { Length: > 0 and <= maxBackupBytes })
    {
        return TypedResults.ValidationProblem(new Dictionary<string, string[]>
        {
            ["ciphertext"] = [$"required, max {maxBackupBytes} bytes"],
        });
    }

    // TryConsume first, and short-circuit on it: a failed proof must still burn the
    // nonce rather than leave it replayable.
    if (!challenges.TryConsume(backupId, request.Nonce) ||
        !VerifyBackupProof(backup.AuthVerifier, request.Nonce, request.Proof))
    {
        return TypedResults.Unauthorized();
    }

    await repo.UpdateCiphertextAsync(backupId, request.Ciphertext, ct);
    return TypedResults.Ok(new BackupResponse(request.Ciphertext, DateTime.UtcNow));
})
.WithName("UpdateBackup")
.WithMetadata(new RequestSizeLimitAttribute(maxBackupRequestBodyBytes));

backups.MapGet("/{backupId}", async Task<Results<Ok<BackupResponse>, NotFound, UnauthorizedHttpResult, ValidationProblem>> (
    string backupId, string? nonce, string? proof, IBackupRepository repo, BackupChallengeStore challenges, CancellationToken ct) =>
{
    var backup = await repo.FindAsync(backupId, ct);
    if (backup is null)
    {
        return TypedResults.NotFound();
    }

    if (string.IsNullOrEmpty(nonce) || string.IsNullOrEmpty(proof))
    {
        return TypedResults.ValidationProblem(new Dictionary<string, string[]>
        {
            ["nonce"] = ["required"],
            ["proof"] = ["required"],
        });
    }

    byte[] proofBytes;
    try
    {
        proofBytes = Convert.FromBase64String(proof);
    }
    catch (FormatException)
    {
        return TypedResults.ValidationProblem(new Dictionary<string, string[]> { ["proof"] = ["must be base64"] });
    }

    if (!challenges.TryConsume(backupId, nonce) || !VerifyBackupProof(backup.AuthVerifier, nonce, proofBytes))
    {
        return TypedResults.Unauthorized();
    }

    return TypedResults.Ok(new BackupResponse(backup.Ciphertext, backup.UpdatedAt));
})
.WithName("FetchBackup");

app.MapGet("/healthz", () => TypedResults.Ok(new { status = "ok" }));

app.Run();

public partial class Program;
