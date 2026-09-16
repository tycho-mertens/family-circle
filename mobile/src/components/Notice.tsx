import { Ionicons } from "@expo/vector-icons";
import { Text, View } from "react-native";
import { useTheme } from "../theme";
import { IconButton } from "./IconButton";

export function Notice({ text, onDismiss }: { text: string | null; onDismiss?: () => void }) {
  const { colors, radii, type } = useTheme();
  if (!text) return null;
  return (
    <View
      accessibilityLiveRegion="polite"
      style={{
        padding: 12,
        gap: 10,
        flexDirection: "row",
        alignItems: "flex-start",
        borderRadius: radii.md,
        backgroundColor: colors.surfaceAlt,
        borderLeftWidth: 3,
        borderLeftColor: colors.accent,
      }}
    >
      <Ionicons
        name="information-circle-outline"
        size={20}
        color={colors.accent}
        style={{ marginTop: 1 }}
      />
      <Text style={[type.caption, { color: colors.textPrimary, flex: 1 }]}>{text}</Text>
      {onDismiss && (
        <View style={{ marginTop: -12, marginBottom: -12, marginRight: -12 }}>
          <IconButton plain label="Dismiss" icon="close" onPress={onDismiss} />
        </View>
      )}
    </View>
  );
}
