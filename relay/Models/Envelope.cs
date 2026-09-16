namespace FamilyCircle.Relay.Models;

/// <summary>
/// An opaque encrypted mailbox entry. Neither this type nor anything that persists
/// or reads it may contain plaintext content, human-readable names, coordinates, or
/// key material. Only the fields below may exist in the relay's schema.
/// </summary>
public class Envelope
{
    /// <summary>Server-assigned monotonic id, used as the cursor for reads/acks.</summary>
    public long SequenceId { get; set; }

    public required string MailboxId { get; set; }

    /// <summary>Client-chosen id; upload is idempotent on (MailboxId, EventId).</summary>
    public required string EventId { get; set; }

    /// <summary>Protocol metadata only, used for stale-event and TTL policy. Never
    /// inspected for content.</summary>
    public long Epoch { get; set; }

    /// <summary>
    /// App-defined, relay-opaque routing tag (e.g. "application", "keypackage",
    /// "welcome", "commit"; see mobile/src/relay.ts). Stored and returned as-is.
    /// Only "commit" and "leave" affect retention, never interpretation.
    /// </summary>
    public required string Kind { get; set; }

    public required byte[] Nonce { get; set; }

    public required byte[] Ciphertext { get; set; }

    // DateTime (UTC), not DateTimeOffset: the SQLite provider cannot translate
    // `<`/`>` comparisons on DateTimeOffset columns, which silently breaks TTL
    // sweeps. Nothing here converts, so every value written must already be UTC.
    public DateTime CreatedAt { get; set; }

    public DateTime? ExpiresAt { get; set; }
}

/// <summary>Durable per-mailbox read acknowledgement cursor.</summary>
public class MailboxCursor
{
    public required string MailboxId { get; set; }
    public long AckedSequenceId { get; set; }
}

/// <summary>An opaque, randomly-generated device mailbox registration.</summary>
public class Mailbox
{
    public required string MailboxId { get; set; }
    public DateTime CreatedAt { get; set; }
}
