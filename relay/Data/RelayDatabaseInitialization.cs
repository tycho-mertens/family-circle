using FamilyCircle.Relay.Services;
using Microsoft.EntityFrameworkCore;

namespace FamilyCircle.Relay.Data;

internal static class RelayDatabaseInitialization
{
    public static async Task InitializeRelayDatabaseAsync(this IServiceProvider services, IConfiguration configuration)
    {
        // Creates the SQLite schema directly; there are no EF Core migrations yet.
        // Revisit before moving off SQLite.
        using (var scope = services.CreateScope())
        {
            var db = scope.ServiceProvider.GetRequiredService<RelayDbContext>();
            await db.Database.EnsureCreatedAsync();
            var membershipDays = EnvelopeRetention.MembershipDays(configuration);
            var retentionModifier = $"+{membershipDays} days";
            await db.Database.ExecuteSqlInterpolatedAsync($"""
                UPDATE Envelopes
                SET ExpiresAt=datetime(CreatedAt,{retentionModifier})
                WHERE Kind IN ('commit','leave')
                    AND ExpiresAt IS NOT NULL
                    AND ExpiresAt<datetime(CreatedAt,{retentionModifier})
                """);
            // Additive migration for existing installations. A conservative initial head
            // makes old clients catch up even if earlier commits already expired.
            await db.Database.ExecuteSqlRawAsync("""
                CREATE TABLE IF NOT EXISTS MembershipHeads (
                    MailboxId TEXT PRIMARY KEY,
                    SequenceId INTEGER NOT NULL
                );
                INSERT OR IGNORE INTO MembershipHeads
                SELECT MailboxId, MAX(SequenceId) FROM Envelopes GROUP BY MailboxId;
                """);
        }
    }
}
