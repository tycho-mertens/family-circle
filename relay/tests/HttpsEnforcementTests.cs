using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;
using Xunit;

namespace FamilyCircle.Relay.Tests;

/// <summary>
/// Covers Program.cs's startup guard: the relay must refuse to start outside
/// Development without a configured HTTPS endpoint, rather than silently serving
/// plaintext.
/// </summary>
public class HttpsEnforcementTests
{
    [Fact]
    public void Starting_outside_Development_without_an_enrollment_secret_throws()
    {
        using var factory = new RelayApiFactory().WithWebHostBuilder(builder =>
        {
            builder.UseEnvironment("Production");
            builder.UseUrls("https://127.0.0.1:0");
        });

        Assert.ThrowsAny<Exception>(() => factory.CreateClient());
    }

    [Fact]
    public void Starting_outside_Development_with_no_https_endpoint_throws()
    {
        using var factory = new RelayApiFactory().WithWebHostBuilder(builder =>
        {
            // Override the factory's Development environment for this test.
            builder.UseEnvironment("Production");
        });

        // CreateClient starts the host and runs the startup guard.
        Assert.ThrowsAny<Exception>(() => factory.CreateClient());
    }

    [Fact]
    public void Starting_outside_Development_with_an_https_endpoint_configured_does_not_throw()
    {
        // A production host with HTTPS and an enrollment secret must start.
        var dbPath = Path.Combine(Path.GetTempPath(), $"relay-https-test-{Guid.NewGuid():N}.db");
        try
        {
            using var factory = new WebApplicationFactory<Program>().WithWebHostBuilder(builder =>
            {
                builder.UseEnvironment("Production");
                builder.UseUrls("https://127.0.0.1:0"); // port 0: OS picks a free one
                builder.ConfigureAppConfiguration((_, config) =>
                {
                    config.AddInMemoryCollection(new Dictionary<string, string?>
                    {
                        ["ConnectionStrings:Relay"] = $"Data Source={dbPath}",
                        ["Access:EnrollmentCode"] = "test-operator-secret",
                    });
                });
            });

            using var client = factory.CreateClient();
        }
        finally
        {
            File.Delete(dbPath);
        }
    }

    [Fact]
    public async Task Production_rejects_anonymous_registration_and_sync_negotiation()
    {
        var dbPath = Path.Combine(Path.GetTempPath(), $"relay-production-access-{Guid.NewGuid():N}.db");
        try
        {
            using var factory = new WebApplicationFactory<Program>().WithWebHostBuilder(builder =>
            {
                builder.UseEnvironment("Production");
                builder.UseUrls("https://127.0.0.1:0");
                builder.ConfigureAppConfiguration((_, config) => config.AddInMemoryCollection(new Dictionary<string, string?>
                {
                    ["ConnectionStrings:Relay"] = $"Data Source={dbPath}",
                    ["Access:EnrollmentCode"] = "test-operator-secret",
                }));
            });
            using var client = factory.CreateClient();
            Assert.Equal(System.Net.HttpStatusCode.Unauthorized, (await client.PostAsync("/v1/devices", null)).StatusCode);
            Assert.Equal(System.Net.HttpStatusCode.Unauthorized, (await client.PostAsync("/v1/sync/negotiate?negotiateVersion=1", null)).StatusCode);
        }
        finally
        {
            File.Delete(dbPath);
        }
    }
}
