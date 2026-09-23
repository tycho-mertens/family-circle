using System.Globalization;
using System.Security.Cryptography;
using System.Text;
using Org.BouncyCastle.Crypto.Parameters;
using Org.BouncyCastle.Crypto.Signers;

namespace FamilyCircle.Relay.Locations;

public record LocationSnapshot(string Generation, string SessionId, string MailboxId,
    string PublicKey, long Epoch, long ExpiresAt, long Revision, bool Stopped,
    string Nonce, string Ciphertext, string Signature)
{
    public byte[] SigningBytes() => Encoding.UTF8.GetBytes(string.Join("\n",
        "family-circle/location/v1", Generation, SessionId, MailboxId, PublicKey,
        Epoch.ToString(CultureInfo.InvariantCulture), ExpiresAt.ToString(CultureInfo.InvariantCulture),
        Revision.ToString(CultureInfo.InvariantCulture), Stopped ? "1" : "0", Nonce, Ciphertext));

    /// <summary>
    /// Checks field shapes, then that the snapshot is signed by the key its SessionId
    /// commits to. A stopped snapshot must carry no ciphertext at all.
    /// </summary>
    public bool Valid()
    {
        static bool Hex(string? value, int length) =>
            value is not null && value.Length == length && value.All(c => c is >= '0' and <= '9' or >= 'a' and <= 'f');

        if (!Hex(Generation, 32) || !Hex(SessionId, 64) || !Hex(MailboxId, 32) ||
            !Hex(PublicKey, 64) || !Hex(Signature, 128))
        {
            return false;
        }

        if (Epoch < 0 || ExpiresAt < 0 || Revision is < 1 or > 9007199254740991)
        {
            return false;
        }

        var payloadValid = Stopped
            ? Nonce == "" && Ciphertext == ""
            : Hex(Nonce, 24) && Ciphertext is not null && Ciphertext.Length is >= 32 and <= 4096 &&
              Hex(Ciphertext, Ciphertext.Length) && Ciphertext.Length % 2 == 0;
        if (!payloadValid)
        {
            return false;
        }

        try
        {
            var key = Convert.FromHexString(PublicKey);
            if (Convert.ToHexStringLower(SHA256.HashData(key)) != SessionId)
            {
                return false;
            }

            var signer = new Ed25519Signer();
            signer.Init(false, new Ed25519PublicKeyParameters(key, 0));
            var bytes = SigningBytes();
            signer.BlockUpdate(bytes, 0, bytes.Length);
            return signer.VerifySignature(Convert.FromHexString(Signature));
        }
        catch (ArgumentException)
        {
            return false;
        }
    }
}
