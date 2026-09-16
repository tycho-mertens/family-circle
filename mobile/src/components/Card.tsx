import type { PropsWithChildren } from "react";
import { View, type ViewStyle } from "react-native";
import { useTheme } from "../theme";

/** Themed surface for grouped content. */
export function Card({ children, style }: PropsWithChildren<{ style?: ViewStyle }>) {
  const { colors, radii, spacing } = useTheme();
  return (
    <View
      style={[
        {
          backgroundColor: colors.surface,
          borderRadius: radii.lg,
          padding: 20,
          gap: spacing.md,
          shadowColor: "#0B1B13",
          shadowOpacity: 0.06,
          shadowRadius: 12,
          shadowOffset: { width: 0, height: 3 },
          elevation: 1,
        },
        style,
      ]}
    >
      {children}
    </View>
  );
}
