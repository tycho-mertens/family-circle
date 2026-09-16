using FamilyCircle.Relay.Models;

namespace FamilyCircle.Relay.Repositories;

/// <summary>Outcome of <see cref="IBackupRepository.TryRegisterIfUnderCapAsync"/>.</summary>
public enum BackupRegistrationOutcome
{
    Registered,
    /// <summary>This BackupId is already registered; Program.cs maps this to 409.</summary>
    AlreadyExists,
    /// <summary>The registration cap has been reached; mapped to 503.</summary>
    CapReached,
}

/// <summary>Persistence boundary for encrypted device backups.</summary>
public interface IBackupRepository
{
    Task<Backup?> FindAsync(string backupId, CancellationToken ct);

    /// <summary>
    /// Registers a backup if it is not already present and doing so stays within
    /// <paramref name="maxBackups"/>. Both checks and the insert are one atomic
    /// operation: a separate count-then-register would let concurrent requests all
    /// observe a count under the cap and overshoot it.
    /// </summary>
    Task<BackupRegistrationOutcome> TryRegisterIfUnderCapAsync(Backup backup, long maxBackups, CancellationToken ct);

    /// <summary>
    /// Overwrites an existing backup's ciphertext, never its verifier. A new seed
    /// phrase is a new BackupId, not an update to this one. No-op if
    /// <paramref name="backupId"/> doesn't exist. Callers must verify the
    /// challenge-response proof first; this repository does no auth of its own.
    /// </summary>
    Task UpdateCiphertextAsync(string backupId, byte[] ciphertext, CancellationToken ct);
}
