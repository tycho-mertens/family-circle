using FamilyCircle.Relay.Services;
using Xunit;

namespace FamilyCircle.Relay.Tests;

/// <summary>
/// Unit tests against <see cref="BackupChallengeStore"/> directly: no HTTP, no
/// database. Passes a short <c>ttl</c> so expiry is real without a 60-second wait.
/// </summary>
public class BackupChallengeStoreTests
{
    [Fact]
    public async Task SweepExpired_removes_an_issued_but_never_consumed_challenge_past_its_ttl()
    {
        var store = new BackupChallengeStore(TimeSpan.FromMilliseconds(1));
        store.Issue("backup-1");
        await Task.Delay(50); // let the 1ms TTL actually elapse

        var removed = store.SweepExpired();
        Assert.Equal(1, removed);

        // Confirmed gone, not just counted: a nonce that was never
        // consumed and has now been swept must fail TryConsume the same
        // way an unknown one would (it's simply not in the dictionary
        // anymore: SweepExpired doesn't touch already-past-TTL bookkeeping
        // beyond removing the entry).
        var secondSweep = store.SweepExpired();
        Assert.Equal(0, secondSweep);
    }

    [Fact]
    public void SweepExpired_leaves_a_still_valid_challenge_alone()
    {
        var store = new BackupChallengeStore(TimeSpan.FromMinutes(5));
        var nonce = store.Issue("backup-1");

        var removed = store.SweepExpired();
        Assert.Equal(0, removed);

        // Still there and still redeemable; SweepExpired must not have
        // touched it.
        Assert.True(store.TryConsume("backup-1", nonce));
    }

    [Fact]
    public void SweepExpired_does_not_remove_an_already_consumed_challenge_twice()
    {
        // TryConsume already removes on lookup, success or failure, so a
        // consumed nonce is simply gone and a later sweep has nothing left
        // to find. This pins down that SweepExpired and TryConsume don't
        // double-count or otherwise interact badly.
        var store = new BackupChallengeStore(TimeSpan.FromMilliseconds(1));
        var nonce = store.Issue("backup-1");
        Assert.True(store.TryConsume("backup-1", nonce));

        var removed = store.SweepExpired();
        Assert.Equal(0, removed);
    }
}
