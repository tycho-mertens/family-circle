using System.Net;
using System.Net.Http.Json;
using FamilyCircle.Relay.Contracts;
using FamilyCircle.Relay.Data;
using Microsoft.AspNetCore.Hosting;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;

namespace FamilyCircle.Relay.Tests;

public sealed class EnvelopeRetentionTests
{
    [Theory]
    [InlineData("commit", null, null, 30 * 86400)]
    [InlineData("leave", 1, 45, 45 * 86400)]
    [InlineData("commit", 1, 1, 7 * 86400)]
    [InlineData("leave", 1, 400, 365 * 86400)]
    [InlineData("commit", 30 * 86400, 7, 30 * 86400)]
    [InlineData("application", null, 45, 7 * 86400)]
    [InlineData("application", 60, 45, 60)]
    public async Task Upload_preserves_default_ttl_and_membership_retention_bounds(
        string kind, int? ttlSeconds, int? membershipDays, int expectedSeconds)
    {
        using var baseFactory = new RelayApiFactory();
        using var factory = baseFactory.WithWebHostBuilder(builder =>
            builder.ConfigureAppConfiguration((_, config) =>
                config.AddInMemoryCollection(new Dictionary<string, string?>
                {
                    ["Retention:MembershipDays"] = membershipDays?.ToString(),
                })));
        using var client = factory.CreateClient();
        var mailboxId = await client.RegisterMailboxAsync();
        var response = await client.PostAsJsonAsync($"/v1/mailboxes/{mailboxId}/events",
            new UploadEnvelopeRequest("retention", 0, kind, [1], [2], ttlSeconds));
        Assert.Equal(HttpStatusCode.Created, response.StatusCode);

        using var scope = factory.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<RelayDbContext>();
        var envelope = await db.Envelopes.SingleAsync(e => e.MailboxId == mailboxId);
        Assert.Equal(envelope.CreatedAt.AddSeconds(expectedSeconds), envelope.ExpiresAt);
    }

    [Fact]
    public async Task Startup_extends_existing_membership_retention_without_changing_application_expiry()
    {
        using var baseFactory = new RelayApiFactory();
        string mailboxId;
        using (var client = baseFactory.CreateClient())
        {
            mailboxId = await client.RegisterMailboxAsync();
            foreach (var kind in new[] { "commit", "leave", "application" })
            {
                var response = await client.PostAsJsonAsync($"/v1/mailboxes/{mailboxId}/events",
                    new UploadEnvelopeRequest(kind, 0, kind, [1], [2], 60));
                Assert.Equal(HttpStatusCode.Created, response.StatusCode);
            }
        }

        using var restarted = baseFactory.WithWebHostBuilder(builder =>
            builder.ConfigureAppConfiguration((_, config) =>
                config.AddInMemoryCollection(new Dictionary<string, string?>
                {
                    ["Retention:MembershipDays"] = "45",
                })));
        using var restartedClient = restarted.CreateClient();
        using var scope = restarted.Services.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<RelayDbContext>();
        var envelopes = await db.Envelopes.Where(e => e.MailboxId == mailboxId).ToListAsync();
        Assert.Equal(3, envelopes.Count);
        foreach (var envelope in envelopes)
        {
            var expected = envelope.Kind == "application"
                ? envelope.CreatedAt.AddSeconds(60)
                : envelope.CreatedAt.AddDays(45);
            Assert.NotNull(envelope.ExpiresAt);
            // SQLite's datetime() migration stores whole seconds.
            Assert.InRange((expected - envelope.ExpiresAt.Value).TotalSeconds, 0, 1);
        }
    }
}
