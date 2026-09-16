import { Ionicons } from "@expo/vector-icons";
import type { PropsWithChildren } from "react";
import { Text, View } from "react-native";
import { useTheme } from "../theme";

interface Props {
  icon?: string;
  title: string;
  body?: string;
}

/** Empty-state message with optional actions below the text. */
export function EmptyState({ icon, title, body, children }: PropsWithChildren<Props>) {
  const { colors, spacing, type } = useTheme();
  return (
    <View
      style={{
        alignItems: "center",
        gap: spacing.md,
        paddingVertical: spacing.xxxl,
        paddingHorizontal: spacing.lg,
      }}
    >
      <View
        style={{
          width: 64,
          height: 64,
          borderRadius: 22,
          backgroundColor: colors.accentMuted,
          alignItems: "center",
          justifyContent: "center",
          marginBottom: 4,
        }}
      >
        {icon ? (
          <Text style={{ fontSize: 32 }}>{icon}</Text>
        ) : (
          <Ionicons name="chatbubbles-outline" size={28} color={colors.accent} />
        )}
      </View>
      <Text style={[type.title, { color: colors.textPrimary, textAlign: "center" }]}>{title}</Text>
      {body && (
        <Text
          style={[type.body, { color: colors.textSecondary, textAlign: "center", maxWidth: 280 }]}
        >
          {body}
        </Text>
      )}
      {children && <View style={{ marginTop: spacing.sm }}>{children}</View>}
    </View>
  );
}
