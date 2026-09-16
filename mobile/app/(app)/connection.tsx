import { useEffect, useState } from "react";
import { AppState, Text } from "react-native";
import Native from "../../modules/family-circle-bridge";
import { useCircles, circleLabel } from "../../src/state/circles";
import { useTheme } from "../../src/theme";
import { ScreenContainer } from "../../src/components/ScreenContainer";
import { PageHeading } from "../../src/components/PageHeading";
import { Card } from "../../src/components/Card";
import { Button } from "../../src/components/Button";
import { Notice } from "../../src/components/Notice";

export default function Connection() {
  const { colors, type } = useTheme();
  const state = useCircles();
  const [status, setStatus] = useState<ReturnType<
    typeof Native.backgroundNotificationStatus
  > | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const refresh = () => {
      try {
        setStatus(Native.backgroundNotificationStatus());
      } catch {
        setStatus(null);
      }
    };
    refresh();
    const timer = setInterval(refresh, 3000);
    const listener = AppState.addEventListener("change", refresh);
    return () => {
      clearInterval(timer);
      listener.remove();
    };
  }, []);
  const test = async () => {
    setBusy(true);
    try {
      Native.createEventsChannel();
      if (!(await Native.requestNotificationPermission())) {
        setFeedback(
          "Notifications are blocked. Allow them in Android notification settings, then try again.",
        );
        return;
      }
      Native.showNotification(
        "Family Circle · Test notification",
        "Notifications can appear on this phone. You're all set for local alerts.",
      );
      setFeedback(
        "Test notification sent to Android. Check your notification shade. This checks local alerts; it does not test delivery from another phone or bypass Android's Do Not Disturb.",
      );
    } catch {
      setFeedback("Could not show a test notification. Check Android notification settings.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <ScreenContainer>
      <PageHeading
        title="Connection & notifications"
        body="Check what is keeping your Circles up to date."
      />
      <Card>
        <Text style={[type.title, { color: colors.textPrimary }]}>Background connection</Text>
        <Text style={[type.body, { color: colors.textSecondary }]}>
          {!status
            ? "Status unavailable"
            : !status.enabled
              ? "Paused"
              : !status.configured
                ? "Ready — join a Circle to connect"
                : status.connected
                  ? "Connected to your Circle server"
                  : status.running
                    ? "Reconnecting to your Circle server"
                    : "Background listener is stopped"}
        </Text>
        <Text style={[type.body, { color: colors.textSecondary }]}>
          {"Notifications: "}
          {status ? (status.allowed ? "Allowed" : "Blocked in Android") : "Checking…"}
        </Text>
        <Text style={[type.body, { color: colors.textSecondary }]}>
          {"Battery use: "}
          {status
            ? status.batteryUnrestricted
              ? "Unrestricted"
              : "Restricted or optimized"
            : "Checking…"}
        </Text>
        <Text style={[type.caption, { color: colors.textSecondary }]}>
          Circle mute settings and quiet hours are in each Circle's settings. Android's Do Not
          Disturb can also silence alerts.
        </Text>
        {status && !status.enabled && (
          <Button
            title="Resume background connection"
            variant="secondary"
            onPress={() => Native.setBackgroundNotificationsEnabled(true)}
          />
        )}
        {status && !status.batteryUnrestricted && (
          <Button
            title="Allow background connection"
            variant="secondary"
            onPress={() => Native.requestNotificationBatteryAccess()}
          />
        )}
        <Button
          title="Android notification settings"
          variant="ghost"
          onPress={() => Native.openLocationSettings("notifications")}
        />
      </Card>
      <Card>
        <Text style={[type.title, { color: colors.textPrimary }]}>Last successful Circle sync</Text>
        {Object.values(state.circles)
          .filter((circle) => !circle.departureConfirmedAt)
          .map((circle) => (
            <Text key={circle.circleId} style={[type.body, { color: colors.textSecondary }]}>
              {circleLabel(circle)}
              {" · "}
              {circle.lastSuccessfulSync
                ? new Date(circle.lastSuccessfulSync).toLocaleString()
                : "No successful sync recorded yet"}
              {circle.syncError ? " · Needs attention in Circle settings" : ""}
            </Text>
          ))}
        {!Object.keys(state.circles).length && (
          <Text style={[type.body, { color: colors.textSecondary }]}>
            Join or create a Circle to start syncing.
          </Text>
        )}
        <Button
          title="Sync now"
          variant="secondary"
          loading={busy}
          onPress={async () => {
            if (busy) return;
            setBusy(true);
            setFeedback(null);
            try {
              await state.pollNow();
              setFeedback(
                "Sync check finished. See each Circle's last successful sync above; offline Circles retry automatically.",
              );
            } catch {
              setFeedback(
                "Sync could not finish. Check your internet connection and Circle server.",
              );
            } finally {
              setBusy(false);
            }
          }}
        />
      </Card>
      <Button
        title="Test notification"
        loading={busy}
        onPress={() => {
          void test();
        }}
      />
      <Notice text={feedback} />
    </ScreenContainer>
  );
}
