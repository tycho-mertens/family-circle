using System.Diagnostics;
using System.Diagnostics.Metrics;
using Microsoft.AspNetCore.Routing;

namespace FamilyCircle.Relay.Services;

public static class RelayMetrics
{
    private static readonly Meter Meter = new("FamilyCircle.Relay");
    private static readonly Counter<long> Requests = Meter.CreateCounter<long>("relay.requests");
    private static readonly Histogram<double> Duration = Meter.CreateHistogram<double>("relay.request.duration", "ms");

    public static async Task Measure(HttpContext context, RequestDelegate next)
    {
        var start = Stopwatch.GetTimestamp();
        try
        {
            await next(context);
        }
        finally
        {
            var route = (context.GetEndpoint() as RouteEndpoint)?.RoutePattern.RawText ?? "unmatched";
            var tags = new TagList
            {
                { "route", route },
                { "method", context.Request.Method },
                { "status", context.Response.StatusCode },
            };
            Requests.Add(1, tags);
            Duration.Record(Stopwatch.GetElapsedTime(start).TotalMilliseconds, tags);
        }
    }
}
