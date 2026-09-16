namespace FamilyCircle.Relay.Services;

/// <summary>
/// Sweeps <see cref="BackupChallengeStore"/> for issued-but-never-consumed
/// challenges past their TTL. Separate from <see cref="TtlCleanupService"/> because
/// the two sweep different stores with no shared dependency.
/// </summary>
public class BackupChallengeCleanupService(BackupChallengeStore store, ILogger<BackupChallengeCleanupService> logger)
    : BackgroundService
{
    private static readonly TimeSpan Interval = TimeSpan.FromMinutes(1);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        using var timer = new PeriodicTimer(Interval);
        while (!stoppingToken.IsCancellationRequested &&
               await timer.WaitForNextTickAsync(stoppingToken))
        {
            try
            {
                var removed = store.SweepExpired();
                if (removed > 0)
                {
                    // Count only. Never log a backupId or nonce here.
                    logger.LogInformation(
                        "Backup challenge cleanup removed {Count} expired/abandoned challenge(s)", removed);
                }
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                logger.LogError(ex, "Backup challenge cleanup pass failed");
            }
        }
    }
}
