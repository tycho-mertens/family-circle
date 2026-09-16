using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;

namespace FamilyCircle.Relay.Tests;

/// <summary>Spins up the relay against a throwaway SQLite file per test class instance.</summary>
public class RelayApiFactory : WebApplicationFactory<Program>
{
    private readonly string _dbPath = Path.Combine(Path.GetTempPath(), $"relay-test-{Guid.NewGuid():N}.db");

    protected override void ConfigureWebHost(IWebHostBuilder builder)
    {
        builder.UseEnvironment("Development");
        builder.ConfigureAppConfiguration((_, config) =>
        {
            config.AddInMemoryCollection(new Dictionary<string, string?>
            {
                ["ConnectionStrings:Relay"] = $"Data Source={_dbPath}",
            });
        });
    }

    protected override void Dispose(bool disposing)
    {
        base.Dispose(disposing);
        if (disposing)
        {
            File.Delete(_dbPath);
            File.Delete(_dbPath + ".locations");
            File.Delete(_dbPath + ".locations-journal");
        }
    }
}
