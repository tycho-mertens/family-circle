import "react-native-gesture-handler";
import {
  Stack,
  ThemeProvider as NavigationThemeProvider,
  DarkTheme,
  DefaultTheme,
} from "expo-router";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { ActivityIndicator, Text, View } from "react-native";
import { ThemeProvider, useTheme } from "../src/theme";
import { IdentityProvider, useIdentity } from "../src/state/identity";
import { CirclesProvider, useCircles } from "../src/state/circles";
import { PreferencesProvider } from "../src/state/preferences";
import { LocationProvider } from "../src/state/locations";
import { ScreenContainer } from "../src/components/ScreenContainer";

export { ErrorBoundary } from "expo-router";

function Navigation() {
  const { resuming, deviceId } = useIdentity();
  const { circlesReady } = useCircles();
  const { colors, scheme, type, spacing } = useTheme();
  const base = scheme === "dark" ? DarkTheme : DefaultTheme;
  return (
    <NavigationThemeProvider
      value={{
        ...base,
        colors: {
          ...base.colors,
          primary: colors.accent,
          background: colors.background,
          card: colors.surface,
          text: colors.textPrimary,
          border: colors.border,
        },
      }}
    >
      {resuming || (!!deviceId && !circlesReady) ? (
        <ScreenContainer scroll={false} headerShown={false}>
          <View
            style={{ flex: 1, justifyContent: "center", alignItems: "center", gap: spacing.lg }}
          >
            <ActivityIndicator color={colors.accent} size="large" />
            <Text style={[type.body, { color: colors.textSecondary }]}>Opening your Circles…</Text>
          </View>
        </ScreenContainer>
      ) : (
        <Stack screenOptions={{ headerShown: false }}>
          <Stack.Protected guard={!!deviceId}>
            <Stack.Screen name="(app)" />
          </Stack.Protected>
          <Stack.Protected guard={!deviceId}>
            <Stack.Screen name="(onboarding)" />
          </Stack.Protected>
        </Stack>
      )}
    </NavigationThemeProvider>
  );
}

export default function RootLayout() {
  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <ThemeProvider>
        <IdentityProvider>
          <CirclesProvider>
            <LocationProvider>
              <PreferencesProvider>
                <Navigation />
              </PreferencesProvider>
            </LocationProvider>
          </CirclesProvider>
        </IdentityProvider>
      </ThemeProvider>
    </GestureHandlerRootView>
  );
}
