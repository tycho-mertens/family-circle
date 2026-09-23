namespace FamilyCircle.Relay.Locations;

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
