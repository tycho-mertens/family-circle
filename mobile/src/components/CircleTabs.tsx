import { Pressable, Text, View } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { router, type Href } from "expo-router";
import { useTheme } from "../theme";
export function CircleTabs({ circleId, selected }: { circleId: string; selected: "chat" | "map" }) {
  const { colors, type } = useTheme();
  return (
    <View style={{ paddingHorizontal: 20, paddingTop: 4, paddingBottom: 12 }}>
      <View
        accessibilityRole="tablist"
        style={{
          flexDirection: "row",
          padding: 4,
          borderRadius: 20,
          backgroundColor: colors.surfaceAlt,
        }}
      >
        {(["chat", "map"] as const).map((tab) => (
          <Pressable
            key={tab}
            accessibilityRole="tab"
            accessibilityState={{ selected: tab === selected }}
            accessibilityLabel={tab === "chat" ? "Circle chat" : "Circle map"}
            onPress={() => {
              if (tab !== selected)
                router.replace({
                  pathname: tab === "chat" ? "/circle/[circleId]" : "/circle/[circleId]/map",
                  params: { circleId },
                } as Href);
            }}
            android_ripple={{ color: colors.border }}
            style={{
              flex: 1,
              minHeight: 40,
              justifyContent: "center",
              gap: 8,
              flexDirection: "row",
              alignItems: "center",
              borderRadius: 14,
              overflow: "hidden",
              backgroundColor: tab === selected ? colors.surface : "transparent",
            }}
          >
            <Ionicons
              name={tab === "chat" ? "chatbubble-outline" : "map-outline"}
              size={18}
              color={tab === selected ? colors.accent : colors.textSecondary}
            />
            <Text
              style={[
                type.subtitle,
                { color: tab === selected ? colors.accent : colors.textSecondary },
              ]}
            >
              {tab === "chat" ? "Chat" : "Map"}
            </Text>
          </Pressable>
        ))}
      </View>
    </View>
  );
}
