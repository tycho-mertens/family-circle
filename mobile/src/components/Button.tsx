import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useTheme } from "../theme";

type Variant = "primary" | "secondary" | "ghost" | "danger";
interface Props {
  title: string;
  onPress: () => void;
  variant?: Variant;
  disabled?: boolean;
  loading?: boolean;
  fullWidth?: boolean;
  icon?: React.ComponentProps<typeof Ionicons>["name"];
}

/** Compact 40dp surface inside a 48dp touch target. */
export function Button({
  title,
  onPress,
  variant = "primary",
  disabled,
  loading,
  fullWidth,
  icon,
}: Props) {
  const { colors } = useTheme();
  const isDisabled = !!(disabled || loading);
  const filled = variant === "primary" || variant === "danger";
  const bg =
    variant === "primary"
      ? colors.accent
      : variant === "danger"
        ? colors.danger
        : variant === "secondary"
          ? colors.accentMuted
          : "transparent";
  const fg = filled ? colors.textOnAccent : colors.accent;
  return (
    <View
      style={{
        minHeight: 48,
        justifyContent: "center",
        alignSelf: fullWidth ? "stretch" : "flex-start",
        maxWidth: "100%",
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={title}
        accessibilityState={{ disabled: isDisabled, busy: !!loading }}
        disabled={isDisabled}
        onPress={onPress}
        hitSlop={{ top: 4, bottom: 4 }}
        android_ripple={{ color: filled ? "#FFFFFF30" : colors.border }}
        style={({ pressed }) => ({
          minHeight: 40,
          paddingVertical: 10,
          paddingHorizontal: variant === "ghost" ? 12 : icon ? 16 : 20,
          borderRadius: 20,
          overflow: "hidden",
          backgroundColor: bg,
          flexDirection: "row",
          gap: 8,
          alignItems: "center",
          justifyContent: "center",
          opacity: loading ? 1 : disabled ? 0.38 : pressed ? 0.85 : 1,
        })}
      >
        {icon ? (
          <View style={{ width: 18, height: 20, alignItems: "center", justifyContent: "center" }}>
            {loading ? (
              <ActivityIndicator size="small" color={fg} />
            ) : (
              <Ionicons name={icon} size={18} color={fg} />
            )}
          </View>
        ) : loading ? (
          <ActivityIndicator size="small" color={fg} style={{ position: "absolute", left: 8 }} />
        ) : null}
        <Text
          style={{
            fontSize: 14,
            lineHeight: 20,
            fontWeight: "600",
            color: fg,
            textAlign: "center",
            flexShrink: 1,
          }}
        >
          {title}
        </Text>
      </Pressable>
    </View>
  );
}
