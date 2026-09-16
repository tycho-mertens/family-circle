import { ActivityIndicator, Pressable, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useTheme } from "../theme";

interface Props {
  label: string;
  icon: React.ComponentProps<typeof Ionicons>["name"];
  onPress: () => void;
  disabled?: boolean;
  plain?: boolean;
  filled?: boolean;
  loading?: boolean;
}
export function IconButton({
  label,
  icon,
  onPress,
  disabled = false,
  plain = false,
  filled = false,
  loading = false,
}: Props) {
  const { colors } = useTheme();
  const foreground = filled ? colors.textOnAccent : colors.textPrimary;
  return (
    <View style={{ width: 48, height: 48, alignItems: "center", justifyContent: "center" }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={label}
        disabled={disabled || loading}
        accessibilityState={{ disabled: disabled || loading, busy: loading }}
        onPress={onPress}
        hitSlop={4}
        android_ripple={{ color: filled ? "#FFFFFF30" : colors.border }}
        style={({ pressed }) => ({
          width: 40,
          height: 40,
          alignItems: "center",
          justifyContent: "center",
          borderRadius: 20,
          overflow: "hidden",
          backgroundColor: filled ? colors.accent : plain ? "transparent" : colors.surfaceAlt,
          opacity: disabled ? 0.38 : pressed ? 0.75 : 1,
        })}
      >
        {loading ? (
          <ActivityIndicator size="small" color={foreground} />
        ) : (
          <Ionicons name={icon} size={20} color={foreground} />
        )}
      </Pressable>
    </View>
  );
}
