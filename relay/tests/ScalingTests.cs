using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using FamilyCircle.Relay.Contracts;
using FamilyCircle.Relay.Data;
using FamilyCircle.Relay.Services;
using Microsoft.AspNetCore.Hosting;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Xunit;

namespace FamilyCircle.Relay.Tests;

public sealed class ScalingTests
{
    [Fact]
    public async Task Membership_head_survives_event_cleanup_and_context_restart()
    {
        using var factory = new RelayApiFactory();
        using var client = factory.CreateClient();

        var registered = await client.PostAsync("/v1/devices", null);
        var id = (await registered.Content.ReadFromJsonAsync<RegisterMailboxResponse>())!.MailboxId;
        var path = $"/v1/mailboxes/{id}/events";
        await client.PostAsJsonAsync(path, new UploadEnvelopeRequest("commit", 0, "commit", [1], [2], null));

        // Drop the envelopes the way TTL cleanup eventually would. The membership
        // head lives in its own table and must outlive them.
        using (var scope = factory.Services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<RelayDbContext>();
            await db.Envelopes.Where(e => e.MailboxId == id).ExecuteDeleteAsync();
        }

        var stale = await client.PostAsJsonAsync(
            path, new UploadEnvelopeRequest("late", 1, "application", [1], [2], null, 0, "membership-v1"));
        Assert.Equal(HttpStatusCode.Conflict, stale.StatusCode);
    }

    private sealed class ProtectedFactory : RelayApiFactory
    {
        protected override void ConfigureWebHost(IWebHostBuilder builder)
        {
            base.ConfigureWebHost(builder);
            builder.ConfigureAppConfiguration((_, config) =>
                config.AddInMemoryCollection(new Dictionary<string, string?>
                {
                    ["Access:RequireInstallation"] = "true",
                    ["Access:EnrollmentCode"] = "test-code",
                    ["Limits:RequestsPerInstallationMinute"] = "3",
                }));
        }
    }

    [Fact]
    public async Task Enrollment_is_required_and_device_quotas_do_not_merge()
    {
        using var factory = new ProtectedFactory();
        using var client = factory.CreateClient();

        Assert.Equal(HttpStatusCode.Unauthorized, (await client.PostAsync("/v1/devices", null)).StatusCode);
        Assert.Equal(
            HttpStatusCode.Unauthorized,
            (await client.PostAsJsonAsync("/v1/installations", new EnrollmentRequest("bad"))).StatusCode);

        var tokens = new List<string>();
        for (var i = 0; i < 2; i++)
        {
            var response = await client.PostAsJsonAsync("/v1/installations", new EnrollmentRequest("test-code"));
            var body = await response.Content.ReadFromJsonAsync<JsonElement>();
            tokens.Add(body.GetProperty("token").GetString()!);
        }

        // The per-installation window is 3, so the fourth call on one token throttles.
        client.DefaultRequestHeaders.Add("X-Installation-Token", tokens[0]);
        for (var i = 0; i < 3; i++)
        {
            Assert.Equal(HttpStatusCode.OK, (await client.GetAsync("/v1/locations/generation")).StatusCode);
        }

        var throttled = await client.GetAsync("/v1/locations/generation");
        Assert.Equal(HttpStatusCode.TooManyRequests, throttled.StatusCode);
        Assert.NotNull(throttled.Headers.RetryAfter);

        // A second installation has its own budget: quotas must not pool across
        // devices that happen to share an IP.
        client.DefaultRequestHeaders.Remove("X-Installation-Token");
        client.DefaultRequestHeaders.Add("X-Installation-Token", tokens[1]);
        Assert.Equal(HttpStatusCode.OK, (await client.GetAsync("/v1/locations/generation")).StatusCode);
    }
}
