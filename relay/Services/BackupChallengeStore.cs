using System.Collections.Concurrent;
using System.Security.Cryptography;

namespace FamilyCircle.Relay.Services;

/// <summary>
/// Single-use HMAC challenges for /v1/backups. Register as a singleton so
/// issue and redeem requests share state. Clients request a fresh challenge
/// after expiry or a relay restart.
/// </summary>
/// <param name="ttl">Defaults to 60 seconds; tests use a shorter lifetime.</param>
public class BackupChallengeStore(TimeSpan? ttl = null)
{
    private readonly TimeSpan _ttl = ttl ?? TimeSpan.FromSeconds(60);

    private readonly ConcurrentDictionary<(string BackupId, string Nonce), DateTime> _pending = new();

    /// <summary>Issues a fresh, base64-encoded nonce scoped to <paramref name="backupId"/>.</summary>
    public string Issue(string backupId)
    {
        var nonce = Convert.ToBase64String(RandomNumberGenerator.GetBytes(24));
        _pending[(backupId, nonce)] = DateTime.UtcNow.Add(_ttl);
        return nonce;
    }

    /// <summary>
    /// Consumes a nonce for <paramref name="backupId"/>. Single-use: a nonce that
    /// verifies once never verifies again. Returns false if it was never issued for
    /// this backupId, was already consumed, or has expired.
    /// </summary>
    public bool TryConsume(string backupId, string nonce)
    {
        if (!_pending.TryRemove((backupId, nonce), out var expiresAt))
        {
            return false;
        }

        return DateTime.UtcNow < expiresAt;
    }

    /// <summary>
    /// Remove expired, unredeemed challenges and return the count for logging.
    /// TryConsume only removes entries it looks up.
    /// </summary>
    public int SweepExpired()
    {
        var now = DateTime.UtcNow;
        var removed = 0;
        foreach (var (key, expiresAt) in _pending)
        {
            if (expiresAt <= now && _pending.TryRemove(key, out _))
            {
                removed++;
            }
        }

        return removed;
    }
}
