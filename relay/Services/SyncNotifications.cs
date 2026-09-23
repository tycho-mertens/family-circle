using System.Collections.Concurrent;
using System.Diagnostics.Metrics;
using Microsoft.AspNetCore.SignalR;

namespace FamilyCircle.Relay.Services;

/// <summary>
/// Bounded change hints, not a second message queue. Reconciliation repairs
/// overflow and crashes between durable commit and publication, so an upload must
/// never block on a slow socket or a failed push.
/// </summary>
public sealed class SyncNotifications(IHubContext<SyncHub> hub) : BackgroundService
{
    private readonly ConcurrentDictionary<string, byte> dirty = new();
    private static readonly Meter Meter = new("FamilyCircle.Sync");
    private static readonly Counter<long> Hints = Meter.CreateCounter<long>("sync.hints");

    public void Changed(string mailboxId)
    {
        if (dirty.Count < 10000)
        {
            dirty.TryAdd(mailboxId, 0);
        }
    }

    protected override async Task ExecuteAsync(CancellationToken token)
    {
        using var timer = new PeriodicTimer(TimeSpan.FromMilliseconds(250));
        try
        {
            while (await timer.WaitForNextTickAsync(token))
            {
                foreach (var mailbox in dirty.Keys)
                {
                    if (!dirty.TryRemove(mailbox, out _))
                    {
                        continue;
                    }

                    using var deadline = CancellationTokenSource.CreateLinkedTokenSource(token);
                    deadline.CancelAfter(TimeSpan.FromSeconds(2));
                    try
                    {
                        await hub.Clients.Group(mailbox).SendAsync("Changed", mailbox, deadline.Token);
                        Hints.Add(1);
                    }
                    catch (OperationCanceledException)
                    {
                    }
                }
            }
        }
        catch (OperationCanceledException) when (token.IsCancellationRequested)
        {
        }
    }
}
