using System.Net;
using System.Net.Http.Json;
using System.Security.Cryptography;
using FamilyCircle.Relay.Contracts;
using Xunit;

namespace FamilyCircle.Relay.Tests;

/// <summary>
/// Tests the <c>/v1/backups</c> endpoints with encrypted payloads.
/// Proofs use the same HMAC-SHA256 calculation as the Rust client, implemented
/// here in C# so these tests can exercise the relay on its own.
/// </summary>
public class BackupEndpointsTests : IClassFixture<RelayApiFactory>
{
    private readonly HttpClient _client;

    public BackupEndpointsTests(RelayApiFactory factory)
    {
        _client = factory.CreateClient();
    }

    private static byte[] Proof(byte[] authVerifier, string nonceBase64)
    {
        using var hmac = new HMACSHA256(authVerifier);
        return hmac.ComputeHash(Convert.FromBase64String(nonceBase64));
    }

    private async Task<string> RequestChallengeAsync(string backupId)
    {
        var response = await _client.PostAsync($"/v1/backups/{backupId}/challenge", content: null);
        response.EnsureSuccessStatusCode();
        var body = await response.Content.ReadFromJsonAsync<BackupChallengeResponse>();
        return body!.Nonce;
    }

    [Fact]
    public async Task Registration_requires_the_fixed_size_auth_verifier()
    {
        var backupId = Convert.ToHexString(RandomNumberGenerator.GetBytes(32)).ToLowerInvariant();
        var path = $"/v1/backups/{backupId}";
        Assert.Equal(HttpStatusCode.BadRequest, (await _client.PostAsJsonAsync(path,
            new RegisterBackupRequest(new byte[31], [1]))).StatusCode);
        Assert.Equal(HttpStatusCode.BadRequest, (await _client.PostAsJsonAsync(path,
            new RegisterBackupRequest(new byte[33], [1]))).StatusCode);
        Assert.Equal(HttpStatusCode.Created, (await _client.PostAsJsonAsync(path,
            new RegisterBackupRequest(new byte[32], [1]))).StatusCode);
    }

    [Fact]
    public async Task Register_then_challenge_then_fetch_round_trips_the_ciphertext()
    {
        var backupId = $"backup-{Guid.NewGuid():N}";
        var authVerifier = Enumerable.Repeat((byte)9, 32).ToArray();
        var ciphertext = new byte[] { 0xDE, 0xAD, 0xBE, 0xEF, 0x00, 0x01 };

        var register = await _client.PostAsJsonAsync(
            $"/v1/backups/{backupId}", new RegisterBackupRequest(authVerifier, ciphertext));
        Assert.Equal(HttpStatusCode.Created, register.StatusCode);

        var nonce = await RequestChallengeAsync(backupId);
        var proof = Convert.ToBase64String(Proof(authVerifier, nonce));

        var fetch = await _client.GetAsync(
            $"/v1/backups/{backupId}?nonce={Uri.EscapeDataString(nonce)}&proof={Uri.EscapeDataString(proof)}");
        Assert.Equal(HttpStatusCode.OK, fetch.StatusCode);
        var fetched = await fetch.Content.ReadFromJsonAsync<BackupResponse>();
        Assert.Equal(ciphertext, fetched!.Ciphertext);
    }

    [Fact]
    public async Task Second_registration_of_the_same_backup_id_conflicts()
    {
        var backupId = $"backup-{Guid.NewGuid():N}";
        var request = new RegisterBackupRequest(new byte[32], [1]);

        var first = await _client.PostAsJsonAsync($"/v1/backups/{backupId}", request);
        Assert.Equal(HttpStatusCode.Created, first.StatusCode);

        // The first registration claims this BackupId. A later registration
        // must not overwrite it; updates need a valid proof through PUT.
        var second = await _client.PostAsJsonAsync($"/v1/backups/{backupId}", request);
        Assert.Equal(HttpStatusCode.Conflict, second.StatusCode);
    }

    [Fact]
    public async Task Update_requires_a_valid_proof_and_wrong_proof_is_rejected()
    {
        var backupId = $"backup-{Guid.NewGuid():N}";
        var authVerifier = Enumerable.Repeat((byte)7, 32).ToArray();
        var wrongVerifier = Enumerable.Repeat((byte)8, 32).ToArray();
        await _client.PostAsJsonAsync(
            $"/v1/backups/{backupId}", new RegisterBackupRequest(authVerifier, [1, 2, 3]));

        // Wrong proof (as if computed with the wrong seed phrase's
        // auth_key) must be rejected, and the update must not have
        // applied.
        var badNonce = await RequestChallengeAsync(backupId);
        var badProof = Convert.ToBase64String(Proof(wrongVerifier, badNonce));
        var rejected = await _client.PutAsJsonAsync(
            $"/v1/backups/{backupId}", new UpdateBackupRequest(badNonce, Convert.FromBase64String(badProof), [9, 9, 9]));
        Assert.Equal(HttpStatusCode.Unauthorized, rejected.StatusCode);

        // The correct proof, against a fresh challenge, succeeds.
        var goodNonce = await RequestChallengeAsync(backupId);
        var goodProof = Proof(authVerifier, goodNonce);
        var accepted = await _client.PutAsJsonAsync(
            $"/v1/backups/{backupId}", new UpdateBackupRequest(goodNonce, goodProof, [9, 9, 9]));
        Assert.Equal(HttpStatusCode.OK, accepted.StatusCode);

        // A nonce can't be reused: replaying the exact same (nonce,
        // proof) pair a second time must fail even though it was valid
        // the first time.
        var replay = await _client.PutAsJsonAsync(
            $"/v1/backups/{backupId}", new UpdateBackupRequest(goodNonce, goodProof, [1, 1, 1]));
        Assert.Equal(HttpStatusCode.Unauthorized, replay.StatusCode);
    }

    [Fact]
    public async Task Unknown_backup_id_returns_not_found_everywhere()
    {
        Assert.Equal(HttpStatusCode.NotFound, (await _client.PostAsync("/v1/backups/does-not-exist/challenge", null)).StatusCode);
        Assert.Equal(HttpStatusCode.NotFound, (await _client.GetAsync("/v1/backups/does-not-exist?nonce=x&proof=x")).StatusCode);
    }

    [Fact]
    public void Response_schemas_have_no_seed_phrase_or_key_fields()
    {
        // Structural guard, same pattern as RelayEndpointsTests's. The
        // relay must never be able to hand back a seed phrase or
        // crypto-core's enc_key, only ciphertext/nonce.
        var backupProps = typeof(BackupResponse).GetProperties().Select(p => p.Name).ToHashSet();
        Assert.Equal(new HashSet<string> { "Ciphertext", "UpdatedAt" }, backupProps);
    }
}
