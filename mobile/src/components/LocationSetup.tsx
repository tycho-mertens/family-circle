import { NotificationSettings } from "./NotificationSettings";
import { useEffect, useState } from "react";
import { AppState, Pressable, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import Native from "../../modules/family-circle-bridge";
import { useTheme } from "../theme";
import { ScreenContainer } from "./ScreenContainer";
import { PageHeading } from "./PageHeading";
import { Card } from "./Card";
import { Button } from "./Button";
import { Disclosure } from "./Disclosure";
import { Notice } from "./Notice";
type Settings = ReturnType<typeof Native.locationSettingsStatus>;
export function LocationSetup({
  onDone,
  onboarding = false,
}: {
  onDone: () => void;
  onboarding?: boolean;
}) {
  const { colors, type } = useTheme();
  const [status, setStatus] = useState<Settings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refresh = () => {
    try {
      setStatus(Native.locationSettingsStatus());
    } catch {
      setError("Couldn't check phone settings. Reopen the app and try again.");
    }
  };
  useEffect(() => {
    refresh();
    const s = AppState.addEventListener("change", (v) => {
      if (v === "active") refresh();
    });
    return () => s.remove();
  }, []);
  const act = async (action: () => unknown) => {
    setBusy(true);
    setError(null);
    try {
      await action();
      refresh();
    } catch {
      setError("Open Android Settings → Apps → Family Circle to change this setting.");
    } finally {
      setBusy(false);
    }
  };
  const allowed = !!(status?.precise || status?.approximate);
  const ready = allowed && status?.locationEnabled && status?.notifications;
  const enable = () =>
    act(async () => {
      if (!allowed && !(await Native.requestLocationPermission())) {
        setError(
          "Location access is optional. If Android no longer asks, tap Location below to open app settings.",
        );
        return;
      }
      if (!status?.notifications) await Native.requestNotificationPermission();
      if (!status?.locationEnabled) Native.openLocationSettings("location");
    });
  const rows = [
    {
      title: "Location",
      detail: status?.precise
        ? "Precise access"
        : status?.approximate
          ? "Approximate access"
          : "Permission needed",
      ok: allowed,
      icon: "location-outline" as const,
      action: () => Native.openLocationSettings("app"),
    },
    {
      title: "Location services",
      detail: status?.locationEnabled ? "Switched on" : "Switched off",
      ok: !!status?.locationEnabled,
      icon: "navigate-outline" as const,
      action: () => Native.openLocationSettings("location"),
    },
    {
      title: "Notifications",
      detail: status?.notifications ? "Sharing controls visible" : "Allow to see the Stop action",
      ok: !!status?.notifications,
      icon: "notifications-outline" as const,
      action: () => Native.openLocationSettings("notifications"),
    },
  ];
  return (
    <ScreenContainer>
      <View
        style={{
          width: 64,
          height: 64,
          borderRadius: 22,
          backgroundColor: colors.accentMuted,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Ionicons name="location-outline" size={30} color={colors.accent} />
      </View>
      <PageHeading
        eyebrow={onboarding ? "Last step · Optional" : "Phone settings"}
        title={ready ? "Ready when you are" : "Location, on your terms"}
        body="Choose who can see you inside each Circle. Sharing continues while your screen is locked."
      />
      {onboarding && <NotificationSettings />}
      <Card>
        {rows.map((row) => (
          <Pressable
            key={row.title}
            accessibilityRole="button"
            accessibilityLabel={`${row.title}: ${row.detail}`}
            disabled={busy}
            onPress={() => act(row.action)}
            style={{ minHeight: 68, flexDirection: "row", alignItems: "center", gap: 12 }}
          >
            <Ionicons name={row.icon} size={22} color={colors.accent} />
            <View style={{ flex: 1, gap: 3 }}>
              <Text style={[type.subtitle, { color: colors.textPrimary }]}>{row.title}</Text>
              <Text style={[type.caption, { color: colors.textSecondary }]}>
                {status ? row.detail : "Checking…"}
              </Text>
            </View>
            <Ionicons
              name={row.ok ? "checkmark-circle" : "chevron-forward"}
              size={22}
              color={row.ok ? colors.success : colors.textSecondary}
            />
          </Pressable>
        ))}
      </Card>
      <Text style={[type.body, { color: colors.textSecondary }]}>
        Choose “While using the app” when Android asks. Granting permission does not start sharing.
      </Text>
      <Notice text={error} />
      <Button
        title={ready ? (onboarding ? "Meet your Circles" : "Done") : "Set up location"}
        loading={busy}
        disabled={!status}
        fullWidth
        onPress={ready ? onDone : enable}
      />
      {!ready && (
        <Button
          title={onboarding ? "Maybe later" : "Done for now"}
          variant="ghost"
          fullWidth
          disabled={busy}
          onPress={onDone}
        />
      )}
      <Card>
        <Disclosure
          title="Background & advanced settings"
          summary={
            status?.batteryUnrestricted
              ? "Battery optimization off"
              : "Battery, accuracy and troubleshooting"
          }
        >
          <Text style={[type.subtitle, { color: colors.textPrimary }]}>
            More reliable location updates
          </Text>
          <Text style={[type.body, { color: colors.textSecondary }]}>
            If location updates pause while sharing, you can try Unrestricted in Android battery
            settings. This may use more battery. The direct background notification connection also
            benefits from unrestricted battery access.
          </Text>
          <Button
            title="Review battery settings"
            variant="secondary"
            onPress={() => act(() => Native.openLocationSettings("battery"))}
          />
          <Text style={[type.body, { color: colors.textSecondary }]}>
            Precise access gives a more useful pin. Approximate access shares a wider area. Change
            this in Location above.
          </Text>
          <Text style={[type.caption, { color: colors.textSecondary }]}>
            Start sharing from a Circle's Map tab. After force stop or reboot, reopen the app to
            resume. GPS, phone restrictions and connectivity can delay updates. Offline devices show
            the last known position and its time.
          </Text>
        </Disclosure>
      </Card>
    </ScreenContainer>
  );
}
