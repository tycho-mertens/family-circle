using Microsoft.AspNetCore.Http.Metadata;
using Microsoft.AspNetCore.Routing;
using Microsoft.Extensions.DependencyInjection;
using Xunit;

namespace FamilyCircle.Relay.Tests;

/// <summary>Route-local caps prevent compact endpoints from inheriting the
/// encrypted-backup upload allowance. These are endpoint metadata assertions;
/// Kestrel enforces them before model binding in a real host.</summary>
public sealed class RequestLimitTests : IClassFixture<RelayApiFactory>
{
    private readonly RelayApiFactory factory;
    public RequestLimitTests(RelayApiFactory factory) => this.factory = factory;

    [Theory]
    [InlineData("/v1/mailboxes/{id}/events", 384 * 1024L)]
    [InlineData("/v1/locations/batch", 128 * 1024L)]
    [InlineData("/v1/locations/{id}", 128 * 1024L)]
    [InlineData("/v1/backups/{backupId}", 6 * 1024 * 1024L)]
    public void Write_routes_have_specific_body_limits(string route, long expectedBytes)
    {
        var endpoint = factory.Services.GetServices<EndpointDataSource>()
            .SelectMany(source => source.Endpoints)
            .OfType<RouteEndpoint>()
            .First(endpoint => endpoint.RoutePattern.RawText == route);
        var limit = endpoint.Metadata.GetMetadata<IRequestSizeLimitMetadata>();
        Assert.NotNull(limit);
        Assert.Equal(expectedBytes, limit!.MaxRequestBodySize);
    }
}
