using System.Net.Http.Json;
using FamilyCircle.Relay.Contracts;

namespace FamilyCircle.Relay.Tests;

internal static class TestHttpClientExtensions
{
    /// <summary>
    /// Registers a real mailbox through the public API. Tests that need a
    /// mailbox should not have to repeat the response plumbing or quietly skip
    /// the status-code check.
    /// </summary>
    internal static async Task<string> RegisterMailboxAsync(this HttpClient client)
    {
        var response = await client.PostAsync("/v1/devices", content: null);
        response.EnsureSuccessStatusCode();
        var registration = await response.Content.ReadFromJsonAsync<RegisterMailboxResponse>();
        return registration!.MailboxId;
    }
}
