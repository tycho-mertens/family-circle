using FamilyCircle.Relay.Data;
using FamilyCircle.Relay.Models;
using Microsoft.EntityFrameworkCore;

namespace FamilyCircle.Relay.Repositories;

public class SqliteMailboxRepository(RelayDbContext db) : IMailboxRepository
{
    // Serializes the cap check against the insert below. Static because every Scoped
    // instance in this process shares one SQLite file, so a per-instance lock would
    // serialize nothing. Registration is not a hot path.
    private static readonly SemaphoreSlim RegistrationLock = new(1, 1);
    // Await SQLite's single-writer turn without tying up request threads in
    // the driver's synchronous busy wait during a simultaneous send burst.
    private static readonly SemaphoreSlim AppendLock = new(1, 1);

    public async Task<string> RegisterMailboxAsync(CancellationToken ct)
    {
        var mailboxId = Guid.NewGuid().ToString("N");
        db.Mailboxes.Add(new Mailbox { MailboxId = mailboxId, CreatedAt = DateTime.UtcNow });
        await db.SaveChangesAsync(ct);
        return mailboxId;
    }

    public Task<bool> MailboxExistsAsync(string mailboxId, CancellationToken ct) =>
        db.Mailboxes.AnyAsync(m => m.MailboxId == mailboxId, ct);

    public async Task<string?> TryRegisterMailboxIfUnderCapAsync(long maxMailboxes, CancellationToken ct)
    {
        await RegistrationLock.WaitAsync(ct);
        try
        {
            if (await db.Mailboxes.LongCountAsync(ct) >= maxMailboxes)
            {
                return null;
            }

            return await RegisterMailboxAsync(ct);
        }
        finally
        {
            RegistrationLock.Release();
        }
    }

    public async Task<bool> TryAddEventAsync(Envelope envelope, CancellationToken ct, long? expectedSequenceId = null, bool membershipOnly = false)
    {
        await AppendLock.WaitAsync(ct);
        try
        {
            // SQLite's write transaction serializes the cursor check and append,
            // including requests in other processes. Check idempotency FIRST: an
            // accepted upload with a lost response must never become a conflict.
            await using var transaction = await db.Database.BeginTransactionAsync(ct);
            var existing = await db.Envelopes.FirstOrDefaultAsync(
                e => e.MailboxId == envelope.MailboxId && e.EventId == envelope.EventId, ct);
            if (existing is not null)
            {
                envelope.SequenceId = existing.SequenceId;
                envelope.Epoch = existing.Epoch;
                envelope.Kind = existing.Kind;
                envelope.Nonce = existing.Nonce;
                envelope.Ciphertext = existing.Ciphertext;
                envelope.CreatedAt = existing.CreatedAt;
                return false;
            }
            if (expectedSequenceId is not null)
            {
                var latest = membershipOnly
                    ? await db.Database.SqlQueryRaw<long>("SELECT SequenceId AS Value FROM MembershipHeads WHERE MailboxId = {0}", envelope.MailboxId).SingleOrDefaultAsync(ct)
                    : await db.Envelopes.Where(e => e.MailboxId == envelope.MailboxId).MaxAsync(e => (long?)e.SequenceId, ct) ?? 0;
                if (latest > expectedSequenceId)
                {
                    throw new MailboxChangedException();
                }
            }

            db.Envelopes.Add(envelope);
            await db.SaveChangesAsync(ct);
            if (envelope.Kind == "commit")
            {
                await db.Database.ExecuteSqlInterpolatedAsync($"""
                    INSERT INTO MembershipHeads(MailboxId, SequenceId)
                    VALUES({envelope.MailboxId}, {envelope.SequenceId})
                    ON CONFLICT(MailboxId) DO UPDATE SET SequenceId=excluded.SequenceId
                    """, ct);
            }

            await transaction.CommitAsync(ct);
            return true;
        }
        finally
        {
            AppendLock.Release();
        }
    }

    public async Task<IReadOnlyList<Envelope>> GetEventsAfterAsync(
        string mailboxId, long afterSequenceId, int limit, CancellationToken ct) =>
        await db.Envelopes
            .Where(e => e.MailboxId == mailboxId && e.SequenceId > afterSequenceId)
            .OrderBy(e => e.SequenceId)
            .Take(limit)
            .ToListAsync(ct);

    public async Task AckAsync(string mailboxId, long sequenceId, CancellationToken ct)
    {
        var cursor = await db.MailboxCursors.FindAsync([mailboxId], ct);
        if (cursor is null)
        {
            db.MailboxCursors.Add(new MailboxCursor { MailboxId = mailboxId, AckedSequenceId = sequenceId });
        }
        else if (sequenceId > cursor.AckedSequenceId)
        {
            cursor.AckedSequenceId = sequenceId;
        }

        await db.SaveChangesAsync(ct);
    }

    public async Task<int> DeleteExpiredAsync(DateTime now, CancellationToken ct)
    {
        // `now` and Envelope.ExpiresAt must both be DateTime (UTC), not
        // DateTimeOffset; see Models/Envelope.cs.
        var expired = await db.Envelopes
            .Where(e => e.ExpiresAt != null && e.ExpiresAt < now)
            .ToListAsync(ct);
        if (expired.Count == 0)
        {
            return 0;
        }

        db.Envelopes.RemoveRange(expired);
        await db.SaveChangesAsync(ct);
        return expired.Count;
    }
}
