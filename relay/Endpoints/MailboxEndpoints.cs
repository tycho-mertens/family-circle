using FamilyCircle.Relay.Contracts;
using FamilyCircle.Relay.Models;
using FamilyCircle.Relay.Repositories;
using FamilyCircle.Relay.Services;
using FamilyCircle.Relay.Hosting;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc;

namespace FamilyCircle.Relay.Endpoints;

public static class MailboxEndpoints
{
    private const int MaxCiphertextBytes = 256 * 1024;
    // Event IDs are client-generated protocol metadata; the cap keeps a SQLite index
    // entry from outgrowing the payload it identifies.
    private const int MaxEventIdCharacters = 512;
    // Application envelopes use a 12-byte AEAD nonce, control traffic a one-byte
    // sentinel. Headroom for future algorithms, still bounded.
    private const int MaxEnvelopeNonceBytes = 64;
    private const int MaxTtlSeconds = 30 * 24 * 60 * 60;

    public static void MapMailboxEndpoints(this RouteGroupBuilder api)
    {
        api.MapPost("/devices", RegisterDevice)
            .WithName("RegisterDevice");

        api.MapPost("/mailboxes/{id}/events", UploadEvent)
            .WithName("UploadEvent")
            .WithMetadata(new RequestSizeLimitAttribute(RequestBodyLimits.MaxEnvelopeRequestBodyBytes));

        api.MapGet("/mailboxes/{id}/events", GetEvents)
            .WithName("GetEvents");

        api.MapPost("/mailboxes/{id}/ack", AckEvents)
            .WithName("AckEvents")
            .WithMetadata(new RequestSizeLimitAttribute(RequestBodyLimits.MaxSmallRequestBodyBytes));
    }

    private static async Task<IResult> RegisterDevice(IMailboxRepository repo, IConfiguration configuration, CancellationToken ct)
    {
        // Mailboxes persist indefinitely, so cap their total count as well as request rate.
        // The repository checks capacity and inserts atomically to prevent concurrent
        // registrations from exceeding the cap.
        var maxMailboxes = configuration.GetValue("Limits:MaxMailboxes", 100_000);
        var mailboxId = await repo.TryRegisterMailboxIfUnderCapAsync(maxMailboxes, ct);
        if (mailboxId is null)
        {
            return Results.StatusCode(StatusCodes.Status503ServiceUnavailable);
        }

        return Results.Created($"/v1/mailboxes/{mailboxId}", new RegisterMailboxResponse(mailboxId));
    }

    private static async Task<Results<Created<EnvelopeResponse>, Ok<EnvelopeResponse>, ValidationProblem, NotFound, Conflict<MailboxChangedResponse>>> UploadEvent(
        string id, UploadEnvelopeRequest request, IMailboxRepository repo, IConfiguration configuration, SyncNotifications notifications, CancellationToken ct)
    {
        if (!await repo.MailboxExistsAsync(id, ct))
        {
            return TypedResults.NotFound();
        }

        var errors = new Dictionary<string, string[]>();
        if (string.IsNullOrWhiteSpace(request.EventId) || request.EventId.Length > MaxEventIdCharacters)
        {
            errors["eventId"] = [$"required, max {MaxEventIdCharacters} characters"];
        }
        if (string.IsNullOrWhiteSpace(request.Kind) || request.Kind.Length > 32)
        {
            errors["kind"] = ["required, max 32 characters"];
        }
        if (request.Nonce is not { Length: > 0 and <= MaxEnvelopeNonceBytes })
        {
            errors["nonce"] = [$"required, max {MaxEnvelopeNonceBytes} bytes"];
        }
        if (request.Ciphertext is not { Length: > 0 and <= MaxCiphertextBytes })
        {
            errors["ciphertext"] = [$"required, max {MaxCiphertextBytes} bytes"];
        }
        if (request.TtlSeconds is < 1 or > MaxTtlSeconds)
        {
            errors["ttlSeconds"] = [$"must be between 1 and {MaxTtlSeconds}"];
        }
        if (request.ExpectedSequenceId is < 0 || request.Admission is not (null or "membership-v1"))
        {
            errors["admission"] = ["invalid admission mode or cursor"];
        }
        if (errors.Count > 0)
        {
            return TypedResults.ValidationProblem(errors);
        }

        var now = DateTime.UtcNow;
        var envelope = new Envelope
        {
            MailboxId = id,
            EventId = request.EventId,
            Epoch = request.Epoch,
            Kind = request.Kind,
            Nonce = request.Nonce,
            Ciphertext = request.Ciphertext,
            CreatedAt = now,
            ExpiresAt = EnvelopeRetention.ExpiresAt(now, request.Kind, request.TtlSeconds, configuration),
        };

        bool inserted;
        try
        {
            inserted = await repo.TryAddEventAsync(envelope, ct, request.ExpectedSequenceId, request.Admission == "membership-v1");
        }
        catch (MailboxChangedException)
        {
            return TypedResults.Conflict(new MailboxChangedResponse("mailbox-changed"));
        }

        if (inserted)
        {
            notifications.Changed(id);
        }

        var response = ToResponse(envelope);

        // Idempotent: a duplicate eventId is not an error and stores no second event.
        return inserted
            ? TypedResults.Created($"/v1/mailboxes/{id}/events/{envelope.EventId}", response)
            : TypedResults.Ok(response);
    }

    private static async Task<Results<Ok<IReadOnlyList<EnvelopeResponse>>, NotFound>> GetEvents(
        string id, long? after, int? limit, IMailboxRepository repo, CancellationToken ct)
    {
        if (!await repo.MailboxExistsAsync(id, ct))
        {
            return TypedResults.NotFound();
        }

        var events = await repo.GetEventsAfterAsync(id, after ?? 0, Math.Clamp(limit ?? 100, 1, 500), ct);
        var response = events.Select(ToResponse).ToList();
        return TypedResults.Ok<IReadOnlyList<EnvelopeResponse>>(response);
    }

    private static async Task<Results<NoContent, NotFound>> AckEvents(
        string id, AckRequest request, IMailboxRepository repo, CancellationToken ct)
    {
        if (!await repo.MailboxExistsAsync(id, ct))
        {
            return TypedResults.NotFound();
        }

        await repo.AckAsync(id, request.SequenceId, ct);
        return TypedResults.NoContent();
    }

    private static EnvelopeResponse ToResponse(Envelope envelope) =>
        new(envelope.SequenceId, envelope.EventId, envelope.Epoch, envelope.Kind,
            envelope.Nonce, envelope.Ciphertext, envelope.CreatedAt);
}
