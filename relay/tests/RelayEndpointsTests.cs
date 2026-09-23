using System.Net;
using System.Net.Http.Json;
using System.Text.Json;
using FamilyCircle.Relay.Contracts;
using Xunit;

namespace FamilyCircle.Relay.Tests;

/// <summary>
/// Relay contract tests: ciphertext round trips, idempotent uploads, cursor
/// reads, and response fields that exclude plaintext content.
/// </summary>
public class RelayEndpointsTests : IClassFixture<RelayApiFactory>
{
    private readonly HttpClient _client;

    public RelayEndpointsTests(RelayApiFactory factory)
    {
        _client = factory.CreateClient();
    }

    [Fact]
    public async Task Healthz_returns_ok()
    {
        var response = await _client.GetAsync("/healthz");
        Assert.Equal(HttpStatusCode.OK, response.StatusCode);
    }

    [Fact]
    public async Task Upload_then_fetch_returns_byte_for_byte_ciphertext()
    {
        var mailboxId = await _client.RegisterMailboxAsync();

        // Arbitrary binary payload, not valid UTF-8 or JSON, to confirm the
        // relay treats it as opaque bytes, never attempts to parse it as
        // content.
        var ciphertext = new byte[] { 0x00, 0xFF, 0x10, 0x7B, 0x22, 0x00, 0x8A, 0xDE, 0xAD, 0xBE, 0xEF };
        var nonce = new byte[] { 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12 };

        var upload = await _client.PostAsJsonAsync($"/v1/mailboxes/{mailboxId}/events",
            new UploadEnvelopeRequest("event-1", Epoch: 3, Kind: "application", nonce, ciphertext, TtlSeconds: null));
        Assert.Equal(HttpStatusCode.Created, upload.StatusCode);

        var fetch = await _client.GetFromJsonAsync<List<EnvelopeResponse>>(
            $"/v1/mailboxes/{mailboxId}/events");

        var fetched = Assert.Single(fetch!);
        Assert.Equal("event-1", fetched.EventId);
        Assert.Equal(3, fetched.Epoch);
        Assert.Equal("application", fetched.Kind);
        Assert.Equal(nonce, fetched.Nonce);
        Assert.Equal(ciphertext, fetched.Ciphertext);
    }

    [Fact]
    public async Task Duplicate_event_id_upload_is_idempotent()
    {
        var mailboxId = await _client.RegisterMailboxAsync();
        var request = new UploadEnvelopeRequest("dup-event", 1, "application", [9, 9], [1, 2, 3], null);

        var first = await _client.PostAsJsonAsync($"/v1/mailboxes/{mailboxId}/events", request);
        var second = await _client.PostAsJsonAsync($"/v1/mailboxes/{mailboxId}/events", request);

        Assert.Equal(HttpStatusCode.Created, first.StatusCode);
        Assert.Equal(HttpStatusCode.OK, second.StatusCode); // not Created again

        var fetch = await _client.GetFromJsonAsync<List<EnvelopeResponse>>(
            $"/v1/mailboxes/{mailboxId}/events");
        Assert.Single(fetch!); // still exactly one stored event
    }

    [Fact]
    public async Task Cursor_read_only_returns_events_after_the_given_sequence()
    {
        var mailboxId = await _client.RegisterMailboxAsync();
        await _client.PostAsJsonAsync($"/v1/mailboxes/{mailboxId}/events",
            new UploadEnvelopeRequest("e1", 1, "application", [1], [1], null));
        await _client.PostAsJsonAsync($"/v1/mailboxes/{mailboxId}/events",
            new UploadEnvelopeRequest("e2", 1, "application", [2], [2], null));

        var all = await _client.GetFromJsonAsync<List<EnvelopeResponse>>(
            $"/v1/mailboxes/{mailboxId}/events");
        Assert.Equal(2, all!.Count);

        var afterFirst = await _client.GetFromJsonAsync<List<EnvelopeResponse>>(
            $"/v1/mailboxes/{mailboxId}/events?after={all[0].SequenceId}");
        var onlyRemaining = Assert.Single(afterFirst!);
        Assert.Equal("e2", onlyRemaining.EventId);
    }

    [Fact]
    public async Task Ack_is_durable_and_does_not_delete_events()
    {
        var mailboxId = await _client.RegisterMailboxAsync();
        var upload = await _client.PostAsJsonAsync($"/v1/mailboxes/{mailboxId}/events",
            new UploadEnvelopeRequest("e1", 1, "application", [1], [1], null));
        var uploaded = await upload.Content.ReadFromJsonAsync<EnvelopeResponse>();

        var ack = await _client.PostAsJsonAsync($"/v1/mailboxes/{mailboxId}/ack",
            new AckRequest(uploaded!.SequenceId));
        Assert.Equal(HttpStatusCode.NoContent, ack.StatusCode);

        // Acking is a client-side cursor bookmark, not deletion. The
        // event must still be fetchable from the start.
        var fetch = await _client.GetFromJsonAsync<List<EnvelopeResponse>>(
            $"/v1/mailboxes/{mailboxId}/events");
        Assert.Single(fetch!);
    }

    [Fact]
    public async Task Kind_is_required_and_round_trips_for_pairing_control_traffic()
    {
        // "kind" exists specifically to let devices distinguish ordinary
        // application ciphertext from pairing control traffic
        // (keypackage/welcome/commit; see mobile/src/relay.ts) sharing
        // the same mailbox. The relay must never branch on its value, but
        // it must store and return it faithfully.
        var mailboxId = await _client.RegisterMailboxAsync();

        var missingKind = await _client.PostAsJsonAsync($"/v1/mailboxes/{mailboxId}/events",
            new { eventId = "e1", epoch = 0, nonce = new byte[] { 1 }, ciphertext = new byte[] { 1 } });
        Assert.Equal(HttpStatusCode.BadRequest, missingKind.StatusCode);

        var upload = await _client.PostAsJsonAsync($"/v1/mailboxes/{mailboxId}/events",
            new UploadEnvelopeRequest("welcome-1", 0, "welcome", [1], [2, 3, 4], null));
        Assert.Equal(HttpStatusCode.Created, upload.StatusCode);

        var fetch = await _client.GetFromJsonAsync<List<EnvelopeResponse>>(
            $"/v1/mailboxes/{mailboxId}/events");
        Assert.Equal("welcome", Assert.Single(fetch!).Kind);
    }

    [Fact]
    public async Task Unknown_mailbox_returns_not_found()
    {
        var response = await _client.GetAsync("/v1/mailboxes/does-not-exist/events");
        Assert.Equal(HttpStatusCode.NotFound, response.StatusCode);
    }

    [Fact]
    public async Task Envelope_metadata_has_explicit_storage_bounds()
    {
        var mailboxId = await _client.RegisterMailboxAsync();
        var path = $"/v1/mailboxes/{mailboxId}/events";
        var valid = new UploadEnvelopeRequest(new string('e', 512), 1, "application", new byte[64], [1], null);
        Assert.Equal(HttpStatusCode.Created, (await _client.PostAsJsonAsync(path, valid)).StatusCode);

        var longEventId = await _client.PostAsJsonAsync(path, valid with { EventId = new string('e', 513) });
        Assert.Equal(HttpStatusCode.BadRequest, longEventId.StatusCode);

        var longNonce = await _client.PostAsJsonAsync(path, valid with { EventId = "other", Nonce = new byte[65] });
        Assert.Equal(HttpStatusCode.BadRequest, longNonce.StatusCode);
    }

    [Fact]
    public async Task Conditional_upload_rejects_a_message_prepared_before_a_new_commit()
    {
        var mailbox = await _client.RegisterMailboxAsync();
        var path = $"/v1/mailboxes/{mailbox}/events";
        var commit = await _client.PostAsJsonAsync(path, new UploadEnvelopeRequest("commit", 0, "commit", [1], [2], null));
        var stored = await commit.Content.ReadFromJsonAsync<EnvelopeResponse>();
        var stale = new UploadEnvelopeRequest("chat", 1, "application", [1], [3], null, ExpectedSequenceId: 0);
        var rejected = await _client.PostAsJsonAsync(path, stale);
        Assert.Equal(HttpStatusCode.Conflict, rejected.StatusCode);
        Assert.Equal("mailbox-changed", (await rejected.Content.ReadFromJsonAsync<MailboxChangedResponse>())!.Code);
        Assert.Single((await _client.GetFromJsonAsync<List<EnvelopeResponse>>(path))!);
        // Only after the server confirms absence may the client replace bytes
        // for this same id with a message in the newly verified epoch.
        var accepted = await _client.PostAsJsonAsync(path, stale with { Epoch = 2, Ciphertext = [4], ExpectedSequenceId = stored!.SequenceId });
        Assert.Equal(HttpStatusCode.Created, accepted.StatusCode);
    }

    [Fact]
    public async Task Idempotency_precedes_cursor_check_after_a_lost_response()
    {
        var mailbox = await _client.RegisterMailboxAsync();
        var path = $"/v1/mailboxes/{mailbox}/events";
        var request = new UploadEnvelopeRequest("chat", 1, "application", [1], [3], null, ExpectedSequenceId: 0);
        var first = await _client.PostAsJsonAsync(path, request);
        var original = await first.Content.ReadFromJsonAsync<EnvelopeResponse>();
        await _client.PostAsJsonAsync(path, new UploadEnvelopeRequest("commit", 0, "commit", [1], [2], null));
        var retry = await _client.PostAsJsonAsync(path, request);
        Assert.Equal(HttpStatusCode.OK, retry.StatusCode);
        Assert.Equal(original!.SequenceId, (await retry.Content.ReadFromJsonAsync<EnvelopeResponse>())!.SequenceId);
        Assert.Equal(2, (await _client.GetFromJsonAsync<List<EnvelopeResponse>>(path))!.Count);
    }

    [Fact]
    public async Task Concurrent_conditional_appends_have_exactly_one_winner()
    {
        var mailbox = await _client.RegisterMailboxAsync();
        var path = $"/v1/mailboxes/{mailbox}/events";
        var responses = await Task.WhenAll(Enumerable.Range(0, 12).Select(index => _client.PostAsJsonAsync(path,
            new UploadEnvelopeRequest($"chat-{index}", 1, "application", [1], [3], null, ExpectedSequenceId: 0))));
        Assert.Single(responses, response => response.StatusCode == HttpStatusCode.Created);
        Assert.Equal(11, responses.Count(response => response.StatusCode == HttpStatusCode.Conflict));
        Assert.Single((await _client.GetFromJsonAsync<List<EnvelopeResponse>>(path))!);
    }

    [Fact]
    public async Task Membership_admission_allows_simultaneous_chat_but_rejects_stale_epoch()
    {
        var mailbox = await _client.RegisterMailboxAsync();
        var path = $"/v1/mailboxes/{mailbox}/events";
        var request = new UploadEnvelopeRequest("first", 1, "application", [1], [3], null, 0, "membership-v1");
        var responses = await Task.WhenAll(Enumerable.Range(0, 50).Select(i => _client.PostAsJsonAsync(path, request with { EventId = $"chat-{i}" })));
        Assert.All(responses, response => Assert.Equal(HttpStatusCode.Created, response.StatusCode));
        var commit = await _client.PostAsJsonAsync(path, request with { EventId = "membership", Kind = "commit", ExpectedSequenceId = null });
        var head = (await commit.Content.ReadFromJsonAsync<EnvelopeResponse>())!.SequenceId;
        Assert.Equal(HttpStatusCode.Conflict, (await _client.PostAsJsonAsync(path, request)).StatusCode);
        Assert.Equal(HttpStatusCode.OK, (await _client.PostAsJsonAsync(path, request with { EventId = "chat-0" })).StatusCode);
        Assert.Equal(HttpStatusCode.Created, (await _client.PostAsJsonAsync(path, request with { ExpectedSequenceId = head })).StatusCode);
    }

    [Fact]
    public void Response_schema_has_no_plaintext_or_location_fields()
    {
        // Structural guard: the envelope response contract must only ever
        // expose the opaque fields below. If someone adds a `content`,
        // `latitude`, `longitude`, or `displayName` field to
        // EnvelopeResponse, this test forces them to notice.
        var props = typeof(EnvelopeResponse).GetProperties().Select(p => p.Name).ToHashSet();
        var allowed = new HashSet<string> { "SequenceId", "EventId", "Epoch", "Kind", "Nonce", "Ciphertext", "CreatedAt" };
        Assert.Equal(allowed, props);
    }
}
