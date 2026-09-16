import { Avatar } from "../../src/components/Avatar";
import { BottomSheet } from "../../src/components/BottomSheet";
import { useEffect, useState } from "react";
import { Alert, Pressable, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { router, useLocalSearchParams } from "expo-router";
import { useTheme } from "../../src/theme";
import { useIdentity } from "../../src/state/identity";
import { useCircles, circleLabel } from "../../src/state/circles";
import { useLocations } from "../../src/state/locations";
import { ScreenContainer } from "../../src/components/ScreenContainer";
import { PageHeading } from "../../src/components/PageHeading";
import { Card } from "../../src/components/Card";
import { Button } from "../../src/components/Button";
import { IconButton } from "../../src/components/IconButton";
import { TextField } from "../../src/components/TextField";
import { Notice } from "../../src/components/Notice";
export default function CirclesHome() {
  const { inviteCode } = useLocalSearchParams<{ inviteCode?: string }>();
  const { colors, spacing, radii, type } = useTheme();
  const { deviceId, nicknames, profilePhotos } = useIdentity();
  const state = useCircles();
  const locations = useLocations();
  const [sheet, setSheet] = useState<"add" | "create" | "join" | null>(null);
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const all = Object.values(state.circles).filter((circle) => !circle.deleting);
  const active = locations.state.shares.filter((s) => s.active).length;
  const open = (kind: "add" | "create" | "join") => {
    state.clearNotice();
    setSheet(kind);
  };
  useEffect(() => {
    if (inviteCode) {
      setCode(inviteCode);
      setSheet("join");
      router.setParams({ inviteCode: undefined });
    }
  }, [inviteCode]);
  const submit = async () => {
    if (busy) return;
    setBusy(true);
    state.clearNotice();
    try {
      if (sheet === "create") {
        const id = await state.createCircle();
        if (!id) return;
        try {
          await state.setCircleName(id, name);
        } catch {
          /* Circle exists; its local name is saved and can be edited in settings. */
        }
        setSheet(null);
        setName("");
        router.push({ pathname: "/circle/[circleId]/manage", params: { circleId: id } });
      } else if (await state.joinCircle(code)) {
        const id = code.trim().split(".")[0];
        setCode("");
        setSheet(null);
        router.push({ pathname: "/circle/[circleId]", params: { circleId: id } });
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <ScreenContainer headerShown={false}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 16 }}>
        <View style={{ flex: 1 }}>
          <PageHeading
            title={
              nicknames[deviceId ?? ""] ? `Hi, ${nicknames[deviceId!]}` : "Your people, together"
            }
            body={
              all.length
                ? "A little closer, wherever you are."
                : "Create a private Circle or join with an invitation."
            }
          />
        </View>
        <Avatar name={nicknames[deviceId ?? ""]} photo={profilePhotos[deviceId ?? ""]} size={56} />
      </View>
      {active > 0 && (
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: 8,
            padding: 12,
            borderRadius: radii.md,
            backgroundColor: colors.accentMuted,
          }}
        >
          <Ionicons name="location" size={18} color={colors.accent} />
          <Text
            style={[type.caption, { color: colors.accent, flex: 1 }]}
          >{`Sharing location in ${active} ${active === 1 ? "Circle" : "Circles"}`}</Text>
          <Text style={[type.tiny, { color: colors.accent }]}>Active</Text>
        </View>
      )}
      {!all.length ? (
        <View style={{ flexDirection: "row", gap: 10 }}>
          <View style={{ flex: 1 }}>
            <Button title="New Circle" icon="add" fullWidth onPress={() => open("create")} />
          </View>
          <View style={{ flex: 1 }}>
            <Button
              title="Join a Circle"
              icon="enter-outline"
              fullWidth
              variant="secondary"
              onPress={() => open("join")}
            />
          </View>
        </View>
      ) : (
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "space-between",
            marginTop: 4,
          }}
        >
          <View>
            <Text accessibilityRole="header" style={[type.title, { color: colors.textPrimary }]}>
              Circles
            </Text>
            <Text style={[type.caption, { color: colors.textSecondary }]}>
              {all.length} {all.length === 1 ? "Circle" : "Circles"}
            </Text>
          </View>
          <Button title="Add" icon="add" variant="ghost" onPress={() => open("add")} />
        </View>
      )}
      <Notice text={state.notice} onDismiss={state.clearNotice} />
      {!all.length && (
        <Card style={{ paddingVertical: 32, alignItems: "center" }}>
          <Ionicons name="people-outline" size={42} color={colors.accent} />
          <Text style={[type.title, { color: colors.textPrimary }]}>
            A place for your closest people
          </Text>
          <Text style={[type.body, { color: colors.textSecondary, textAlign: "center" }]}>
            Chat privately. Share your location when you want to. Everyone stays in control.
          </Text>
        </Card>
      )}
      {all.map((circle) => {
        const sharing = locations.state.pins.filter(
          (p) => p.circleId === circle.circleId && p.fix && circle.members.includes(p.senderId),
        ).length;
        const latest = state.timeline
          .filter(
            (item) => item.circleId === circle.circleId && item.kind === "chat" && !item.deletedAt,
          )
          .at(-1);
        return (
          <Card key={circle.circleId} style={{ gap: 14 }}>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 4 }}>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Open ${circleLabel(circle)}`}
                onPress={() =>
                  router.push({
                    pathname: "/circle/[circleId]",
                    params: { circleId: circle.circleId },
                  })
                }
                style={{
                  flex: 1,
                  flexDirection: "row",
                  gap: 12,
                  alignItems: "center",
                  minHeight: 56,
                }}
              >
                <View
                  style={{
                    width: 48,
                    height: 48,
                    backgroundColor: colors.accentMuted,
                    borderRadius: 16,
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <Ionicons name="people-outline" size={21} color={colors.accent} />
                </View>
                <View style={{ flex: 1, gap: 4 }}>
                  <Text numberOfLines={2} style={[type.title, { color: colors.textPrimary }]}>
                    {circleLabel(circle)}
                  </Text>
                  <Text style={[type.caption, { color: colors.textSecondary }]}>
                    {circle.role === "joining"
                      ? "Waiting for your admin"
                      : circle.role === "removed"
                        ? "No longer a member"
                        : `${circle.members.length} members${circle.isCreator ? " · Admin" : ""}`}
                  </Text>
                </View>
                <Ionicons name="chevron-forward" size={20} color={colors.textSecondary} />
              </Pressable>
              <IconButton
                plain
                label={
                  circle.role === "joining"
                    ? `Cancel joining ${circleLabel(circle)}`
                    : `Delete ${circleLabel(circle)}`
                }
                icon="trash-outline"
                loading={deleting === circle.circleId}
                disabled={!!deleting}
                onPress={() => {
                  if (
                    (circle.isCreator && circle.members.length > 1) ||
                    (circle.handover && !circle.handover.confirmed)
                  ) {
                    router.push({
                      pathname: "/circle/[circleId]/manage",
                      params: { circleId: circle.circleId },
                    });
                    return;
                  }
                  Alert.alert(
                    circle.role === "joining"
                      ? "Cancel join request?"
                      : `Delete ${circleLabel(circle)}?`,
                    circle.role === "joining"
                      ? "Stop waiting for this invitation and remove the pending request from this phone. You can join again with a fresh invite code."
                      : "Leave this Circle, delete its chat history from this phone, and stop sharing your location. Your departure will sync when members reconnect." +
                          (circle.isCreator && circle.members.length > 1
                            ? " The next remaining member will become admin."
                            : circle.members.length <= 1
                              ? " You're the last member, so the Circle will be removed."
                              : ""),
                    [
                      { text: "Keep waiting", style: "cancel" },
                      {
                        text: circle.role === "joining" ? "Cancel request" : "Delete",
                        style: "destructive",
                        onPress: async () => {
                          setDeleting(circle.circleId);
                          state.clearNotice();
                          try {
                            await state.deleteCircle(circle.circleId);
                          } finally {
                            setDeleting(null);
                          }
                        },
                      },
                    ],
                  );
                }}
              />
            </View>
            {circle.role === "member" && (
              <View
                style={{ backgroundColor: colors.surfaceAlt, borderRadius: radii.md, padding: 12 }}
              >
                <Text numberOfLines={2} style={[type.caption, { color: colors.textSecondary }]}>
                  {latest
                    ? `${latest.senderId === deviceId ? "You" : (nicknames[latest.senderId ?? ""] ?? "Circle member")}: ${latest.text}`
                    : "Start the conversation. Say hello to your Circle."}
                </Text>
              </View>
            )}
            <View
              style={{
                borderTopWidth: 1,
                borderColor: colors.border,
                paddingTop: 8,
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 8,
              }}
            >
              <Button
                title="Chat"
                icon="chatbubble-outline"
                variant="ghost"
                onPress={() =>
                  router.push({
                    pathname: "/circle/[circleId]",
                    params: { circleId: circle.circleId },
                  })
                }
              />
              <Button
                title={sharing ? `Map · ${sharing} sharing` : "Map"}
                icon="map-outline"
                variant="ghost"
                onPress={() =>
                  router.push({
                    pathname: "/circle/[circleId]/map",
                    params: { circleId: circle.circleId },
                  })
                }
              />
            </View>
          </Card>
        );
      })}
      {Object.values(state.circles)
        .filter((circle) => circle.deleting)
        .map((circle) => (
          <Card key={`departure-${circle.circleId}`}>
            <Text style={[type.subtitle, { color: colors.textPrimary }]}>
              {circleLabel(circle)}
            </Text>
            <Text style={[type.body, { color: colors.textSecondary }]}>
              {circle.departureConfirmedAt
                ? "Departure confirmed. Your membership has been removed."
                : "Leaving… Waiting for the membership update. Keep the background connection enabled so this can finish when members reconnect."}
            </Text>
            {circle.departureConfirmedAt ? (
              <Button
                title="Dismiss"
                variant="ghost"
                onPress={() => {
                  void state.dismissDeparture(circle.circleId);
                }}
              />
            ) : (
              <Button
                title="Check connection"
                variant="ghost"
                onPress={() => router.push("/connection")}
              />
            )}
          </Card>
        ))}
      <BottomSheet
        visible={!!sheet}
        title={
          sheet === "add"
            ? "Add a Circle"
            : sheet === "create"
              ? "Start a Circle"
              : "Join your people"
        }
        subtitle={
          sheet === "add"
            ? "Create a new private space or join the people who invited you."
            : sheet === "create"
              ? "Give your people a space of their own."
              : "Use the invitation shared by your Circle’s admin."
        }
        busy={busy}
        onClose={() => setSheet(null)}
        footer={
          sheet === "add" ? undefined : (
            <Button
              title={sheet === "create" ? "Create Circle" : "Join Circle"}
              fullWidth
              loading={busy}
              disabled={sheet === "create" ? !name.trim() : !code.trim()}
              onPress={submit}
            />
          )
        }
      >
        {sheet === "add" ? (
          <>
            <Button title="New Circle" icon="add" fullWidth onPress={() => setSheet("create")} />
            <Button
              title="Join with an invite"
              icon="enter-outline"
              variant="secondary"
              fullWidth
              onPress={() => setSheet("join")}
            />
          </>
        ) : sheet === "create" ? (
          <TextField
            label="Circle name"
            placeholder="Family, Friends, Weekend crew…"
            value={name}
            onChangeText={setName}
            maxLength={60}
            autoCapitalize="words"
          />
        ) : (
          <>
            <TextField
              label="Invite code"
              placeholder="Paste your invitation"
              value={code}
              onChangeText={setCode}
              autoCapitalize="none"
              autoCorrect={false}
              multiline
            />
            <Button
              title="Scan invitation QR code"
              icon="scan-outline"
              variant="ghost"
              onPress={() => router.push("/(app)/scan-invite" as never)}
            />
            <Text style={[type.caption, { color: colors.textSecondary }]}>
              Ask your admin to keep their app open while you join.
            </Text>
          </>
        )}
        <Notice text={state.notice} />
      </BottomSheet>
    </ScreenContainer>
  );
}
