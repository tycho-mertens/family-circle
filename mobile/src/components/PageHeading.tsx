import { Text, View } from "react-native";
import { useTheme } from "../theme";

export function PageHeading({
  eyebrow,
  title,
  body,
}: {
  eyebrow?: string;
  title: string;
  body?: string;
}) {
  const { colors, spacing, type } = useTheme();
  return (
    <View style={{ gap: spacing.sm, paddingTop: spacing.sm, paddingBottom: spacing.sm }}>
      {eyebrow && (
        <Text
          style={[
            type.tiny,
            { color: colors.accent, letterSpacing: 1.2, textTransform: "uppercase" },
          ]}
        >
          {eyebrow}
        </Text>
      )}
      <Text
        accessibilityRole="header"
        style={[type.display, { color: colors.textPrimary, letterSpacing: -0.45 }]}
      >
        {title}
      </Text>
      {body && <Text style={[type.body, { color: colors.textSecondary }]}>{body}</Text>}
    </View>
  );
}
