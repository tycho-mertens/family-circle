import { router, Stack, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { Alert, Text, View } from "react-native";
import { Button } from "../../../../src/components/Button";
import { Card } from "../../../../src/components/Card";
import { CircleNotificationSettings } from "../../../../src/components/CircleNotificationSettings";
import { Disclosure } from "../../../../src/components/Disclosure";
import { EmptyState } from "../../../../src/components/EmptyState";
import { IconButton } from "../../../../src/components/IconButton";
import { MemberRow } from "../../../../src/components/MemberRow";
import { Notice } from "../../../../src/components/Notice";
import { PageHeading } from "../../../../src/components/PageHeading";
import { ScreenContainer } from "../../../../src/components/ScreenContainer";
import { SectionHeading } from "../../../../src/components/SectionHeading";
import { TextField } from "../../../../src/components/TextField";
import { CircleDeparture } from "../../../../src/features/circles/CircleDeparture";
import { CircleInvitation } from "../../../../src/features/circles/CircleInvitation";
import { circleLabel, useCircles } from "../../../../src/state/circles";
import { useIdentity } from "../../../../src/state/identity";
import { useTheme } from "../../../../src/theme";

export default function ManageCircle() {
  const { circleId } = useLocalSearchParams<{ circleId: string }>();
  const state = useCircles();
  const { deviceId, nicknames } = useIdentity();
  const circle = state.circles[circleId];
  const { colors, spacing, type } = useTheme();
  const [name, setName] = useState(circle?.circleName ?? "");
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
  const admin = circle.isAdmin && circle.role === "member" && authorityReady;
  const validInvite = circle.invite && !circle.invite.used && now < circle.invite.expiresAt;
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
      {circle.isAdmin && !authorityReady && (
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
        <CircleInvitation
          circle={circle}
          busy={busy}
          run={run}
          now={now}
          onError={setFeedback}
        />
      )}

      {admin && joinRequests.length > 0 && (
        <Card>
          <SectionHeading title="Former member requests" icon="person-add-outline" />
          <Text style={[type.body, { color: colors.textSecondary }]}>
            This device was previously removed. Approve only if you want to let this person back
            in.
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
                          onPress: () =>
                            run(id, () => state.approveRejoinRequest(circleId, id)),
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
            isAdmin={circle.adminId === id}
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
        {!circle.isAdmin && (
          <Text style={[type.caption, { color: colors.textSecondary }]}>
            Your admin manages invitations, the Circle name, and membership.
          </Text>
        )}
      </Card>
      <CircleNotificationSettings circle={circle} />
      {circle.role === "member" && (
        <CircleDeparture circle={circle} busy={busy} run={run} admin={admin} />
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
      {!circle.isAdmin && circle.role !== "joining" && (
        <Card>
          <Disclosure
            title="Troubleshooting"
            summary="Request a fresh membership if messages won’t open"
            initiallyOpen={circle.role === "removed"}
          >
            <Text style={[type.body, { color: colors.textSecondary }]}>
              After a temporary disconnection, reconnect and let this Circle catch up. If you
              restored an older backup, ask your admin to refresh connection keys. If your
              membership still cannot recover, use a fresh invite code below; messages from
              before the new membership will not be readable.
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
