import { Stack, router } from "expo-router";
import { Pressable } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useTheme } from "../../../../src/theme";

export default function CircleLayout() {
  const { colors } = useTheme();
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: colors.background },
        headerTintColor: colors.textPrimary,
        headerShadowVisible: false,
        headerTitleStyle: { fontSize: 20, fontWeight: "700" },
      }}
    >
      <Stack.Screen
        name="index"
        options={{
          title: "Your Circle",
          headerLeft: () => (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Back to your Circles"
              onPress={() => router.replace("/(app)")}
              style={{ padding: 12 }}
            >
              <Ionicons name="arrow-back" size={24} color={colors.textPrimary} />
            </Pressable>
          ),
        }}
      />
      <Stack.Screen
        name="map"
        options={{
          title: "Circle map",
          headerLeft: () => (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Back to your Circles"
              onPress={() => router.replace("/(app)")}
              style={{ padding: 12 }}
            >
              <Ionicons name="arrow-back" size={24} color={colors.textPrimary} />
            </Pressable>
          ),
        }}
      />
      <Stack.Screen name="manage" options={{ title: "Circle settings" }} />
    </Stack>
  );
}
