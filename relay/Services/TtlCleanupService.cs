using FamilyCircle.Relay.Repositories;

namespace FamilyCircle.Relay.Services;

/// <summary>Periodically deletes expired development envelopes past their TTL.</summary>
public class TtlCleanupService(IServiceScopeFactory scopeFactory, ILogger<TtlCleanupService> logger)
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
                using var scope = scopeFactory.CreateScope();
                var repo = scope.ServiceProvider.GetRequiredService<IMailboxRepository>();
                var removed = await repo.DeleteExpiredAsync(DateTime.UtcNow, stoppingToken);
                if (removed > 0)
                {
                    // Count only. Never log envelope content or ids here.
                    logger.LogInformation("TTL cleanup removed {Count} expired envelope(s)", removed);
                }
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                logger.LogError(ex, "TTL cleanup pass failed");
            }
        }
    }
}
