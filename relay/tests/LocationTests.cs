using System.Net;
using System.Net.Http.Json;
using System.Security.Cryptography;
using System.Text.Json;
using FamilyCircle.Relay.Contracts;
using FamilyCircle.Relay.Locations;
using Org.BouncyCastle.Crypto.Parameters;
using Org.BouncyCastle.Crypto.Signers;
using Xunit;

namespace FamilyCircle.Relay.Tests;

public class LocationTests : IClassFixture<RelayApiFactory>
{
    private readonly HttpClient client;

    public LocationTests(RelayApiFactory factory)
    {
        client = factory.CreateClient();
    }

    private static LocationSnapshot Sign(Ed25519PrivateKeyParameters key, LocationSnapshot snapshot)
    {
        var signer = new Ed25519Signer();
        signer.Init(true, key);
        var bytes = snapshot.SigningBytes();
        signer.BlockUpdate(bytes, 0, bytes.Length);
        return snapshot with { Signature = Convert.ToHexStringLower(signer.GenerateSignature()) };
    }

    /// <summary>
    /// Builds a signed, server-accepted starting snapshot: a fresh mailbox, a fresh
    /// Ed25519 key, and a SessionId that is the hash of its public key.
    /// </summary>
    private async Task<(Ed25519PrivateKeyParameters Key, LocationSnapshot Snapshot)> Session()
    {
        var generation = await client.GetFromJsonAsync<JsonElement>("/v1/locations/generation");
        var mailbox = await client.RegisterMailboxAsync();

        var key = new Ed25519PrivateKeyParameters(RandomNumberGenerator.GetBytes(32), 0);
        var publicKey = key.GeneratePublicKey().GetEncoded();
        var wire = new LocationSnapshot(
            generation.GetProperty("generation").GetString()!,
            Convert.ToHexStringLower(SHA256.HashData(publicKey)),
            mailbox,
            Convert.ToHexStringLower(publicKey),
            1,
            0,
            1,
            false,
            new string('2', 24),
            new string('3', 64),
            "");
        return (key, Sign(key, wire));
    }

    [Fact]
    public async Task Rejects_a_valid_snapshot_claiming_an_unknown_mailbox()
    {
        var (key, snapshot) = await Session();
        var unknown = Sign(key, snapshot with { MailboxId = new string('f', 32) });
        Assert.Equal(
            HttpStatusCode.NotFound,
            (await client.PutAsJsonAsync($"/v1/locations/{unknown.SessionId}", unknown)).StatusCode);
    }

    [Fact]
    public async Task Replaces_ciphertext_rejects_forgery_and_stops_permanently()
    {
        var (key, first) = await Session();
        var path = $"/v1/locations/{first.SessionId}";
        Assert.Equal(HttpStatusCode.OK, (await client.PutAsJsonAsync(path, first)).StatusCode);

        var second = Sign(key, first with { Revision = 2, Ciphertext = new string('4', 64) });
        Assert.Equal(HttpStatusCode.OK, (await client.PutAsJsonAsync(path, second)).StatusCode);
        Assert.Equal(second, await client.GetFromJsonAsync<LocationSnapshot>(path));

        // Replaying an older revision conflicts; reusing a revision number with
        // different content is rejected before it can overwrite anything.
        Assert.Equal(HttpStatusCode.Conflict, (await client.PutAsJsonAsync(path, first)).StatusCode);
        Assert.Equal(
            HttpStatusCode.BadRequest,
            (await client.PutAsJsonAsync(path, second with { Revision = 3 })).StatusCode);

        var stop = Sign(key, second with { Revision = 3, Stopped = true, Nonce = "", Ciphertext = "" });
        Assert.Equal(HttpStatusCode.OK, (await client.PutAsJsonAsync(path, stop)).StatusCode);
        Assert.Equal(HttpStatusCode.Gone, (await client.GetAsync(path)).StatusCode);

        // Terminal is permanent, even for a correctly signed later revision, but a
        // repeated stop stays idempotent.
        Assert.Equal(
            HttpStatusCode.Gone,
            (await client.PutAsJsonAsync(path, Sign(key, second with { Revision = 999 }))).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await client.PutAsJsonAsync(path, stop)).StatusCode);
    }

    [Fact]
    public async Task Offline_stop_before_first_upload_prevents_resurrection()
    {
        var (key, first) = await Session();
        var path = $"/v1/locations/{first.SessionId}";
        var stop = Sign(key, first with { Revision = 2, Stopped = true, Nonce = "", Ciphertext = "" });
        await client.PutAsJsonAsync(path, stop);
        Assert.Equal(HttpStatusCode.Gone, (await client.PutAsJsonAsync(path, first)).StatusCode);
    }

    [Fact]
    public async Task Expiry_and_old_server_generation_fail_closed()
    {
        var (key, first) = await Session();
        var path = $"/v1/locations/{first.SessionId}";
        Assert.Equal(
            HttpStatusCode.Conflict,
            (await client.PutAsJsonAsync(path, Sign(key, first with { Generation = new string('0', 32) }))).StatusCode);

        // Accepted on write, but already past its expiry, so it reads as terminal.
        Assert.Equal(
            HttpStatusCode.OK,
            (await client.PutAsJsonAsync(path, Sign(key, first with { ExpiresAt = 1 }))).StatusCode);
        Assert.Equal(HttpStatusCode.Gone, (await client.GetAsync(path)).StatusCode);
    }

    [Fact]
    public async Task Batch_distinguishes_changed_unchanged_missing_terminal_and_generation()
    {
        var (key, first) = await Session();
        await client.PutAsJsonAsync($"/v1/locations/{first.SessionId}", first);

        var request = new LocationBatchRequest(first.Generation, [
            new(first.SessionId, null),
            new(first.SessionId, first.Revision),
            new(new string('0', 64), null),
        ]);
        var response = await client.PostAsJsonAsync("/v1/locations/batch", request);
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);

        var results = (await response.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("results");
        Assert.Equal("changed", results[0].GetProperty("status").GetString());
        Assert.Equal("unchanged", results[1].GetProperty("status").GetString());
        Assert.Equal("missing", results[2].GetProperty("status").GetString());

        await client.PutAsJsonAsync(
            $"/v1/locations/{first.SessionId}",
            Sign(key, first with { Revision = 2, Stopped = true, Nonce = "", Ciphertext = "" }));
        var stopped = await client.PostAsJsonAsync("/v1/locations/batch", request);
        Assert.Equal(
            "terminal",
            (await stopped.Content.ReadFromJsonAsync<JsonElement>()).GetProperty("results")[0]
                .GetProperty("status").GetString());

        Assert.Equal(
            HttpStatusCode.Conflict,
            (await client.PostAsJsonAsync(
                "/v1/locations/batch", request with { Generation = new string('0', 32) })).StatusCode);
        Assert.Equal(
            HttpStatusCode.BadRequest,
            (await client.PostAsJsonAsync(
                "/v1/locations/batch",
                request with { Sessions = Enumerable.Repeat(new LocationRead(first.SessionId, null), 101).ToArray() }))
                .StatusCode);
    }

    [Fact]
    public async Task Racing_stop_and_update_always_ends_deleted()
    {
        var (key, first) = await Session();
        var path = $"/v1/locations/{first.SessionId}";
        await client.PutAsJsonAsync(path, first);

        var update = Sign(key, first with { Revision = 2 });
        var stop = Sign(key, first with { Revision = 3, Stopped = true, Nonce = "", Ciphertext = "" });
        await Task.WhenAll(client.PutAsJsonAsync(path, update), client.PutAsJsonAsync(path, stop));

        Assert.Equal(HttpStatusCode.Gone, (await client.GetAsync(path)).StatusCode);
    }
}
