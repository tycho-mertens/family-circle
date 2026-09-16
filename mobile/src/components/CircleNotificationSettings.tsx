import { useEffect, useState } from "react";
import { Switch, Text, View } from "react-native";
import type { CircleInfo } from "../state/circles";
import { useCircles } from "../state/circles";
import { defaultNotifications } from "../notification-preferences";
import { useTheme } from "../theme";
import { Card } from "./Card";
import { Disclosure } from "./Disclosure";
import { TextField } from "./TextField";
import { Button } from "./Button";

export function CircleNotificationSettings({ circle }: { circle: CircleInfo }) {
  const { colors, type } = useTheme();
  const state = useCircles();
  const saved = circle.notifications ?? defaultNotifications;
  const [start, setStart] = useState(saved.quietStart);
  const [end, setEnd] = useState(saved.quietEnd);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    setStart(saved.quietStart);
    setEnd(saved.quietEnd);
  }, [saved.quietStart, saved.quietEnd]);
  const update = async (patch: Partial<typeof saved>) => {
    if (busy) return;
    setBusy(true);
    try {
      await state.setNotifications(circle.circleId, { ...saved, ...patch });
    } finally {
      setBusy(false);
    }
  };
  const validTimes =
    [start, end].every((time) => /^([01]\d|2[0-3]):[0-5]\d$/.test(time)) && start !== end;
  return (
    <Card>
      <Disclosure title="Circle notifications" summary="Chat, location alerts and quiet hours">
        <Text style={[type.caption, { color: colors.textSecondary }]}>
          These preferences apply to this Circle on this phone.
        </Text>
        {(
          [
            ["chat", "Chat messages"],
            ["location", "Location sharing alerts"],
            ["quietHours", "Quiet hours"],
          ] as const
        ).map(([key, label]) => (
          <View
            key={key}
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "space-between",
              gap: 12,
            }}
          >
            <Text style={[type.body, { color: colors.textPrimary, flex: 1 }]}>{label}</Text>
            <Switch
              accessibilityLabel={label}
              value={saved[key]}
              disabled={busy}
              onValueChange={(value) => {
                void update({ [key]: value });
              }}
              trackColor={{ true: colors.accent }}
            />
          </View>
        ))}
        {saved.quietHours && (
          <>
            <Text style={[type.caption, { color: colors.textSecondary }]}>
              Silence all alerts for this Circle during these hours. Messages still sync. Uses this
              phone's local time.
            </Text>
            <View style={{ flexDirection: "row", gap: 12 }}>
              <View style={{ flex: 1 }}>
                <TextField
                  label="From (24-hour)"
                  value={start}
                  onChangeText={setStart}
                  placeholder="22:00"
                  maxLength={5}
                />
              </View>
              <View style={{ flex: 1 }}>
                <TextField
                  label="Until (24-hour)"
                  value={end}
                  onChangeText={setEnd}
                  placeholder="08:00"
                  maxLength={5}
                />
              </View>
            </View>
            <Button
              title="Save quiet hours"
              variant="secondary"
              loading={busy}
              disabled={!validTimes || (start === saved.quietStart && end === saved.quietEnd)}
              onPress={() => {
                void update({ quietStart: start, quietEnd: end });
              }}
            />
          </>
        )}
      </Disclosure>
    </Card>
  );
}
