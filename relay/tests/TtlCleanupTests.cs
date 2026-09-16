using FamilyCircle.Relay.Data;
using FamilyCircle.Relay.Models;
using FamilyCircle.Relay.Repositories;
using Microsoft.EntityFrameworkCore;
using Xunit;

namespace FamilyCircle.Relay.Tests;

/// <summary>
/// Run TTL deletion against SQLite directly, without waiting for the cleanup timer.
/// This catches SQL translation errors that compilation and HTTP tests miss.
/// </summary>
public class TtlCleanupTests : IDisposable
{
    private readonly string _dbPath = Path.Combine(Path.GetTempPath(), $"relay-ttl-test-{Guid.NewGuid():N}.db");
    private readonly RelayDbContext _db;
    private readonly IMailboxRepository _repo;

    public TtlCleanupTests()
    {
        var options = new DbContextOptionsBuilder<RelayDbContext>()
            .UseSqlite($"Data Source={_dbPath}")
            .Options;
        _db = new RelayDbContext(options);
        _db.Database.EnsureCreated();
        _repo = new SqliteMailboxRepository(_db);
    }

    public void Dispose()
    {
        _db.Dispose();
        File.Delete(_dbPath);
    }

    [Fact]
    public async Task DeleteExpiredAsync_removes_only_envelopes_past_their_ttl()
    {
        var mailboxId = await _repo.RegisterMailboxAsync(default);
        var now = DateTime.UtcNow;

        await _repo.TryAddEventAsync(new Envelope
        {
            MailboxId = mailboxId,
            EventId = "expired",
            Epoch = 1,
            Kind = "application",
            Nonce = [1],
            Ciphertext = [1],
            CreatedAt = now.AddDays(-2),
            ExpiresAt = now.AddDays(-1), // already past
        }, default);

        await _repo.TryAddEventAsync(new Envelope
        {
            MailboxId = mailboxId,
            EventId = "not-expired",
            Epoch = 1,
            Kind = "application",
            Nonce = [2],
            Ciphertext = [2],
            CreatedAt = now,
            ExpiresAt = now.AddDays(7),
        }, default);

        await _repo.TryAddEventAsync(new Envelope
        {
            MailboxId = mailboxId,
            EventId = "no-ttl",
            Epoch = 1,
            Kind = "application",
            Nonce = [3],
            Ciphertext = [3],
            CreatedAt = now,
            ExpiresAt = null, // must never be swept, regardless of `now`
        }, default);

        var removed = await _repo.DeleteExpiredAsync(now, default);
        Assert.Equal(1, removed);

        var remaining = await _repo.GetEventsAfterAsync(mailboxId, 0, 100, default);
        var remainingIds = remaining.Select(e => e.EventId).ToHashSet();
        Assert.Equal(new HashSet<string> { "not-expired", "no-ttl" }, remainingIds);
    }

    [Fact]
    public async Task DeleteExpiredAsync_is_a_no_op_when_nothing_is_expired()
    {
        var mailboxId = await _repo.RegisterMailboxAsync(default);
        await _repo.TryAddEventAsync(new Envelope
        {
            MailboxId = mailboxId,
            EventId = "e1",
            Epoch = 1,
            Kind = "application",
            Nonce = [1],
            Ciphertext = [1],
            CreatedAt = DateTime.UtcNow,
            ExpiresAt = DateTime.UtcNow.AddDays(7),
        }, default);

        var removed = await _repo.DeleteExpiredAsync(DateTime.UtcNow, default);
        Assert.Equal(0, removed);
    }
}
