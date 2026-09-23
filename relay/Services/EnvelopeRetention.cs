namespace FamilyCircle.Relay.Services;

internal static class EnvelopeRetention
{
    private const int DefaultTtlSeconds = 7 * 24 * 60 * 60;

    public static int MembershipDays(IConfiguration configuration) =>
        Math.Clamp(configuration.GetValue("Retention:MembershipDays", 30), 7, 365);

    public static DateTime ExpiresAt(DateTime createdAt, string kind, int? ttlSeconds, IConfiguration configuration)
    {
        var retentionSeconds = ttlSeconds ?? DefaultTtlSeconds;
        if (kind is "commit" or "leave")
        {
            retentionSeconds = Math.Max(retentionSeconds, MembershipDays(configuration) * 24 * 60 * 60);
        }

        return createdAt.AddSeconds(retentionSeconds);
    }
}
