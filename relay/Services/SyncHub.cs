using System.Collections.Concurrent;
using Microsoft.AspNetCore.SignalR;

namespace FamilyCircle.Relay.Services;

/// <summary>
/// Change notifications for mailbox subscribers. Mailbox IDs keep the same
/// capability semantics they have over HTTP: a subscription grants no MLS
/// membership and never carries plaintext or key material.
/// </summary>
public sealed class SyncHub(SyncHubLimits limits) : Hub
{
    private static int connections;
    private static readonly ConcurrentDictionary<string, int> PerClient = new();

    public override async Task OnConnectedAsync()
    {
        if (Interlocked.Increment(ref connections) > limits.MaxConnections)
        {
            Interlocked.Decrement(ref connections);
            Context.Abort();
            throw new HubException("Connection capacity reached");
        }

        var http = Context.GetHttpContext()!;
        var key = http.Items["installation"] is string installation
            ? "device:" + installation
            : "ip:" + http.Connection.RemoteIpAddress;
        var limit = key.StartsWith("device:") ? limits.MaxConnectionsPerInstallation : limits.MaxConnectionsPerIp;
        if (PerClient.AddOrUpdate(key, 1, (_, count) => count + 1) > limit)
        {
            PerClient.AddOrUpdate(key, 0, (_, count) => count - 1);
            Interlocked.Decrement(ref connections);
            Context.Abort();
            throw new HubException("Connection quota reached");
        }

        Context.Items["clientKey"] = key;
        Context.Items["counted"] = true;
        await base.OnConnectedAsync();
    }

    public override async Task OnDisconnectedAsync(Exception? exception)
    {
        if (Context.Items.ContainsKey("counted"))
        {
            Interlocked.Decrement(ref connections);
            var key = (string)Context.Items["clientKey"]!;
            var count = PerClient.AddOrUpdate(key, 0, (_, value) => value - 1);
            if (count == 0)
            {
                ((ICollection<KeyValuePair<string, int>>)PerClient).Remove(new(key, 0));
            }
        }

        await base.OnDisconnectedAsync(exception);
    }

    public async Task<bool> Subscribe(string[] mailboxes)
    {
        var now = Environment.TickCount64;
        if (Context.Items.TryGetValue("lastSubscription", out var last) && now - (long)last! < limits.SubscriptionMinIntervalMs)
        {
            Context.Abort();
            throw new HubException("Subscription rate exceeded");
        }

        Context.Items["lastSubscription"] = now;
        if (mailboxes is null || mailboxes.Length > limits.MaxSubscriptions ||
            mailboxes.Any(id => id is null || id.Length != 32 || !id.All(Uri.IsHexDigit)))
        {
            throw new HubException("Invalid subscriptions");
        }

        var previous = Context.Items.TryGetValue("mailboxes", out var old) ? (string[])old! : [];
        foreach (var id in previous.Except(mailboxes))
        {
            await Groups.RemoveFromGroupAsync(Context.ConnectionId, id);
        }

        foreach (var id in mailboxes.Except(previous))
        {
            await Groups.AddToGroupAsync(Context.ConnectionId, id);
        }

        Context.Items["mailboxes"] = mailboxes.Distinct().ToArray();
        return true; // Invocation completion acknowledges installed subscriptions.
    }
}
