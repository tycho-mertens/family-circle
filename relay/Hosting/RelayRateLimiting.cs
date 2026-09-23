using System.Threading.RateLimiting;
using Microsoft.AspNetCore.RateLimiting;

namespace FamilyCircle.Relay.Hosting;

internal static class RelayRateLimiting
{
    public static void AddRelayRateLimiting(this IServiceCollection services)
    {
        services.AddRateLimiter(options =>
        {
            options.RejectionStatusCode = StatusCodes.Status429TooManyRequests;
            options.OnRejected = (context, _) =>
            {
                context.HttpContext.Response.Headers.RetryAfter = "60";
                return ValueTask.CompletedTask;
            };

            // Chained: a request must pass the per-IP window and, once enrolled, the
            // per-installation one. IP partitioning alone collapses every device behind a
            // NAT onto one bucket, which is why the installation partition exists.
            options.GlobalLimiter = PartitionedRateLimiter.CreateChained(
                PartitionedRateLimiter.Create<HttpContext, string>(ctx =>
                    RateLimitPartition.GetFixedWindowLimiter(
                        ctx.Connection.RemoteIpAddress?.ToString() ?? "unknown",
                        _ => new FixedWindowRateLimiterOptions
                        {
                            PermitLimit = ctx.RequestServices.GetRequiredService<IConfiguration>()
                                .GetValue("Limits:RequestsPerIpMinute", 12000),
                            Window = TimeSpan.FromMinutes(1),
                            QueueLimit = 0,
                        })),
                PartitionedRateLimiter.Create<HttpContext, string>(ctx => ctx.Items["installation"] is string id
                    ? RateLimitPartition.GetFixedWindowLimiter(
                        id,
                        _ => new FixedWindowRateLimiterOptions
                        {
                            PermitLimit = ctx.RequestServices.GetRequiredService<IConfiguration>()
                                .GetValue("Limits:RequestsPerInstallationMinute", 1200),
                            Window = TimeSpan.FromMinutes(1),
                            QueueLimit = 0,
                        })
                    : RateLimitPartition.GetNoLimiter("anonymous")));

            options.AddPolicy("enrollment", ctx =>
                RateLimitPartition.GetFixedWindowLimiter(
                    ctx.Connection.RemoteIpAddress?.ToString() ?? "unknown",
                    _ => new FixedWindowRateLimiterOptions
                    {
                        PermitLimit = 60,
                        Window = TimeSpan.FromHours(1),
                        QueueLimit = 0,
                    }));
        });
    }
}
