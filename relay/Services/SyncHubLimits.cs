namespace FamilyCircle.Relay.Services;

/// <summary>Explicit per-process SignalR budgets. Scale-out deployments must
/// set these per relay instance and use a shared backplane before increasing
/// them.</summary>
public sealed class SyncHubLimits(IConfiguration configuration)
{
    public int MaxConnections => Math.Clamp(configuration.GetValue("Limits:SignalR:MaxConnections", 2_000), 1, 100_000);
    public int MaxConnectionsPerInstallation => Math.Clamp(configuration.GetValue("Limits:SignalR:MaxConnectionsPerInstallation", 4), 1, 100);
    public int MaxConnectionsPerIp => Math.Clamp(configuration.GetValue("Limits:SignalR:MaxConnectionsPerIp", 200), 1, 10_000);
    public int MaxSubscriptions => Math.Clamp(configuration.GetValue("Limits:SignalR:MaxSubscriptions", 100), 1, 1_000);
    public int SubscriptionMinIntervalMs => Math.Clamp(configuration.GetValue("Limits:SignalR:SubscriptionMinIntervalMs", 1_000), 100, 60_000);
}
