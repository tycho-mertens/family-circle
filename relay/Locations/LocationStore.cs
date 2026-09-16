using System.Globalization;
using FamilyCircle.Relay.Services;
using FamilyCircle.Relay.Repositories;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using Microsoft.AspNetCore.Mvc;
using Microsoft.Data.Sqlite;
using Org.BouncyCastle.Crypto.Parameters;
using Org.BouncyCastle.Crypto.Signers;

namespace FamilyCircle.Relay.Locations;

public record LocationSnapshot(string Generation, string SessionId, string MailboxId,
    string PublicKey, long Epoch, long ExpiresAt, long Revision, bool Stopped,
    string Nonce, string Ciphertext, string Signature)
{
    public byte[] SigningBytes() => Encoding.UTF8.GetBytes(string.Join("\n",
        "family-circle/location/v1", Generation, SessionId, MailboxId, PublicKey,
        Epoch.ToString(CultureInfo.InvariantCulture), ExpiresAt.ToString(CultureInfo.InvariantCulture),
        Revision.ToString(CultureInfo.InvariantCulture), Stopped ? "1" : "0", Nonce, Ciphertext));

    /// <summary>
    /// Checks field shapes, then that the snapshot is signed by the key its SessionId
    /// commits to. A stopped snapshot must carry no ciphertext at all.
    /// </summary>
    public bool Valid()
    {
        static bool Hex(string? value, int length) =>
            value is not null && value.Length == length && value.All(c => c is >= '0' and <= '9' or >= 'a' and <= 'f');

        if (!Hex(Generation, 32) || !Hex(SessionId, 64) || !Hex(MailboxId, 32) ||
            !Hex(PublicKey, 64) || !Hex(Signature, 128))
        {
            return false;
        }

        if (Epoch < 0 || ExpiresAt < 0 || Revision is < 1 or > 9007199254740991)
        {
            return false;
        }

        var payloadValid = Stopped
            ? Nonce == "" && Ciphertext == ""
            : Hex(Nonce, 24) && Ciphertext is not null && Ciphertext.Length is >= 32 and <= 4096 &&
              Hex(Ciphertext, Ciphertext.Length) && Ciphertext.Length % 2 == 0;
        if (!payloadValid)
        {
            return false;
        }

        try
        {
            var key = Convert.FromHexString(PublicKey);
            if (Convert.ToHexStringLower(SHA256.HashData(key)) != SessionId)
            {
                return false;
            }

            var signer = new Ed25519Signer();
            signer.Init(false, new Ed25519PublicKeyParameters(key, 0));
            var bytes = SigningBytes();
            signer.BlockUpdate(bytes, 0, bytes.Length);
            return signer.VerifySignature(Convert.FromHexString(Signature));
        }
        catch (ArgumentException)
        {
            return false;
        }
    }
}

/// <summary>
/// Separate ephemeral database holding one ciphertext per session, plus
/// coordinate-free terminal rows. Keeps no coordinate history, and is never
/// included in a relay backup.
/// </summary>
public sealed class LocationStore : IDisposable
{
    private readonly SqliteConnection db;
    private readonly object gate = new();
    private readonly int maxSessions;
    private static readonly JsonSerializerOptions Json = new(JsonSerializerDefaults.Web);

    /// <summary>
    /// Identifies this store's data set. Clients that cached against a different
    /// generation must resynchronise rather than trust their cursors.
    /// </summary>
    public string Generation { get; }

    public LocationStore(IConfiguration config)
    {
        var relayPath = new SqliteConnectionStringBuilder(
            config.GetConnectionString("Relay") ?? "Data Source=relay.dev.db").DataSource;
        var path = config["Locations:DatabasePath"] ?? relayPath + ".locations";
        db = new SqliteConnection(new SqliteConnectionStringBuilder { DataSource = path, Pooling = false }.ToString());
        db.Open();
        maxSessions = Math.Max(1, config.GetValue("Locations:MaxSessions", 100000));

        // secure_delete so overwritten ciphertext is not left in free pages.
        Execute("PRAGMA journal_mode=DELETE; PRAGMA secure_delete=ON; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS metadata (id INTEGER PRIMARY KEY CHECK(id=1), generation TEXT NOT NULL); CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, revision INTEGER NOT NULL, expires INTEGER NOT NULL, terminal INTEGER NOT NULL, snapshot TEXT NULL); CREATE INDEX IF NOT EXISTS expiry ON sessions(expires) WHERE terminal=0;");

        using var insert = db.CreateCommand();
        insert.CommandText = "INSERT OR IGNORE INTO metadata VALUES(1,$generation)";
        insert.Parameters.AddWithValue("$generation", Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(16)));
        insert.ExecuteNonQuery();

        using var read = db.CreateCommand();
        read.CommandText = "SELECT generation FROM metadata WHERE id=1";
        Generation = (string)read.ExecuteScalar()!;
    }

    private void Execute(string sql)
    {
        using var cmd = db.CreateCommand();
        cmd.CommandText = sql;
        cmd.ExecuteNonQuery();
    }

    /// <summary>Drops the ciphertext of every session past its expiry, leaving a
    /// coordinate-free terminal row behind.</summary>
    public void Expire(long now)
    {
        lock (gate)
        {
            using var cmd = db.CreateCommand();
            cmd.CommandText = "UPDATE sessions SET terminal=1,snapshot=NULL WHERE terminal=0 AND expires>0 AND expires<=$now";
            cmd.Parameters.AddWithValue("$now", now);
            cmd.ExecuteNonQuery();
        }
    }

    /// <summary>
    /// Stores a snapshot, returning the HTTP status the endpoint should send.
    /// Terminal is permanent: once a session stops or expires it can never be
    /// resurrected, and revisions must advance monotonically.
    /// </summary>
    public int Put(LocationSnapshot wire, long now)
    {
        if (!wire.Valid())
        {
            return 400;
        }

        if (wire.Generation != Generation)
        {
            return 409;
        }

        lock (gate)
        {
            Expire(now);
            using var tx = db.BeginTransaction();

            using var read = db.CreateCommand();
            read.Transaction = tx;
            read.CommandText = "SELECT revision,terminal,snapshot FROM sessions WHERE id=$id";
            read.Parameters.AddWithValue("$id", wire.SessionId);

            long revision = 0;
            bool terminal = false;
            string? stored = null;
            bool exists;
            using (var row = read.ExecuteReader())
            {
                exists = row.Read();
                if (exists)
                {
                    revision = row.GetInt64(0);
                    terminal = row.GetInt32(1) != 0;
                    stored = row.IsDBNull(2) ? null : row.GetString(2);
                }
            }

            // A repeated stop is idempotent; anything else after terminal is gone.
            if (terminal)
            {
                return wire.Stopped ? 200 : 410;
            }

            if (wire.ExpiresAt > now + 30L * 86400000)
            {
                return 400;
            }

            var encoded = JsonSerializer.Serialize(wire, Json);

            // Replaying the identical snapshot is a success; anything else at or
            // behind the stored revision is a conflict.
            if (exists && wire.Revision <= revision)
            {
                return wire.Revision == revision && stored == encoded ? 200 : 409;
            }

            if (!exists)
            {
                using var count = db.CreateCommand();
                count.Transaction = tx;
                count.CommandText = "SELECT count(*) FROM sessions";
                if ((long)count.ExecuteScalar()! >= maxSessions)
                {
                    return 503;
                }
            }

            terminal = wire.Stopped || (wire.ExpiresAt != 0 && wire.ExpiresAt <= now);

            using var write = db.CreateCommand();
            write.Transaction = tx;
            write.CommandText = "INSERT INTO sessions(id,revision,expires,terminal,snapshot) VALUES($id,$revision,$expires,$terminal,$snapshot) ON CONFLICT(id) DO UPDATE SET revision=$revision,expires=$expires,terminal=$terminal,snapshot=$snapshot";
            write.Parameters.AddWithValue("$id", wire.SessionId);
            write.Parameters.AddWithValue("$revision", wire.Revision);
            write.Parameters.AddWithValue("$expires", wire.ExpiresAt);
            write.Parameters.AddWithValue("$terminal", terminal ? 1 : 0);
            write.Parameters.AddWithValue("$snapshot", terminal ? DBNull.Value : encoded);
            write.ExecuteNonQuery();

            tx.Commit();
            return 200;
        }
    }

    public IReadOnlyList<LocationReadResult> GetBatch(IReadOnlyList<LocationRead> reads, long now)
    {
        if (reads.Count is < 1 or > 100)
        {
            throw new ArgumentOutOfRangeException(nameof(reads));
        }

        lock (gate)
        {
            using var cmd = db.CreateCommand();
            var names = reads.Select((item, i) =>
            {
                var name = "$id" + i;
                cmd.Parameters.AddWithValue(name, item.SessionId);
                return name;
            }).ToArray();
            cmd.CommandText = $"SELECT id, revision, terminal, expires, snapshot FROM sessions WHERE id IN ({string.Join(',', names)})";

            var found = new Dictionary<string, (long Revision, bool Terminal, string? Snapshot)>();
            using (var row = cmd.ExecuteReader())
            {
                while (row.Read())
                {
                    // Treat a row that has expired but not yet been swept as terminal.
                    var isTerminal = row.GetInt32(2) != 0 || (row.GetInt64(3) > 0 && row.GetInt64(3) <= now);
                    found[row.GetString(0)] = (row.GetInt64(1), isTerminal, row.IsDBNull(4) ? null : row.GetString(4));
                }
            }

            return reads.Select(item =>
            {
                if (!found.TryGetValue(item.SessionId, out var row))
                {
                    return new LocationReadResult(item.SessionId, "missing", null);
                }

                if (row.Terminal)
                {
                    return new LocationReadResult(item.SessionId, "terminal", null);
                }

                if (item.Revision == row.Revision)
                {
                    return new LocationReadResult(item.SessionId, "unchanged", null);
                }

                return new LocationReadResult(item.SessionId, "changed", JsonSerializer.Deserialize<LocationSnapshot>(row.Snapshot!, Json));
            }).ToArray();
        }
    }

    public (int Status, LocationSnapshot? Snapshot) Get(string id, long now)
    {
        var result = GetBatch([new LocationRead(id, null)], now)[0];
        return (result.Status == "missing" ? 404 : result.Status == "terminal" ? 410 : 200, result.Snapshot);
    }

    public void Dispose()
    {
        lock (gate)
        {
            db.Dispose();
        }
    }
}

public sealed class LocationCleanup(LocationStore store) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken token)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromSeconds(15));
        try
        {
            while (await timer.WaitForNextTickAsync(token))
            {
                store.Expire(DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
            }
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested)
        {
        }
    }
}

public record LocationRead(string SessionId, long? Revision);

public record LocationReadResult(string SessionId, string Status, LocationSnapshot? Snapshot);

public record LocationBatchRequest(string Generation, LocationRead[] Sessions);

public static class LocationEndpoints
{
    // Signed location snapshots and batched reads carry compact metadata only, and
    // should never inherit the multi-megabyte backup allowance.
    private const long MaxLocationRequestBodyBytes = 128 * 1024;

    public static void MapLocations(this WebApplication app)
    {
        app.MapPost("/v1/locations/batch", (LocationBatchRequest request, LocationStore store, HttpContext ctx) =>
        {
            ctx.Response.Headers.CacheControl = "no-store";
            if (request.Sessions is null || request.Sessions.Length is < 1 or > 100 ||
                request.Sessions.Any(x => x is null || x.SessionId is null || x.SessionId.Length != 64 ||
                                          !x.SessionId.All(Uri.IsHexDigit) || x.Revision is < 0))
            {
                return Results.BadRequest();
            }

            if (request.Generation != store.Generation)
            {
                return Results.Conflict(new { generation = store.Generation });
            }

            return Results.Ok(new
            {
                generation = store.Generation,
                results = store.GetBatch(request.Sessions, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()),
            });
        }).WithMetadata(new RequestSizeLimitAttribute(MaxLocationRequestBodyBytes));

        app.MapGet("/v1/locations/generation", (LocationStore store, HttpContext ctx) =>
        {
            ctx.Response.Headers.CacheControl = "no-store";
            return Results.Ok(new { generation = store.Generation });
        });

        app.MapPut("/v1/locations/{id}", async Task<IResult> (
            string id, LocationSnapshot wire, LocationStore store, IMailboxRepository mailboxes,
            SyncNotifications notifications, HttpContext ctx, CancellationToken ct) =>
        {
            ctx.Response.Headers.CacheControl = "no-store";
            if (id != wire.SessionId)
            {
                return Results.BadRequest();
            }

            // The signature authenticates this snapshot's session, but cannot
            // establish that its claimed notification mailbox was ever registered.
            // Reject unknown mailboxes before touching the location store.
            if (!await mailboxes.MailboxExistsAsync(wire.MailboxId, ct))
            {
                return Results.NotFound();
            }

            var status = store.Put(wire, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
            if (status == 200)
            {
                notifications.Changed(wire.MailboxId);
            }

            return Results.StatusCode(status);
        }).WithMetadata(new RequestSizeLimitAttribute(MaxLocationRequestBodyBytes));

        app.MapGet("/v1/locations/{id}", (string id, LocationStore store, HttpContext ctx) =>
        {
            ctx.Response.Headers.CacheControl = "no-store";
            var (status, snapshot) = store.Get(id, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
            return status == 200 ? Results.Ok(snapshot) : Results.StatusCode(status);
        });
    }
}
