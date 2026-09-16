import { AppearanceSettings } from "../../src/components/AppearanceSettings";
import { NotificationSettings } from "../../src/components/NotificationSettings";
import { ServerAccess } from "../../src/components/ServerAccess";
import { useState } from "react";
import { Text, View } from "react-native";
import { router } from "expo-router";
import { useTheme } from "../../src/theme";
import { useIdentity, MAX_NICKNAME_LEN } from "../../src/state/identity";
import { useCircles } from "../../src/state/circles";
import { usePreferences } from "../../src/state/preferences";
import { ScreenContainer } from "../../src/components/ScreenContainer";
import { ProfilePhotoEditor } from "../../src/components/ProfilePhotoEditor";
import { Card } from "../../src/components/Card";
import { Button } from "../../src/components/Button";
import { Choice } from "../../src/components/Choice";
import { Disclosure } from "../../src/components/Disclosure";
import { TextField } from "../../src/components/TextField";
import { Notice } from "../../src/components/Notice";
import { PageHeading } from "../../src/components/PageHeading";
import { SectionHeading } from "../../src/components/SectionHeading";
import { SettingsLink } from "../../src/components/SettingsLink";

export default function Profile() {
  const { deviceId, nicknames, profilePhotos } = useIdentity();
  const { setNickname, setProfilePhoto, relayStatus } = useCircles();
  const { distanceUnit, setDistanceUnit } = usePreferences();
  const { colors, type } = useTheme();
  const [name, setName] = useState(nicknames[deviceId ?? ""] ?? "");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  return (
    <ScreenContainer headerShown={false}>
      <PageHeading title="Profile" body="Your name, photo and preferences." />
      <Card>
        <SectionHeading title="Your identity" icon="person-outline" />
        <ProfilePhotoEditor
          name={nicknames[deviceId ?? ""]}
          photo={profilePhotos[deviceId ?? ""]}
          onChange={setProfilePhoto}
        />
        <View style={{ borderTopWidth: 1, borderColor: colors.border, paddingTop: 8 }}>
          <Disclosure
            title="Edit your name"
            summary={nicknames[deviceId ?? ""] ?? "Choose a name your people recognize"}
          >
            <TextField
              label="Your nickname"
              value={name}
              onChangeText={setName}
              maxLength={MAX_NICKNAME_LEN}
            />
            <Button
              title="Save name"
              disabled={!name.trim() || name.trim() === (nicknames[deviceId ?? ""] ?? "")}
              loading={busy}
              onPress={async () => {
                setBusy(true);
                try {
                  await setNickname(name);
                  setFeedback("Name saved. Your Circles will see it when connected.");
                } catch {
                  setFeedback("Couldn't save your name. Please try again.");
                } finally {
                  setBusy(false);
                }
              }}
            />
          </Disclosure>
        </View>
        <Text style={[type.caption, { color: colors.textSecondary }]}>
          Shared privately across all your Circles.
        </Text>
      </Card>
      <Notice text={feedback} onDismiss={() => setFeedback(null)} />
      <AppearanceSettings />
      <NotificationSettings />
      <Card>
        <SectionHeading title="Location & maps" icon="map-outline" />
        <Text style={[type.caption, { color: colors.textSecondary }]}>Distance units</Text>
        <View
          accessibilityRole="radiogroup"
          style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}
        >
          {[
            { label: "Kilometres", value: "km" as const },
            { label: "Miles", value: "mi" as const },
          ].map((unit) => (
            <Choice
              key={unit.value}
              title={unit.label}
              selected={distanceUnit === unit.value}
              onPress={() => {
                try {
                  setDistanceUnit(unit.value);
                } catch {
                  setFeedback("Couldn't save distance units. Please try again.");
                }
              }}
            />
          ))}
        </View>
        <SettingsLink
          title="Location settings"
          subtitle="Permissions and background sharing"
          icon="navigate-outline"
          onPress={() => router.push("/(app)/location-settings")}
        />
      </Card>
      <Card>
        <SectionHeading title="Privacy & recovery" icon="shield-checkmark-outline" />
        <Text style={[type.caption, { color: colors.textSecondary }]}>
          Keep your saved 12-word recovery phrase safe. It is shown only during setup and is needed
          to restore your identity.
        </Text>
        <SettingsLink
          title="How recovery works"
          icon="key-outline"
          onPress={() => router.push("/(app)/how-it-works")}
        />
      </Card>
      <Card>
        <Disclosure
          title="Advanced"
          summary={
            relayStatus === "connected"
              ? "Connected to your server"
              : "Connection & device information"
          }
        >
          <SettingsLink
            title="Connection checks"
            subtitle="Sync status and notification test"
            icon="pulse-outline"
            onPress={() => router.push("/connection")}
          />
          <ServerAccess />
          <Text style={[type.caption, { color: colors.textSecondary }]}>Device identity</Text>
          <Text selectable style={[type.tiny, { color: colors.textSecondary }]}>
            {deviceId}
          </Text>
        </Disclosure>
      </Card>
    </ScreenContainer>
  );
}
