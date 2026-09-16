using System.Net;
using System.Net.Http.Json;
using FamilyCircle.Relay.Contracts;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;
using Xunit;

namespace FamilyCircle.Relay.Tests;

/// <summary>
/// Covers the registration caps on <c>POST /v1/devices</c> and
/// <c>POST /v1/backups/{id}</c>. Mailboxes and backups never expire on their own,
/// so without a cap they grow without bound.
///
/// Builds its own factory instead of sharing <see cref="IClassFixture{T}"/>, so the
/// tiny cap configured here cannot affect test classes that rely on the real default.
/// </summary>
public class RegistrationCapsTests : IDisposable
{
    private readonly RelayApiFactory _baseFactory = new();
    private readonly WebApplicationFactory<Program> _factory;
    private readonly HttpClient _client;

    public RegistrationCapsTests()
    {
        _factory = _baseFactory.WithWebHostBuilder(builder =>
        {
            builder.ConfigureAppConfiguration((_, config) =>
            {
                config.AddInMemoryCollection(new Dictionary<string, string?>
                {
                    ["Limits:MaxMailboxes"] = "2",
                    ["Limits:MaxBackups"] = "2",
                });
            });
        });
        _client = _factory.CreateClient();
    }

    public void Dispose()
    {
        _client.Dispose();
        _factory.Dispose();
        _baseFactory.Dispose();
    }

    [Fact]
    public async Task Registering_mailboxes_past_the_configured_cap_is_rejected()
    {
        var first = await _client.PostAsync("/v1/devices", content: null);
        Assert.Equal(HttpStatusCode.Created, first.StatusCode);

        var second = await _client.PostAsync("/v1/devices", content: null);
        Assert.Equal(HttpStatusCode.Created, second.StatusCode);

        // Cap is 2, so the third registration must be rejected, not silently
        // accepted past the configured limit.
        var third = await _client.PostAsync("/v1/devices", content: null);
        Assert.Equal(HttpStatusCode.ServiceUnavailable, third.StatusCode);
    }

    [Fact]
    public async Task Registering_backups_past_the_configured_cap_is_rejected()
    {
        var authVerifier = Enumerable.Repeat((byte)1, 32).ToArray();
        var request = new RegisterBackupRequest(authVerifier, [1, 2, 3]);

        var first = await _client.PostAsJsonAsync($"/v1/backups/backup-{Guid.NewGuid():N}", request);
        Assert.Equal(HttpStatusCode.Created, first.StatusCode);

        var second = await _client.PostAsJsonAsync($"/v1/backups/backup-{Guid.NewGuid():N}", request);
        Assert.Equal(HttpStatusCode.Created, second.StatusCode);

        // Cap is 2, so a third distinct backupId must be rejected outright
        // (not a 409 Conflict, which is what an already-registered id
        // would get; this is a different, capacity-driven rejection).
        var third = await _client.PostAsJsonAsync($"/v1/backups/backup-{Guid.NewGuid():N}", request);
        Assert.Equal(HttpStatusCode.ServiceUnavailable, third.StatusCode);
    }

    /// <summary>
    /// Concurrent registrations must fill the cap without exceeding it.
    /// A separate count-then-insert check would race under this load.
    /// </summary>
    [Fact]
    public async Task Concurrent_mailbox_registrations_never_exceed_the_cap()
    {
        var responses = await Task.WhenAll(
            Enumerable.Range(0, 20).Select(_ => _client.PostAsync("/v1/devices", content: null)));

        var created = responses.Count(r => r.StatusCode == HttpStatusCode.Created);
        var rejected = responses.Count(r => r.StatusCode == HttpStatusCode.ServiceUnavailable);
        Assert.Equal(2, created); // the configured Limits:MaxMailboxes
        Assert.Equal(18, rejected);
    }

    [Fact]
    public async Task Concurrent_backup_registrations_never_exceed_the_cap()
    {
        var authVerifier = Enumerable.Repeat((byte)1, 32).ToArray();
        var request = new RegisterBackupRequest(authVerifier, [1, 2, 3]);

        var responses = await Task.WhenAll(
            Enumerable.Range(0, 20)
                .Select(_ => _client.PostAsJsonAsync($"/v1/backups/backup-{Guid.NewGuid():N}", request)));

        var created = responses.Count(r => r.StatusCode == HttpStatusCode.Created);
        var rejected = responses.Count(r => r.StatusCode == HttpStatusCode.ServiceUnavailable);
        Assert.Equal(2, created); // the configured Limits:MaxBackups
        Assert.Equal(18, rejected);
    }
}
