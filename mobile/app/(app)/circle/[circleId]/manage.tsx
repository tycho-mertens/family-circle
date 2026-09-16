import { SectionHeading } from "../../../../src/components/SectionHeading";
import { CircleNotificationSettings } from "../../../../src/components/CircleNotificationSettings";
import { useEffect, useState } from "react";
import { Alert, Share, Text, View } from "react-native";
import { router, useLocalSearchParams, Stack } from "expo-router";
import { useTheme } from "../../../../src/theme";
import { useCircles, circleLabel } from "../../../../src/state/circles";
import { useIdentity } from "../../../../src/state/identity";
import { ScreenContainer } from "../../../../src/components/ScreenContainer";
import { PageHeading } from "../../../../src/components/PageHeading";
import { Card } from "../../../../src/components/Card";
import { Disclosure } from "../../../../src/components/Disclosure";
import { IconButton } from "../../../../src/components/IconButton";
import { Button } from "../../../../src/components/Button";
import { TextField } from "../../../../src/components/TextField";
import { MemberRow } from "../../../../src/components/MemberRow";
import { EmptyState } from "../../../../src/components/EmptyState";
import { Notice } from "../../../../src/components/Notice";
import { InviteQrCode } from "../../../../src/components/InviteQrCode";

export default function ManageCircle() {
  const { circleId } = useLocalSearchParams<{ circleId: string }>();
  const state = useCircles();
  const { deviceId, nicknames } = useIdentity();
  const circle = state.circles[circleId];
  const { colors, spacing, type } = useTheme();
  const [name, setName] = useState(circle?.circleName ?? "");
  const [successor, setSuccessor] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());
  const [feedback, setFeedback] = useState<string | null>(null);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  const run = async (key: string, action: () => Promise<void>) => {
    if (busy) return;
    setBusy(key);
    setFeedback(null);
    state.clearNotice();
    try {
      await action();
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };
  if (!circle)
    return (
      <ScreenContainer>
        <EmptyState title="This Circle isn't here.">
          <Button title="Your Circles" onPress={() => router.replace("/(app)")} />
        </EmptyState>
      </ScreenContainer>
    );
  const authorityReady = circle.membershipAuthority === "v1";
  const admin = circle.isCreator && circle.role === "member" && authorityReady;
  const invite = circle.invite;
  const validInvite = invite && !invite.used && now < invite.expiresAt;
  const inviteCode = validInvite
    ? `${circle.circleId}.${circle.mailboxId}.${invite.nonce}${invite.adminId ? `.${invite.adminId}` : ""}`
    : null;
  const qrInviteCode = validInvite && invite?.qrNonce ? `${inviteCode}.qr.${invite.qrNonce}` : null;
  const joinRequests = circle.pendingJoinRequests ?? [];
  const requests = circle.pendingRejoinRequests ?? [];
  const latestSystem = state.timeline
    .filter((item) => item.circleId === circleId && item.kind === "system")
    .at(-1);
  return (
    <ScreenContainer>
      <Stack.Screen
        options={{
          headerLeft: () => (
            <IconButton plain label="Back" icon="arrow-back" onPress={() => router.back()} />
          ),
        }}
      />
      <PageHeading
        eyebrow="Circle settings"
        title={circleLabel(circle)}
        body={
          admin
            ? "A space to bring your people together."
            : "The people who make this Circle yours."
        }
      />
      <Notice
        text={
          feedback ??
          state.notice ??
          (latestSystem?.text.startsWith("Couldn") ? latestSystem.text : null)
        }
      />
      {circle.isCreator && !authorityReady && (
        <Card>
          <Notice text="This is a legacy Circle. Its old member list cannot be safely assigned an administrator after the fact. Create a new Circle and invite everyone again before changing membership." />
        </Card>
      )}
      {admin && (
        <Card>
          <Disclosure title="Circle name" summary={circleLabel(circle)}>
            <TextField
              label="Circle name"
              placeholder="e.g. The Sunday Crew"
              value={name}
              onChangeText={setName}
              maxLength={60}
            />
            <Button
              title="Save Circle name"
              disabled={!!busy || !name.trim() || name.trim() === (circle.circleName ?? "")}
              loading={busy === "rename"}
              onPress={() => run("rename", () => state.setCircleName(circleId, name))}
            />
          </Disclosure>
        </Card>
      )}
      {admin && (
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
                  }).catch(() =>
                    setFeedback("Could not open sharing. You can copy the code below."),
                  );
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
      )}

      {admin && joinRequests.length > 0 && (
        <Card>
          <SectionHeading title="Former member requests" icon="person-add-outline" />
          <Text style={[type.body, { color: colors.textSecondary }]}>
            This device was previously removed. Approve only if you want to let this person back in.
          </Text>
          {joinRequests.length > 1 && (
            <Notice text="More than one request is waiting. Approving one consumes this one-time invitation and clears the rest." />
          )}
          {joinRequests.map((id) => (
            <View key={id} style={{ gap: 8 }}>
              <Text style={[type.subtitle, { color: colors.textPrimary }]}>
                {circle.pendingJoinRequestNames?.[id] ?? "Someone"} wants to join
              </Text>
              <Button
                title={`Approve ${circle.pendingJoinRequestNames?.[id] ?? "request"}`}
                disabled={!!busy || !validInvite}
                loading={busy === id}
                onPress={() =>
                  Alert.alert(
                    "Approve this join?",
                    `Does this request come from ${circle.pendingJoinRequestNames?.[id] ?? "the person you invited"}?`,
                    [
                      { text: "Cancel", style: "cancel" },
                      {
                        text: "Approve",
                        onPress: () => run(id, () => state.approveJoinRequest(circleId, id)),
                      },
                    ],
                  )
                }
              />
            </View>
          ))}
        </Card>
      )}

      {admin && requests.length > 0 && (
        <Card>
          <SectionHeading title="Requests to rejoin" icon="enter-outline" />
          <Text style={[type.body, { color: colors.textSecondary }]}>
            Check with the person who asked before approving their device.
          </Text>
          {requests.length > 1 && (
            <Notice text="More than one device is using this code. Confirm which one belongs to your person. Approving one clears the other requests." />
          )}
          {requests.map((id) => (
            <MemberRow
              key={id}
              id={id}
              nickname={nicknames[id]}
              trailing={
                <Button
                  title="Approve"
                  disabled={!!busy || !validInvite}
                  loading={busy === id}
                  onPress={() =>
                    Alert.alert(
                      "Approve this device?",
                      `Confirm this is the device you invited:\n${id}`,
                      [
                        { text: "Cancel", style: "cancel" },
                        {
                          text: "Approve",
                          onPress: () => run(id, () => state.approveRejoinRequest(circleId, id)),
                        },
                      ],
                    )
                  }
                />
              }
            />
          ))}
        </Card>
      )}
      <Card>
        <SectionHeading
          title={circle.role === "removed" ? "Last known members" : "Your people"}
          icon="people-outline"
          detail={String(circle.members.length)}
        />
        {circle.members.map((id) => (
          <MemberRow
            key={id}
            id={id}
            nickname={nicknames[id]}
            isYou={id === deviceId}
            isCreator={circle.adminId === id}
            trailing={
              admin && id !== deviceId ? (
                <Button
                  title="Remove"
                  variant="ghost"
                  disabled={!!busy}
                  loading={busy === id}
                  onPress={() =>
                    Alert.alert(
                      "Remove this member?",
                      "Once confirmed, they won't be able to read new messages. Anything they already read or saved stays with them.",
                      [
                        { text: "Cancel", style: "cancel" },
                        {
                          text: "Remove",
                          style: "destructive",
                          onPress: () => run(id, () => state.removeMember(circleId, id)),
                        },
                      ],
                    )
                  }
                />
              ) : undefined
            }
          />
        ))}
        {circle.role === "joining" && (
          <Text style={[type.body, { color: colors.textSecondary }]}>
            The member list will appear once your invitation is accepted.
          </Text>
        )}
        {!circle.isCreator && (
          <Text style={[type.caption, { color: colors.textSecondary }]}>
            Your admin manages invitations, the Circle name, and membership.
          </Text>
        )}
      </Card>
      <CircleNotificationSettings circle={circle} />
      {circle.role === "member" && (
        <Card style={{ borderColor: colors.danger + "40" }}>
          <SectionHeading title="Leave this Circle" icon="exit-outline" />
          <Text style={[type.body, { color: colors.textSecondary }]}>
            Your departure stays pending until a membership update confirms removal. You'll need a
            new invitation to return.
          </Text>
          {admin && circle.members.length > 1 && (
            <>
              <Text style={[type.body, { color: colors.textSecondary }]}>
                Choose who will manage invitations and membership after you. Their phone must
                confirm the handover before you leave.
              </Text>
              {circle.members
                .filter((id) => id !== deviceId && !circle.departingMembers?.includes(id))
                .map((id) => (
                  <Button
                    key={id}
                    title={`${successor === id ? "✓ " : ""}${nicknames[id] ?? id.slice(0, 12)}`}
                    variant={successor === id ? "secondary" : "ghost"}
                    disabled={!!busy || (!!circle.handover && !circle.handover.confirmed)}
                    onPress={() => setSuccessor(id)}
                  />
                ))}
              <Button
                title="Make selected member admin"
                variant="secondary"
                disabled={
                  !!busy ||
                  !successor ||
                  (!!circle.handover && !circle.handover.confirmed) ||
                  !!circle.syncError ||
                  !!circle.recoveryRequired ||
                  !!circle.pendingCommitEventId
                }
                loading={busy === "handover"}
                onPress={() =>
                  Alert.alert(
                    "Transfer admin role?",
                    "The selected member will manage this Circle. You will remain a member until you choose to leave.",
                    [
                      { text: "Cancel", style: "cancel" },
                      {
                        text: "Transfer",
                        onPress: () =>
                          run("handover", () => state.transferAdmin(circleId, successor!)),
                      },
                    ],
                  )
                }
              />
            </>
          )}
          {circle.handover && (
            <Notice
              text={
                circle.handover.confirmed
                  ? `${nicknames[circle.handover.adminId] ?? "The new admin"} has received the handover. You can leave now.`
                  : "Handover pending. Waiting for the new admin's phone to reconnect and confirm."
              }
            />
          )}
          <Button
            title="Leave Circle"
            variant="danger"
            disabled={
              !!busy ||
              (admin && circle.members.length > 1) ||
              (!!circle.handover && !circle.handover.confirmed)
            }
            loading={busy === "leave"}
            onPress={() =>
              Alert.alert(
                "Ready to leave?",
                "Leave this Circle and delete its chat history from this phone? Your departure will remain visible until confirmed.",
                [
                  { text: "Stay", style: "cancel" },
                  {
                    text: "Leave Circle",
                    style: "destructive",
                    onPress: () =>
                      run("leave", async () => {
                        if (await state.leaveCircle(circleId)) router.replace("/(app)");
                      }),
                  },
                ],
              )
            }
          />
        </Card>
      )}
      {admin && (
        <Card>
          <Disclosure
            title="Connection recovery"
            summary="Help a member who restored an older backup"
          >
            <Text style={[type.body, { color: colors.textSecondary }]}>
              Refresh connection keys after a member restores saved data. A temporary internet
              disconnection normally catches up automatically.
            </Text>
            <Button
              title="Refresh connection keys"
              disabled={!!busy || !!circle.syncError}
              loading={busy === "refresh"}
              onPress={() => run("refresh", () => state.refreshConnection(circleId))}
            />
          </Disclosure>
        </Card>
      )}
      {!circle.isCreator && circle.role !== "joining" && (
        <Card>
          <Disclosure
            title="Troubleshooting"
            summary="Request a fresh membership if messages won’t open"
            initiallyOpen={circle.role === "removed"}
          >
            <Text style={[type.body, { color: colors.textSecondary }]}>
              After a temporary disconnection, reconnect and let this Circle catch up. If you
              restored an older backup, ask your admin to refresh connection keys. If your
              membership still cannot recover, use a fresh invite code below; messages from before
              the new membership will not be readable.
            </Text>
            <TextField
              label="Fresh invite code"
              placeholder="Paste the code from your admin"
              value={code}
              onChangeText={setCode}
              autoCapitalize="none"
              autoCorrect={false}
              multiline
            />
            <Button
              title="Request to rejoin"
              variant="secondary"
              disabled={!!busy || !code.trim()}
              loading={busy === "rejoin"}
              onPress={() => run("rejoin", () => state.requestRejoin(circleId, code))}
            />
          </Disclosure>
        </Card>
      )}
    </ScreenContainer>
  );
}
