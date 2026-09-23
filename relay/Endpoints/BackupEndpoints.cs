using FamilyCircle.Relay.Contracts;
using FamilyCircle.Relay.Models;
using FamilyCircle.Relay.Repositories;
using FamilyCircle.Relay.Services;
using FamilyCircle.Relay.Hosting;
using Microsoft.AspNetCore.Http.HttpResults;
using Microsoft.AspNetCore.Mvc;

namespace FamilyCircle.Relay.Endpoints;

public static class BackupEndpoints
{
    // A backup blob holds a device's full MLS state across every joined Circle, not a
    // single message, so it needs far more headroom than one envelope.
    private const int MaxBackupBytes = 4 * 1024 * 1024;
    // HKDF-SHA256 output: an HMAC key of fixed protocol size, never a seed phrase.
    private const int BackupAuthVerifierBytes = 32;

    public static void MapBackupEndpoints(this RouteGroupBuilder backups)
    {
        backups.MapPost("/{backupId}/challenge", RequestBackupChallenge)
            .WithName("RequestBackupChallenge");

        backups.MapPost("/{backupId}", RegisterBackup)
            .WithName("RegisterBackup")
            .WithMetadata(new RequestSizeLimitAttribute(RequestBodyLimits.MaxBackupRequestBodyBytes));

        backups.MapPut("/{backupId}", UpdateBackup)
            .WithName("UpdateBackup")
            .WithMetadata(new RequestSizeLimitAttribute(RequestBodyLimits.MaxBackupRequestBodyBytes));

        backups.MapGet("/{backupId}", FetchBackup)
            .WithName("FetchBackup");
    }

    private static async Task<Results<Ok<BackupChallengeResponse>, NotFound>> RequestBackupChallenge(
        string backupId, IBackupRepository repo, BackupChallengeStore challenges, CancellationToken ct)
    {
        if (await repo.FindAsync(backupId, ct) is null)
        {
            return TypedResults.NotFound();
        }

        return TypedResults.Ok(new BackupChallengeResponse(challenges.Issue(backupId)));
    }

    private static async Task<IResult> RegisterBackup(
        string backupId, RegisterBackupRequest request, IBackupRepository repo, IConfiguration configuration, CancellationToken ct)
    {
        var errors = new Dictionary<string, string[]>();
        if (request.AuthVerifier is not { Length: BackupAuthVerifierBytes })
        {
            errors["authVerifier"] = [$"must be exactly {BackupAuthVerifierBytes} bytes"];
        }
        if (request.Ciphertext is not { Length: > 0 and <= MaxBackupBytes })
        {
            errors["ciphertext"] = [$"required, max {MaxBackupBytes} bytes"];
        }
        if (errors.Count > 0)
        {
            return TypedResults.ValidationProblem(errors);
        }

        // Backups persist indefinitely, so registration must enforce the storage cap.
        var now = DateTime.UtcNow;
        var backup = new Backup
        {
            BackupId = backupId,
            AuthVerifier = request.AuthVerifier,
            Ciphertext = request.Ciphertext,
            UpdatedAt = now,
        };

        var maxBackups = configuration.GetValue("Limits:MaxBackups", 100_000);
        var outcome = await repo.TryRegisterIfUnderCapAsync(backup, maxBackups, ct);
        return outcome switch
        {
            // Registration cannot replace an existing verifier or ciphertext.
            // The owner must update through PUT with a fresh challenge proof.
            BackupRegistrationOutcome.Registered =>
                TypedResults.Created($"/v1/backups/{backupId}", new BackupResponse(backup.Ciphertext, now)),
            BackupRegistrationOutcome.AlreadyExists => TypedResults.Conflict(),
            _ => Results.StatusCode(StatusCodes.Status503ServiceUnavailable),
        };
    }

    private static async Task<Results<Ok<BackupResponse>, NotFound, UnauthorizedHttpResult, ValidationProblem>> UpdateBackup(
        string backupId, UpdateBackupRequest request, IBackupRepository repo, BackupChallengeStore challenges, CancellationToken ct)
    {
        var backup = await repo.FindAsync(backupId, ct);
        if (backup is null)
        {
            return TypedResults.NotFound();
        }

        if (request.Ciphertext is not { Length: > 0 and <= MaxBackupBytes })
        {
            return TypedResults.ValidationProblem(new Dictionary<string, string[]>
            {
                ["ciphertext"] = [$"required, max {MaxBackupBytes} bytes"],
            });
        }

        // TryConsume first, and short-circuit on it: a failed proof must still burn the
        // nonce rather than leave it replayable.
        if (!challenges.TryConsume(backupId, request.Nonce) ||
            !VerifyBackupProof(backup.AuthVerifier, request.Nonce, request.Proof))
        {
            return TypedResults.Unauthorized();
        }

        await repo.UpdateCiphertextAsync(backupId, request.Ciphertext, ct);
        return TypedResults.Ok(new BackupResponse(request.Ciphertext, DateTime.UtcNow));
    }

    private static async Task<Results<Ok<BackupResponse>, NotFound, UnauthorizedHttpResult, ValidationProblem>> FetchBackup(
        string backupId, string? nonce, string? proof, IBackupRepository repo, BackupChallengeStore challenges, CancellationToken ct)
    {
        var backup = await repo.FindAsync(backupId, ct);
        if (backup is null)
        {
            return TypedResults.NotFound();
        }

        if (string.IsNullOrEmpty(nonce) || string.IsNullOrEmpty(proof))
        {
            return TypedResults.ValidationProblem(new Dictionary<string, string[]>
            {
                ["nonce"] = ["required"],
                ["proof"] = ["required"],
            });
        }

        byte[] proofBytes;
        try
        {
            proofBytes = Convert.FromBase64String(proof);
        }
        catch (FormatException)
        {
            return TypedResults.ValidationProblem(new Dictionary<string, string[]> { ["proof"] = ["must be base64"] });
        }

        if (!challenges.TryConsume(backupId, nonce) || !VerifyBackupProof(backup.AuthVerifier, nonce, proofBytes))
        {
            return TypedResults.Unauthorized();
        }

        return TypedResults.Ok(new BackupResponse(backup.Ciphertext, backup.UpdatedAt));
    }

    // HMAC-SHA256(backup.AuthVerifier, decoded nonce) == proof, shared by the update
    // and fetch endpoints. Compared in constant time: the proof's value must not
    // be distinguishable by timing, though its length need not be secret.
    private static bool VerifyBackupProof(byte[] authVerifier, string nonceBase64, byte[] proof)
    {
        byte[] nonceBytes;
        try
        {
            nonceBytes = Convert.FromBase64String(nonceBase64);
        }
        catch (FormatException)
        {
            return false;
        }

        using var hmac = new System.Security.Cryptography.HMACSHA256(authVerifier);
        var expected = hmac.ComputeHash(nonceBytes);
        return System.Security.Cryptography.CryptographicOperations.FixedTimeEquals(expected, proof);
    }
}
