using FamilyCircle.Relay.Data;
using FamilyCircle.Relay.Models;
using Microsoft.EntityFrameworkCore;

namespace FamilyCircle.Relay.Repositories;

public class SqliteBackupRepository(RelayDbContext db) : IBackupRepository
{
    // Serializes the check-then-insert below. Static because every Scoped instance
    // in this process shares one SQLite file, so a per-instance lock would serialize
    // nothing.
    private static readonly SemaphoreSlim RegistrationLock = new(1, 1);

    public Task<Backup?> FindAsync(string backupId, CancellationToken ct) =>
        db.Backups.FirstOrDefaultAsync(b => b.BackupId == backupId, ct);

    public async Task<BackupRegistrationOutcome> TryRegisterIfUnderCapAsync(
        Backup backup, long maxBackups, CancellationToken ct)
    {
        await RegistrationLock.WaitAsync(ct);
        try
        {
            if (await db.Backups.AnyAsync(b => b.BackupId == backup.BackupId, ct))
            {
                return BackupRegistrationOutcome.AlreadyExists;
            }

            if (await db.Backups.LongCountAsync(ct) >= maxBackups)
            {
                return BackupRegistrationOutcome.CapReached;
            }

            db.Backups.Add(backup);
            try
            {
                await db.SaveChangesAsync(ct);
                return BackupRegistrationOutcome.Registered;
            }
            catch (DbUpdateException)
            {
                // Unreachable while registration is serialized here, but the unique
                // key is the real guarantee; treat a lost race as already-registered.
                return BackupRegistrationOutcome.AlreadyExists;
            }
        }
        finally
        {
            RegistrationLock.Release();
        }
    }

    public async Task UpdateCiphertextAsync(string backupId, byte[] ciphertext, CancellationToken ct)
    {
        var backup = await db.Backups.FindAsync([backupId], ct);
        if (backup is null)
        {
            return;
        }

        backup.Ciphertext = ciphertext;
        backup.UpdatedAt = DateTime.UtcNow;
        await db.SaveChangesAsync(ct);
    }
}
