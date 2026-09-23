namespace FamilyCircle.Relay.Hosting;

internal static class RequestBodyLimits
{
    // JSON byte arrays arrive base64 encoded; these budgets include that expansion so
    // routes other than backup upload don't inherit the multi-megabyte allowance.
    public const long MaxEnvelopeRequestBodyBytes = 384 * 1024;
    public const long MaxBackupRequestBodyBytes = 6 * 1024 * 1024;
    public const long MaxSmallRequestBodyBytes = 32 * 1024;
}
