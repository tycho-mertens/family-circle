import { useState, type PropsWithChildren } from "react";
import { Pressable, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useTheme } from "../theme";
export function Disclosure({
  title,
  summary,
  children,
  initiallyOpen = false,
}: PropsWithChildren<{ title: string; summary?: string; initiallyOpen?: boolean }>) {
  const [open, setOpen] = useState(initiallyOpen);
  const { colors, type, spacing } = useTheme();
  return (
    <View style={{ gap: open ? spacing.md : 0 }}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={title}
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(!open)}
        android_ripple={{ color: colors.border }}
        style={{
          minHeight: 52,
          flexDirection: "row",
          alignItems: "center",
          gap: 12,
          borderRadius: 12,
          overflow: "hidden",
          paddingHorizontal: 4,
        }}
      >
        <View style={{ flex: 1, gap: 4 }}>
          <Text style={[type.subtitle, { color: colors.textPrimary }]}>{title}</Text>
          {summary && (
            <Text style={[type.caption, { color: colors.textSecondary }]}>{summary}</Text>
          )}
        </View>
        <Ionicons
          name={open ? "chevron-up" : "chevron-down"}
          size={18}
          color={colors.textSecondary}
        />
      </Pressable>
      {open && children}
    </View>
  );
}
