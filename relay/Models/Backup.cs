namespace FamilyCircle.Relay.Models;

/// <summary>
/// An encrypted, seed-phrase-recoverable device backup. The relay never sees the
/// seed phrase or the key that encrypts <see cref="Ciphertext"/>, only the fields
/// below.
/// </summary>
public class Backup
{
    /// <summary>
    /// Public lookup key derived from the BIP39 seed. Recovery can compute it
    /// without any local state.
    /// </summary>
    public required string BackupId { get; set; }

    /// <summary>
    /// HKDF-derived HMAC key received during registration. Later requests prove
    /// possession using a fresh challenge; this key cannot decrypt the backup.
    /// </summary>
    public required byte[] AuthVerifier { get; set; }

    /// <summary>
    /// Opaque to the relay, exactly like <see cref="Envelope.Ciphertext"/>. Encrypted
    /// client-side with a key the relay never sees in any form.
    /// </summary>
    public required byte[] Ciphertext { get; set; }

    // DateTime (UTC), not DateTimeOffset; see Envelope.cs.
    public DateTime UpdatedAt { get; set; }
}
