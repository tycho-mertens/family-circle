using FamilyCircle.Relay.Endpoints;
using FamilyCircle.Relay.Hosting;
using FamilyCircle.Relay.Locations;
using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.HttpOverrides;
using System.Net;
using FamilyCircle.Relay.Data;
using FamilyCircle.Relay.Repositories;
using FamilyCircle.Relay.Services;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.AspNetCore.Http.Metadata;
using Microsoft.AspNetCore.Mvc;
using Microsoft.EntityFrameworkCore;

var builder = WebApplication.CreateBuilder(args);

builder.WebHost.ConfigureKestrel(o =>
{
    // Per-endpoint metadata narrows this further; Kestrel only needs to admit the
    // largest supported route, which is backup upload.
    o.Limits.MaxRequestBodySize = RequestBodyLimits.MaxBackupRequestBodyBytes;
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

builder.Services.AddRelayRateLimiting();

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

await app.Services.InitializeRelayDatabaseAsync(app.Configuration);

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
    .WithMetadata(new RequestSizeLimitAttribute(RequestBodyLimits.MaxSmallRequestBodyBytes));
api.MapGet("/capabilities", (IConfiguration configuration) => Results.Ok(new
{
    membershipAdmission = configuration.GetValue("Sync:MembershipAdmission", true) ? "membership-v1" : null,
    locationBatch = configuration.GetValue("Locations:BatchEnabled", true),
    syncHub = configuration.GetValue("Sync:Enabled", true) ? "/v1/sync" : null,
}));

api.MapMailboxEndpoints();
app.MapGroup("/v1/backups").MapBackupEndpoints();

app.MapGet("/healthz", () => TypedResults.Ok(new { status = "ok" }));

app.Run();

public partial class Program;
