import { SectionHeading } from "./SectionHeading";
import { Disclosure } from "./Disclosure";
import { SettingsLink } from "./SettingsLink";
import { router } from "expo-router";
import { useEffect, useState } from "react";
import { AppState, Text } from "react-native";
import Native from "../../modules/family-circle-bridge";
import { useTheme } from "../theme";
import { Card } from "./Card";
import { Button } from "./Button";

export function NotificationSettings() {
  const { colors, type } = useTheme();
  const [status, setStatus] = useState<ReturnType<
    typeof Native.backgroundNotificationStatus
  > | null>(null);
  const [busy, setBusy] = useState(false);
  const refresh = () => {
    try {
      setStatus(Native.backgroundNotificationStatus());
    } catch {
      setStatus(null);
    }
  };
  useEffect(() => {
    refresh();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") refresh();
    });
    const timer = setInterval(refresh, 5000);
    return () => {
      subscription.remove();
      clearInterval(timer);
    };
  }, []);
  const enable = async () => {
    setBusy(true);
    try {
      Native.createEventsChannel();
      if (await Native.requestNotificationPermission())
        Native.setBackgroundNotificationsEnabled(true);
      else Native.openLocationSettings("notifications");
      refresh();
    } catch {
      Native.openLocationSettings("notifications");
    } finally {
      setBusy(false);
    }
  };
  const message = !status
    ? "Checking notification settings…"
    : !status.allowed
      ? "Get messages and location-sharing alerts, even when you aren't sharing your own location."
      : !status.enabled
        ? "Background notifications are paused. Open the app to check for updates."
        : !status.configured
          ? "Ready for your first Circle. Messages and sharing alerts will arrive through a direct connection."
          : !status.running
            ? "Starting the background connection…"
            : status.connected
              ? "You’re connected. Get messages and sharing alerts while the app is closed."
              : "Waiting for your Circle server. We'll reconnect automatically.";
  const enabled = status?.allowed && status?.enabled;
  return (
    <Card>
      <SectionHeading
        title="Notifications"
        icon="notifications-outline"
        detail={enabled ? "Enabled" : "Paused"}
      />
      <Text style={[type.body, { color: colors.textSecondary }]}>{message}</Text>

      <Button
        title={enabled ? "Pause background notifications" : "Enable notifications"}
        variant="secondary"
        loading={busy}
        onPress={
          enabled
            ? () => {
                Native.setBackgroundNotificationsEnabled(false);
                refresh();
              }
            : () => {
                void enable();
              }
        }
      />
      {enabled && !status?.batteryUnrestricted && (
        <>
          <Text style={[type.body, { color: colors.textSecondary }]}>
            Allow unrestricted battery use for reliable alerts while your phone is idle. This may
            use more battery.
          </Text>
          <Button
            title="Allow background connection"
            variant="secondary"
            onPress={() => Native.requestNotificationBatteryAccess()}
          />
        </>
      )}
      {enabled && status?.batteryUnrestricted && (
        <Text style={[type.caption, { color: colors.success }]}>
          Unrestricted battery access is enabled.
        </Text>
      )}
      <Disclosure title="Notification options" summary="Connection checks and Android settings">
        <Text style={[type.caption, { color: colors.textSecondary }]}>
          A quiet connection notification stays visible while listening for activity.
        </Text>
        <SettingsLink
          title="Connection checks"
          icon="pulse-outline"
          onPress={() => router.push("/connection")}
        />
        <SettingsLink
          title="Android notification settings"
          icon="settings-outline"
          onPress={() => Native.openLocationSettings("notifications")}
        />
      </Disclosure>
    </Card>
  );
}
