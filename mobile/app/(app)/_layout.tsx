import { View } from "react-native";
import { Tabs, router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useTheme } from "../../src/theme";
import { IconButton } from "../../src/components/IconButton";
export default function AppLayout() {
  const { colors } = useTheme();
  const back = () => (
    <IconButton plain label="Back" icon="arrow-back" onPress={() => router.back()} />
  );
  return (
    <Tabs
      backBehavior="history"
      screenOptions={{
        headerStyle: { backgroundColor: colors.background },
        headerTintColor: colors.textPrimary,
        headerShadowVisible: false,
        headerTitleStyle: { fontSize: 20, fontWeight: "700" },
        tabBarActiveTintColor: colors.accent,
        tabBarInactiveTintColor: colors.textSecondary,
        tabBarStyle: {
          backgroundColor: colors.surface,
          borderTopColor: colors.border,
          elevation: 0,
          height: 68,
          paddingTop: 4,
        },
        tabBarLabelStyle: { fontSize: 12, fontWeight: "600", paddingBottom: 3 },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          headerShown: false,
          title: "Circles",
          tabBarLabel: "Circles",
          tabBarIcon: ({ color, focused }) => (
            <View style={{ width: 44, height: 30, alignItems: "center", justifyContent: "center" }}>
              <Ionicons name={focused ? "people" : "people-outline"} color={color} size={22} />
            </View>
          ),
        }}
      />
      <Tabs.Screen
        name="profile"
        options={{
          headerShown: false,
          title: "Profile",
          tabBarLabel: "Profile",
          tabBarIcon: ({ color, focused }) => (
            <View style={{ width: 44, height: 30, alignItems: "center", justifyContent: "center" }}>
              <Ionicons
                name={focused ? "person-circle" : "person-circle-outline"}
                color={color}
                size={22}
              />
            </View>
          ),
        }}
      />
      <Tabs.Screen
        name="scan-invite"
        options={{ href: null, title: "Scan invitation", headerLeft: back }}
      />
      <Tabs.Screen
        name="connection"
        options={{ href: null, title: "Connection", headerLeft: back }}
      />
      <Tabs.Screen
        name="how-it-works"
        options={{ href: null, title: "How it works", headerLeft: back }}
      />
      <Tabs.Screen
        name="location-settings"
        options={{ href: null, title: "Location settings", headerLeft: back }}
      />
      <Tabs.Screen
        name="circle/[circleId]"
        options={{ href: null, headerShown: false, tabBarStyle: { display: "none" } }}
      />
    </Tabs>
  );
}
