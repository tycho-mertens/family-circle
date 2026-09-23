import { Share, Text, View } from "react-native";
import { Button } from "../../components/Button";
import { Card } from "../../components/Card";
import { Disclosure } from "../../components/Disclosure";
import { InviteQrCode } from "../../components/InviteQrCode";
import { Notice } from "../../components/Notice";
import { SectionHeading } from "../../components/SectionHeading";
import { circleLabel, useCircles } from "../../state/circles";
import { useTheme } from "../../theme";

import type { CircleInfo } from "../../runtime/circle-types";
interface Props {
  circle: CircleInfo;
  busy: string | null;
  run: (key: string, action: () => Promise<void>) => Promise<void>;
  now: number;
  onError: (message: string) => void;
}

export function CircleInvitation({ circle, busy, run, now, onError }: Props) {
  const state = useCircles();
  const { colors, spacing, type } = useTheme();
  const { circleId } = circle;
  const invite = circle.invite;
  const validInvite = invite && !invite.used && now < invite.expiresAt;
  const inviteCode = validInvite
    ? `${circle.circleId}.${circle.mailboxId}.${invite.nonce}${invite.adminId ? `.${invite.adminId}` : ""}`
    : null;
  const qrInviteCode =
    validInvite && invite?.qrNonce ? `${inviteCode}.qr.${invite.qrNonce}` : null;
  return (
    <Card>
      <SectionHeading title="Invite your people" icon="person-add-outline" />
      <Text style={[type.body, { color: colors.textSecondary }]}>
        Share either invitation privately. A valid one-time code or QR scan adds a new person
        automatically.
      </Text>
      {validInvite ? (
        <>
          <Button
            title="Share invitation"
            onPress={() => {
              void Share.share({
                title: `Join ${circleLabel(circle)}`,
                message: inviteCode!,
              }).catch(() => onError("Could not open sharing. You can copy the code below."));
            }}
          />
          <Disclosure
            title="Show invitation QR code"
            summary="Let someone scan this from their phone"
          >
            <View style={{ alignItems: "center", gap: 12 }}>
              <InviteQrCode value={qrInviteCode ?? inviteCode!} />
              <Text
                style={[type.caption, { color: colors.textSecondary, textAlign: "center" }]}
              >
                Scanning this private, one-time QR invitation joins the person automatically. It
                expires in {Math.ceil((invite.expiresAt - now) / 60000)} min.
              </Text>
            </View>
          </Disclosure>
          <Disclosure title="Show invite code">
            <Text
              selectable
              accessibilityLabel="Invite code"
              style={[
                type.caption,
                {
                  color: colors.textPrimary,
                  padding: spacing.md,
                  borderRadius: 12,
                  backgroundColor: colors.surfaceAlt,
                },
              ]}
            >
              {inviteCode}
            </Text>
            <Text style={[type.caption, { color: colors.textSecondary }]}>
              Press and hold to copy · Expires in {Math.ceil((invite.expiresAt - now) / 60000)}
              {" min"}
            </Text>
          </Disclosure>
        </>
      ) : (
        <Notice
          text={
            invite?.used
              ? "This invitation has been used. Make a new one for the next person."
              : invite
                ? "Your invitation has expired. Make a new one when you're ready."
                : "Create an invitation when you're ready to add someone."
          }
        />
      )}
      <Button
        title="Generate new invite code"
        variant="ghost"
        loading={busy === "invite"}
        disabled={!!busy}
        onPress={() => run("invite", () => state.regenerateInvite(circleId))}
      />
    </Card>
  );
}
