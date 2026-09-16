import { Ionicons } from "@expo/vector-icons";
import { Text, View } from "react-native";
import { useTheme } from "../theme";

export function SectionHeading({
  title,
  icon,
  detail,
}: {
  title: string;
  icon: React.ComponentProps<typeof Ionicons>["name"];
  detail?: string;
}) {
  const { colors, type } = useTheme();
  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 10, marginBottom: 4 }}>
      <View
        style={{
          width: 32,
          height: 32,
          borderRadius: 10,
          backgroundColor: colors.accentMuted,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <Ionicons name={icon} size={18} color={colors.accent} />
      </View>
      <Text
        accessibilityRole="header"
        style={[type.subtitle, { color: colors.textPrimary, flex: 1 }]}
      >
        {title}
      </Text>
      {detail && <Text style={[type.caption, { color: colors.textSecondary }]}>{detail}</Text>}
    </View>
  );
}
