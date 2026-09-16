import { Ionicons } from "@expo/vector-icons";
import { Pressable, Text, View } from "react-native";
import { useTheme } from "../theme";
export function SettingsLink({
  title,
  subtitle,
  icon,
  onPress,
}: {
  title: string;
  subtitle?: string;
  icon: React.ComponentProps<typeof Ionicons>["name"];
  onPress: () => void;
}) {
  const { colors, type } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={title}
      onPress={onPress}
      android_ripple={{ color: colors.border }}
      style={({ pressed }) => ({
        minHeight: 56,
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        paddingHorizontal: 4,
        paddingVertical: 8,
        borderRadius: 14,
        overflow: "hidden",
        backgroundColor: pressed ? colors.surfaceAlt : "transparent",
      })}
    >
      <View
        style={{
          width: 30,
          height: 30,
          borderRadius: 10,
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: colors.accentMuted,
        }}
      >
        <Ionicons name={icon} size={17} color={colors.accent} />
      </View>
      <View style={{ flex: 1, gap: 3 }}>
        <Text style={[type.subtitle, { color: colors.textPrimary }]}>{title}</Text>
        {subtitle && (
          <Text style={[type.caption, { color: colors.textSecondary }]}>{subtitle}</Text>
        )}
      </View>
      <Ionicons name="chevron-forward" size={17} color={colors.textSecondary} />
    </Pressable>
  );
}
