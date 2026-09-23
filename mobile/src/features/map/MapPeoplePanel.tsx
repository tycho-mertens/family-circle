import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { Animated, Pressable, ScrollView, Text, View } from "react-native";
import { Avatar } from "../../components/Avatar";
import { Button } from "../../components/Button";
import { IconButton } from "../../components/IconButton";
import { Notice } from "../../components/Notice";
import type { LocationPin } from "../../location";
import { possiblyOffline } from "../../location-freshness";
import { useIdentity } from "../../state/identity";
import { useLocations } from "../../state/locations";
import type { Role } from "../../runtime/circle-types";
import { useTheme } from "../../theme";
import type { useDistanceLocation } from "../../use-distance-location";
import type { usePeoplePanel } from "./usePeoplePanel";
import { OfflineBadge } from "./OfflineBadge";
import { age } from "./pin-presentation";

interface Props {
  circleId: string;
  role: Role;
  pins: LocationPin[];
  selected: string | null;
  now: number;
  distance: ReturnType<typeof useDistanceLocation>;
  panel: ReturnType<typeof usePeoplePanel>;
  overviewOnly: boolean;
  mapFailed: boolean;
  away: (pin: LocationPin) => string | null;
  focus: (pin: LocationPin) => void;
  onOpenSharing: () => void;
}

export function MapPeoplePanel({
  circleId,
  role,
  pins,
  selected,
  now,
  distance,
  panel,
  overviewOnly,
  mapFailed,
  away,
  focus,
  onOpenSharing,
}: Props) {
  const { deviceId, nicknames, profilePhotos } = useIdentity();
  const { colors, type, radii } = useTheme();
  const locations = useLocations();
  const { peopleCollapsed, panelHeight, peoplePanelGesture } = panel;
  const name = (pin: LocationPin) => nicknames[pin.senderId] ?? "Circle member";
  const share = locations.state.shares.find((share) => share.circleId === circleId);
  const active = !!share?.active;
  const pendingStop = locations.state.pending.some(
    (pending) => pending.stopped && pending.sessionId === share?.sessionId,
  );
  const stopTime = share?.expiresAt
    ? new Date(share.expiresAt).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit",
      })
    : null;
  return (
    <Animated.View
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        bottom: 0,
        height: panelHeight,
        backgroundColor: colors.surface,
        borderTopLeftRadius: 28,
        borderTopRightRadius: 28,
        overflow: "hidden",
        shadowColor: "#000",
        shadowOpacity: 0.12,
        shadowRadius: 14,
        shadowOffset: { width: 0, height: -4 },
        elevation: 8,
      }}
    >
      <View
        {...peoplePanelGesture.panHandlers}
        accessibilityLabel={
          peopleCollapsed
            ? "Drag up to show the people list"
            : "Drag down to hide the people list"
        }
        style={{ height: 20, alignItems: "center", justifyContent: "center" }}
      >
        <View
          style={{
            width: 38,
            height: 4,
            borderRadius: 4,
            backgroundColor: colors.border,
          }}
        />
      </View>
      <View
        style={{
          paddingHorizontal: 20,
          paddingTop: peopleCollapsed ? 6 : 10,
          paddingBottom: peopleCollapsed ? 10 : 16,
          flexDirection: "row",
          alignItems: "center",
          gap: 12,
          borderBottomWidth: peopleCollapsed ? 0 : 1,
          borderColor: colors.border,
        }}
      >
        <View style={{ flex: 1, gap: 4 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
            <View
              style={{
                width: 7,
                height: 7,
                borderRadius: 4,
                backgroundColor: active ? colors.success : colors.textSecondary,
              }}
            />
            <Text style={[type.subtitle, { color: colors.textPrimary }]}>
              {active ? "You're sharing" : "Your location is private"}
            </Text>
          </View>
          <Text style={[type.caption, { color: colors.textSecondary }]}>
            {active
              ? `${stopTime ? `Until ${stopTime}` : "Until you stop"} · Every ${share!.interval / 60000} min`
              : "Share only when you choose"}
          </Text>
        </View>
        {active ? (
          <>
            <IconButton
              label="Sharing settings"
              icon="options-outline"
              onPress={() => onOpenSharing()}
            />
            <Button
              title="Stop"
              variant="danger"
              loading={locations.busy}
              onPress={() => locations.stop(circleId)}
            />
          </>
        ) : (
          <Button
            title="Share location"
            disabled={!locations.ready || locations.busy || role !== "member"}
            onPress={() => onOpenSharing()}
          />
        )}
      </View>
      {!peopleCollapsed && (
        <ScrollView
          keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ paddingHorizontal: 20, paddingVertical: 14, gap: 12 }}
        >
          {(locations.error || mapFailed || distance.error || pendingStop) && (
            <Notice
              text={
                pendingStop
                  ? "Stopped here. Removing your pin when connected."
                  : (locations.error ??
                    distance.error ??
                    "Map couldn't load. Locations are listed below.")
              }
            />
          )}
          {active && locations.nativeStatus && <Notice text={locations.nativeStatus} />}
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
            }}
          >
            <Text style={[type.subtitle, { color: colors.textPrimary }]}>
              People · {pins.length} sharing
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Location settings"
              onPress={() => router.push("/(app)/location-settings")}
              style={{ minHeight: 32, justifyContent: "center" }}
            >
              <Text style={[type.caption, { color: colors.accent }]}>Phone settings</Text>
            </Pressable>
          </View>
          {pins.length === 0 && (
            <Text style={[type.body, { color: colors.textSecondary }]}>
              Shared locations will appear here. Everyone controls their own sharing.
            </Text>
          )}
          {pins.map((p) => (
            <Pressable
              key={p.sessionId}
              accessibilityRole="button"
              accessibilityLabel={`Find ${name(p)}`}
              onPress={() => focus(p)}
              accessibilityState={{ selected: selected === p.sessionId }}
              style={({ pressed }) => ({
                flexDirection: "row",
                alignItems: "center",
                gap: 12,
                minHeight: 60,
                paddingHorizontal: 8,
                borderRadius: radii.md,
                backgroundColor:
                  pressed || selected === p.sessionId ? colors.surfaceAlt : "transparent",
              })}
            >
              <Avatar
                name={nicknames[p.senderId]}
                photo={profilePhotos[p.senderId]}
                size={40}
              />
              <View style={{ flex: 1, gap: 4 }}>
                <Text style={[type.subtitle, { color: colors.textPrimary }]}>
                  {name(p)}
                  {p.senderId === deviceId ? " · You" : ""}
                </Text>
                {possiblyOffline(p.fix, now) && <OfflineBadge />}
                <Text style={[type.caption, { color: colors.textSecondary }]}>
                  {age(p.fix!.observedAt, now)}
                  {p.fix!.batteryPercent != null
                    ? ` · Battery ${p.fix!.batteryPercent}%`
                    : ""}
                </Text>
              </View>
              <Text style={[type.subtitle, { color: colors.accent }]}>
                {away(p) ?? (p.senderId === deviceId ? "" : "—")}
              </Text>
              <Ionicons name="chevron-forward" size={16} color={colors.textSecondary} />
            </Pressable>
          ))}
          <Text style={[type.tiny, { color: colors.textSecondary }]}>
            {distance.origin
              ? `Approximate straight-line distances · Your position: ${age(distance.origin.observedAt, now).toLowerCase()}`
              : distance.busy
                ? "Calculating distances…"
                : "Enable location or tap locate to calculate distances."}
            {overviewOnly ? " · Overview map only" : ""}
          </Text>
        </ScrollView>
      )}
    </Animated.View>
  );
}
