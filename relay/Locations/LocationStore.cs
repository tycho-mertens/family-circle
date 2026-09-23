using System.Security.Cryptography;
using System.Text.Json;
using Microsoft.Data.Sqlite;

namespace FamilyCircle.Relay.Locations;

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
        Execute("""
            PRAGMA journal_mode=DELETE;
            PRAGMA secure_delete=ON;
            PRAGMA synchronous=FULL;
            CREATE TABLE IF NOT EXISTS metadata (
                id INTEGER PRIMARY KEY CHECK(id=1),
                generation TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS sessions (
                id TEXT PRIMARY KEY,
                revision INTEGER NOT NULL,
                expires INTEGER NOT NULL,
                terminal INTEGER NOT NULL,
                snapshot TEXT NULL
            );
            CREATE INDEX IF NOT EXISTS expiry ON sessions(expires) WHERE terminal=0;
            """);

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
            write.CommandText = """
                INSERT INTO sessions(id,revision,expires,terminal,snapshot)
                VALUES($id,$revision,$expires,$terminal,$snapshot)
                ON CONFLICT(id) DO UPDATE SET
                    revision=$revision,
                    expires=$expires,
                    terminal=$terminal,
                    snapshot=$snapshot
                """;
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
        var status = result.Status switch
        {
            "missing" => StatusCodes.Status404NotFound,
            "terminal" => StatusCodes.Status410Gone,
            _ => StatusCodes.Status200OK,
        };
        return (status, result.Snapshot);
    }

    public void Dispose()
    {
        lock (gate)
        {
            db.Dispose();
        }
    }
}
