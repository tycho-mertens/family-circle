using System.Security.Claims;
using FamilyCircle.Relay.Services;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Http.Connections.Features;
using Microsoft.AspNetCore.Http.Features;
using Microsoft.AspNetCore.SignalR;
using Microsoft.Extensions.Configuration;

namespace FamilyCircle.Relay.Tests;

/// <summary>Tests hub validation and quotas without relying on TestServer's
/// unsupported persistent long-polling transport.</summary>
public sealed class SyncHubTests
{
    private sealed class HttpFeature(HttpContext context) : IHttpContextFeature
    {
        public HttpContext? HttpContext { get; set; } = context;
    }

    private sealed class Context(string connectionId, string ip = "127.0.0.1") : HubCallerContext
    {
        private readonly IDictionary<object, object?> items = new Dictionary<object, object?>();
        public bool Aborted { get; private set; }
        public override string ConnectionId => connectionId;
        public override string? UserIdentifier => null;
        public override ClaimsPrincipal? User => null;
        public override IDictionary<object, object?> Items => items;
        public override IFeatureCollection Features { get; } = BuildFeatures(ip);
        public override CancellationToken ConnectionAborted => CancellationToken.None;
        public override void Abort() => Aborted = true;

        private static IFeatureCollection BuildFeatures(string ip)
        {
            var http = new DefaultHttpContext();
            http.Connection.RemoteIpAddress = System.Net.IPAddress.Parse(ip);
            var features = new FeatureCollection();
            features.Set<IHttpContextFeature>(new HttpFeature(http));
            return features;
        }
    }

    private sealed class Groups : IGroupManager
    {
        public readonly List<(string Connection, string Mailbox)> Added = [];
        public Task AddToGroupAsync(string connectionId, string groupName, CancellationToken cancellationToken = default)
        {
            Added.Add((connectionId, groupName));
            return Task.CompletedTask;
        }
        public Task RemoveFromGroupAsync(string connectionId, string groupName, CancellationToken cancellationToken = default) => Task.CompletedTask;
    }

    private static readonly SyncHubLimits Limits = new(new ConfigurationBuilder().AddInMemoryCollection().Build());

    private static (SyncHub Hub, Context Context, Groups Groups) Create(string id)
    {
        var context = new Context(id);
        var groups = new Groups();
        return (new SyncHub(Limits) { Context = context, Groups = groups }, context, groups);
    }

    [Fact]
    public async Task Subscription_accepts_valid_mailboxes_and_rejects_invalid_ones()
    {
        var (hub, _, groups) = Create("subscription");
        Assert.True(await hub.Subscribe([new string('a', 32)]));
        Assert.Equal([("subscription", new string('a', 32))], groups.Added);

        var (invalidHub, _, _) = Create("invalid");
        await Assert.ThrowsAsync<HubException>(() => invalidHub.Subscribe(["not-a-mailbox"]));
    }

    [Fact]
    public async Task Subscription_rejects_more_than_one_hundred_mailboxes()
    {
        var (hub, _, _) = Create("too-many");
        var mailboxes = Enumerable.Range(0, 101).Select(index => index.ToString("x32")).ToArray();
        await Assert.ThrowsAsync<HubException>(() => hub.Subscribe(mailboxes));
    }

    [Fact]
    public async Task Anonymous_connection_quota_aborts_the_two_hundred_and_first_connection()
    {
        var connected = new List<SyncHub>();
        try
        {
            for (var i = 0; i < 200; i++) {
                var (hub, _, _) = Create("quota-" + i);
                await hub.OnConnectedAsync();
                connected.Add(hub);
            }
            var (overflow, context, _) = Create("quota-overflow");
            await Assert.ThrowsAsync<HubException>(() => overflow.OnConnectedAsync());
            Assert.True(context.Aborted);
        }
        finally
        {
            foreach (var hub in connected) await hub.OnDisconnectedAsync(null);
        }
    }
}
