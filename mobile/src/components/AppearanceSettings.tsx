import { useState } from "react";
import { Text, View } from "react-native";
import { useTheme, type ThemePreference } from "../theme";
import { Card } from "./Card";
import { Choice } from "./Choice";
import { Notice } from "./Notice";
import { SectionHeading } from "./SectionHeading";

const options: { label: string; value: ThemePreference }[] = [
  { label: "Light", value: "light" },
  { label: "Dark", value: "dark" },
  { label: "System", value: "system" },
];

export function AppearanceSettings() {
  const { colors, type, themePreference, setThemePreference } = useTheme();
  const [error, setError] = useState<string | null>(null);
  return (
    <Card>
      <SectionHeading title="Appearance" icon="contrast-outline" />
      <View
        accessibilityRole="radiogroup"
        accessibilityLabel="App theme"
        style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}
      >
        {options.map((option) => (
          <Choice
            key={option.value}
            title={option.label}
            selected={themePreference === option.value}
            onPress={() => {
              try {
                setThemePreference(option.value);
                setError(null);
              } catch {
                setError("Couldn't save appearance. Please try again.");
              }
            }}
          />
        ))}
      </View>
      <Text style={[type.caption, { color: colors.textSecondary }]}>
        {themePreference === "system"
          ? "Matches your phone’s light or dark appearance."
          : "Always uses the selected theme on this phone."}
      </Text>
      <Notice text={error} onDismiss={() => setError(null)} />
    </Card>
  );
}
