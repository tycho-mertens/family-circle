using System.Security.Cryptography;
using System.Text;
using Microsoft.AspNetCore.DataProtection;

namespace FamilyCircle.Relay.Services;

public sealed class InstallationAccess(IDataProtectionProvider provider, IConfiguration config, IHostEnvironment environment)
{
    private readonly IDataProtector protector = provider.CreateProtector("FamilyCircle.installation.v1");

    /// <summary>
    /// Installation credentials may only be opted out of in Development. A
    /// configuration value must never be able to turn authentication off in
    /// production.
    /// </summary>
    public bool Required => !environment.IsDevelopment() || config.GetValue("Access:RequireInstallation", false);

    public void ValidateConfiguration()
    {
        if (!environment.IsDevelopment() && string.IsNullOrWhiteSpace(config["Access:EnrollmentCode"]))
        {
            throw new InvalidOperationException(
                "Access:EnrollmentCode must be a non-empty operator-provided secret outside Development. " +
                "Provision it through the deployment secret store; do not put it in appsettings.json.");
        }
    }

    public bool CanEnroll(string? code)
    {
        var expected = config["Access:EnrollmentCode"];
        if (string.IsNullOrEmpty(expected))
        {
            return environment.IsDevelopment();
        }

        return CryptographicOperations.FixedTimeEquals(
            SHA256.HashData(Encoding.UTF8.GetBytes(expected)),
            SHA256.HashData(Encoding.UTF8.GetBytes(code ?? "")));
    }

    public string Issue() => protector.Protect(Guid.NewGuid().ToString("N"));

    public string? Read(string? value)
    {
        if (string.IsNullOrEmpty(value) || value.Length > 1024)
        {
            return null;
        }

        try
        {
            var id = protector.Unprotect(value);
            return Guid.TryParseExact(id, "N", out _) ? id : null;
        }
        catch (CryptographicException)
        {
            return null;
        }
    }
}

public record EnrollmentRequest(string? Code);
