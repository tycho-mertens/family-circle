import { BottomSheet } from "./BottomSheet";
import { useEffect, useState } from "react";
import { Switch, Text, View } from "react-native";
import { useTheme } from "../theme";
import { useLocations } from "../state/locations";
import { useCircles, circleLabel } from "../state/circles";
import { Button } from "./Button";
import { Choice } from "./Choice";
import { Disclosure } from "./Disclosure";
import { TextField } from "./TextField";
import { Notice } from "./Notice";

export function ShareLocationSheet({
  circleId,
  visible,
  onClose,
}: {
  circleId: string;
  visible: boolean;
  onClose: () => void;
}) {
  const { colors, type } = useTheme();
  const locations = useLocations();
  const { circles } = useCircles();
  const share = locations.state.shares.find((s) => s.circleId === circleId);
  const [duration, setDuration] = useState(60);
  const [frequency, setFrequency] = useState(2);
  const [battery, setBattery] = useState(true);
  const [custom, setCustom] = useState("120");
  useEffect(() => {
    if (visible) {
      setDuration(share?.active ? -2 : 60);
      setFrequency((share?.interval ?? 120000) / 60000);
      setBattery(share?.active ? share.reportBattery : true);
    }
  }, [visible]);
  const minutes = duration === -1 ? Number(custom) : duration;
  const valid =
    duration === -2 ||
    (Number.isInteger(minutes) &&
      minutes >= 0 &&
      minutes <= 43200 &&
      (duration !== -1 || minutes > 0));
  const submit = async () => {
    let ok: boolean;
    if (share?.active && duration === -2 && frequency * 60000 === share.interval)
      ok = await locations.setBattery(circleId, battery);
    else {
      const remaining =
        duration === -2
          ? share?.expiresAt
            ? Math.max(1, share.expiresAt - Date.now())
            : null
          : minutes === 0
            ? null
            : minutes * 60000;
      ok = await locations.start(circleId, frequency * 60000, remaining, battery);
    }
    if (ok) onClose();
  };
  const name = circles[circleId] ? circleLabel(circles[circleId]) : "your Circle";
  return (
    <BottomSheet
      visible={visible}
      title={share?.active ? "Sharing settings" : "Share your location"}
      subtitle={`With everyone in ${name}`}
      busy={locations.busy}
      onClose={onClose}
      footer={
        <Button
          title={share?.active ? "Save sharing settings" : "Start sharing"}
          fullWidth
          loading={locations.busy}
          disabled={!valid}
          onPress={submit}
        />
      }
    >
      <Text style={[type.subtitle, { color: colors.textPrimary }]}>For how long?</Text>
      <View
        accessibilityRole="radiogroup"
        style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}
      >
        {share?.active && (
          <Choice
            title="Keep current end time"
            selected={duration === -2}
            onPress={() => setDuration(-2)}
          />
        )}
        {[
          { title: "1 hour", value: 60 },
          { title: "8 hours", value: 480 },
          { title: "Until I stop", value: 0 },
        ].map((d) => (
          <Choice
            key={d.value}
            title={d.title}
            selected={duration === d.value}
            onPress={() => setDuration(d.value)}
          />
        ))}
      </View>
      <Text style={[type.caption, { color: colors.textSecondary }]}>
        Continues when your screen is locked. You can stop anytime.
      </Text>
      <View style={{ borderTopWidth: 1, borderColor: colors.border, paddingTop: 8 }}>
        <Disclosure
          title="More options"
          summary={`${duration === 15 ? "15 min · " : duration === 1440 ? "24 hours · " : duration === -1 ? `${custom} min · ` : ""}Every ${frequency} min · Battery ${battery ? "shared" : "private"}`}
        >
          <Text style={[type.subtitle, { color: colors.textPrimary }]}>Update interval</Text>
          <View
            accessibilityRole="radiogroup"
            style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}
          >
            {[1, 2, 5, 15, 30].map((f) => (
              <Choice
                key={f}
                title={`${f} min`}
                selected={frequency === f}
                onPress={() => setFrequency(f)}
              />
            ))}
          </View>
          <Text style={[type.caption, { color: colors.textSecondary }]}>
            Longer intervals save battery. Your fastest active Circle determines GPS use. Delivery
            can be delayed by your phone or connection.
          </Text>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
            <View style={{ flex: 1, gap: 4 }}>
              <Text style={[type.subtitle, { color: colors.textPrimary }]}>
                Share battery percentage
              </Text>
              <Text style={[type.caption, { color: colors.textSecondary }]}>
                Encrypted with your location
              </Text>
            </View>
            <Switch
              accessibilityLabel="Include battery percentage"
              value={battery}
              onValueChange={setBattery}
            />
          </View>
          <Text style={[type.subtitle, { color: colors.textPrimary }]}>Other durations</Text>
          <View
            accessibilityRole="radiogroup"
            style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}
          >
            {[
              { title: "15 minutes", value: 15 },
              { title: "24 hours", value: 1440 },
              { title: "Custom", value: -1 },
            ].map((d) => (
              <Choice
                key={d.value}
                title={d.title}
                selected={duration === d.value}
                onPress={() => setDuration(d.value)}
              />
            ))}
          </View>
          {duration === -1 && (
            <TextField
              label="Duration in minutes"
              value={custom}
              onChangeText={setCustom}
              keyboardType="number-pad"
              maxLength={5}
            />
          )}
          <Text style={[type.caption, { color: colors.textSecondary }]}>
            Custom duration: up to 30 days. Offline devices keep your last pin until they reconnect.
            Reopen the app after force stop or reboot.
          </Text>
        </Disclosure>
      </View>
      {locations.error && <Notice text={locations.error} />}
    </BottomSheet>
  );
}
