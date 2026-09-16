namespace FamilyCircle.Relay.Contracts;

/// <summary>
/// Upload metadata and encrypted bytes. Clients must encrypt content before upload;
/// the relay does not inspect the ciphertext.
/// </summary>
public record UploadEnvelopeRequest(
    string EventId,
    long Epoch,
    string Kind,
    byte[] Nonce,
    byte[] Ciphertext,
    int? TtlSeconds,
    long? ExpectedSequenceId = null,
    string? Admission = null);

public record EnvelopeResponse(
    long SequenceId,
    string EventId,
    long Epoch,
    string Kind,
    byte[] Nonce,
    byte[] Ciphertext,
    DateTime CreatedAt);

public record RegisterMailboxResponse(string MailboxId);

public record AckRequest(long SequenceId);

/// <summary>First-time backup registration.</summary>
public record RegisterBackupRequest(byte[] AuthVerifier, byte[] Ciphertext);

public record BackupChallengeResponse(string Nonce);

/// <summary>
/// Proves knowledge of the backup's AuthVerifier without sending it: <c>Proof</c> is
/// HMAC-SHA256(AuthVerifier, Nonce) against a <c>Nonce</c> this same BackupId issued
/// via <c>POST .../challenge</c>.
/// </summary>
public record UpdateBackupRequest(string Nonce, byte[] Proof, byte[] Ciphertext);

public record BackupResponse(byte[] Ciphertext, DateTime UpdatedAt);

public record MailboxChangedResponse(string Code);
