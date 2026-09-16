import { View } from "react-native";
import { useTheme } from "../theme";

/** Onboarding intro dots — active slide filled, others muted. */
export function SlideIndicator({ count, active }: { count: number; active: number }) {
  const { colors, spacing } = useTheme();
  return (
    <View style={{ flexDirection: "row", gap: spacing.xs, justifyContent: "center" }}>
      {Array.from({ length: count }, (_, i) => (
        <View
          key={i}
          style={{
            width: i === active ? 20 : 8,
            height: 8,
            borderRadius: 4,
            backgroundColor: i === active ? colors.accent : colors.border,
          }}
        />
      ))}
    </View>
  );
}
