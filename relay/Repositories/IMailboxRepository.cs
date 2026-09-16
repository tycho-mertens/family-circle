using FamilyCircle.Relay.Models;

namespace FamilyCircle.Relay.Repositories;

/// <summary>
/// Persistence boundary for the relay. Swapping SQLite for another store means
/// adding an implementation here, not changing endpoint code.
/// </summary>
public interface IMailboxRepository
{
    Task<string> RegisterMailboxAsync(CancellationToken ct);

    Task<bool> MailboxExistsAsync(string mailboxId, CancellationToken ct);

    /// <summary>
    /// Registers a mailbox if doing so stays within <paramref name="maxMailboxes"/>,
    /// or returns null if the cap is already reached. The check and the insert are
    /// one atomic operation: a separate count-then-register would let concurrent
    /// requests all observe a count under the cap and overshoot it.
    /// </summary>
    Task<string?> TryRegisterMailboxIfUnderCapAsync(long maxMailboxes, CancellationToken ct);

    /// <summary>
    /// Stores an envelope. Returns false without error if (MailboxId, EventId) was
    /// already stored, since upload is idempotent.
    /// </summary>
    Task<bool> TryAddEventAsync(Envelope envelope, CancellationToken ct, long? expectedSequenceId = null, bool membershipOnly = false);

    Task<IReadOnlyList<Envelope>> GetEventsAfterAsync(
        string mailboxId, long afterSequenceId, int limit, CancellationToken ct);

    Task AckAsync(string mailboxId, long sequenceId, CancellationToken ct);

    /// <summary>Deletes envelopes past their TTL and returns the count removed.
    /// <paramref name="now"/> must be UTC; see Models/Envelope.cs.</summary>
    Task<int> DeleteExpiredAsync(DateTime now, CancellationToken ct);
}

public sealed class MailboxChangedException : Exception;
