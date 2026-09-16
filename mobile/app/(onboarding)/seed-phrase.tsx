import { useState } from "react";
import { Pressable, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useIdentity } from "../../src/state/identity";
import { useTheme } from "../../src/theme";
import { ScreenContainer } from "../../src/components/ScreenContainer";
import { PageHeading } from "../../src/components/PageHeading";
import { Button } from "../../src/components/Button";
import { Notice } from "../../src/components/Notice";

export default function SeedPhrase() {
  const { createdIdentity, saveSeedPhraseToFile, confirmSeedPhraseSaved, setupError } =
    useIdentity();
  const [saved, setSaved] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [savedFileNotice, setSavedFileNotice] = useState<string | null>(null);
  const { colors, spacing, radii, type } = useTheme();
  if (!createdIdentity) return null;
  return (
    <ScreenContainer>
      <PageHeading
        eyebrow="Just for you"
        title="Your way back in."
        body="Write these words down in this order and keep them somewhere private. Anyone with this phrase can restore your identity."
      />
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: spacing.sm }}>
        {createdIdentity.seedPhrase.split(" ").map((word, i) => (
          <View
            key={i}
            style={{
              flexBasis: "46%",
              flexGrow: 1,
              flexDirection: "row",
              gap: spacing.md,
              padding: spacing.md,
              backgroundColor: colors.surface,
              borderRadius: radii.md,
              borderWidth: 1,
              borderColor: colors.border,
            }}
          >
            <Text style={[type.caption, { color: colors.textSecondary }]}>
              {String(i + 1).padStart(2, "0")}
            </Text>
            <Text selectable style={[type.subtitle, { color: colors.textPrimary }]}>
              {word}
            </Text>
          </View>
        ))}
      </View>
      <Button
        title="Download as a text file"
        variant="secondary"
        loading={sharing}
        onPress={async () => {
          setSharing(true);
          setSavedFileNotice(null);
          try {
            if (await saveSeedPhraseToFile())
              setSavedFileNotice("Saved in your phone's Downloads folder.");
          } finally {
            setSharing(false);
          }
        }}
      />
      <Text style={[type.caption, { color: colors.textSecondary }]}>
        This is the only time the app can show your phrase. The download is plain text in your
        phone's Downloads folder — move it somewhere private or write it down.
      </Text>
      <Pressable
        accessibilityRole="checkbox"
        accessibilityLabel="I've saved my recovery phrase somewhere safe"
        accessibilityState={{ checked: saved }}
        onPress={() => setSaved(!saved)}
        style={{ flexDirection: "row", gap: spacing.md, alignItems: "center", minHeight: 48 }}
      >
        <Ionicons name={saved ? "checkbox" : "square-outline"} size={28} color={colors.accent} />
        <Text style={[type.body, { flex: 1, color: colors.textPrimary }]}>
          I've saved my recovery phrase somewhere safe.
        </Text>
      </Pressable>
      <Notice text={setupError ?? savedFileNotice} />
      <Button
        title="I've saved it — continue"
        fullWidth
        disabled={!saved || sharing}
        onPress={confirmSeedPhraseSaved}
      />
    </ScreenContainer>
  );
}
