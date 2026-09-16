import { Pressable, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useTheme } from "../theme";
export function Choice({
  title,
  selected,
  onPress,
}: {
  title: string;
  selected: boolean;
  onPress: () => void;
}) {
  const { colors } = useTheme();
  return (
    <View style={{ minHeight: 48, justifyContent: "center", maxWidth: "100%" }}>
      <Pressable
        accessibilityRole="radio"
        accessibilityLabel={title}
        accessibilityState={{ checked: selected }}
        onPress={onPress}
        hitSlop={{ top: 6, bottom: 6 }}
        android_ripple={{ color: colors.border }}
        style={({ pressed }) => ({
          minHeight: 36,
          paddingHorizontal: 12,
          paddingVertical: 7,
          flexDirection: "row",
          gap: 6,
          alignItems: "center",
          justifyContent: "center",
          borderRadius: 18,
          overflow: "hidden",
          borderWidth: 1,
          borderColor: selected ? colors.accentMuted : colors.border,
          backgroundColor: selected ? colors.accentMuted : colors.surface,
          opacity: pressed ? 0.75 : 1,
        })}
      >
        {selected && <Ionicons name="checkmark" size={16} color={colors.accent} />}
        <Text
          style={{
            fontSize: 14,
            lineHeight: 20,
            fontWeight: "500",
            flexShrink: 1,
            color: selected ? colors.accent : colors.textPrimary,
          }}
        >
          {title}
        </Text>
      </Pressable>
    </View>
  );
}
