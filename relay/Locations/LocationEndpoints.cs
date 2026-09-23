using FamilyCircle.Relay.Repositories;
using FamilyCircle.Relay.Services;
using Microsoft.AspNetCore.Mvc;

namespace FamilyCircle.Relay.Locations;

public static class LocationEndpoints
{
    // Signed location snapshots and batched reads carry compact metadata only, and
    // should never inherit the multi-megabyte backup allowance.
    private const long MaxLocationRequestBodyBytes = 128 * 1024;

    public static void MapLocations(this WebApplication app)
    {
        app.MapPost("/v1/locations/batch", (LocationBatchRequest request, LocationStore store, HttpContext ctx) =>
        {
            ctx.Response.Headers.CacheControl = "no-store";
            if (request.Sessions is null || request.Sessions.Length is < 1 or > 100 ||
                request.Sessions.Any(x => x is null || x.SessionId is null || x.SessionId.Length != 64 ||
                                          !x.SessionId.All(Uri.IsHexDigit) || x.Revision is < 0))
            {
                return Results.BadRequest();
            }

            if (request.Generation != store.Generation)
            {
                return Results.Conflict(new { generation = store.Generation });
            }

            return Results.Ok(new
            {
                generation = store.Generation,
                results = store.GetBatch(request.Sessions, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()),
            });
        }).WithMetadata(new RequestSizeLimitAttribute(MaxLocationRequestBodyBytes));

        app.MapGet("/v1/locations/generation", (LocationStore store, HttpContext ctx) =>
        {
            ctx.Response.Headers.CacheControl = "no-store";
            return Results.Ok(new { generation = store.Generation });
        });

        app.MapPut("/v1/locations/{id}", async Task<IResult> (
            string id, LocationSnapshot wire, LocationStore store, IMailboxRepository mailboxes,
            SyncNotifications notifications, HttpContext ctx, CancellationToken ct) =>
        {
            ctx.Response.Headers.CacheControl = "no-store";
            if (id != wire.SessionId)
            {
                return Results.BadRequest();
            }

            // The signature authenticates this snapshot's session, but cannot
            // establish that its claimed notification mailbox was ever registered.
            // Reject unknown mailboxes before touching the location store.
            if (!await mailboxes.MailboxExistsAsync(wire.MailboxId, ct))
            {
                return Results.NotFound();
            }

            var status = store.Put(wire, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
            if (status == 200)
            {
                notifications.Changed(wire.MailboxId);
            }

            return Results.StatusCode(status);
        }).WithMetadata(new RequestSizeLimitAttribute(MaxLocationRequestBodyBytes));

        app.MapGet("/v1/locations/{id}", (string id, LocationStore store, HttpContext ctx) =>
        {
            ctx.Response.Headers.CacheControl = "no-store";
            var (status, snapshot) = store.Get(id, DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
            return status == 200 ? Results.Ok(snapshot) : Results.StatusCode(status);
        });
    }
}
