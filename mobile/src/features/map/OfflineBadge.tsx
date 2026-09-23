import { Ionicons } from "@expo/vector-icons";
import { Text, View } from "react-native";
import { useTheme } from "../../theme";

export function OfflineBadge() {
  const { colors, type } = useTheme();
  return (
    <View
      style={{
        alignSelf: "flex-start",
        flexDirection: "row",
        alignItems: "center",
        gap: 5,
        backgroundColor: colors.warningSurface,
        borderColor: colors.warning,
        borderWidth: 1,
        borderRadius: 8,
        paddingHorizontal: 8,
        paddingVertical: 4,
        marginTop: 3,
      }}
    >
      <Ionicons name="warning" size={15} color={colors.warningText} />
      <Text style={[type.caption, { fontWeight: "700", color: colors.warningText }]}>
        Possibly offline
      </Text>
    </View>
  );
}
