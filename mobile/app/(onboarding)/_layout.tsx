import { Stack } from "expo-router";
import { useIdentity } from "../../src/state/identity";
import { useTheme } from "../../src/theme";

export default function OnboardingLayout() {
  const { createdIdentity, seedPhraseSaved, nicknameComplete } = useIdentity();
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
      <Stack.Protected guard={!createdIdentity && !seedPhraseSaved}>
        <Stack.Screen name="index" options={{ headerShown: false }} />
        <Stack.Screen name="setup" options={{ title: "Get started" }} />
      </Stack.Protected>
      <Stack.Protected guard={!!createdIdentity}>
        <Stack.Screen
          name="seed-phrase"
          options={{
            title: "Your recovery phrase",
            headerBackVisible: false,
            gestureEnabled: false,
          }}
        />
      </Stack.Protected>
      <Stack.Protected guard={seedPhraseSaved && !nicknameComplete}>
        <Stack.Screen
          name="nickname"
          options={{
            title: "Make yourself at home",
            headerBackVisible: false,
            gestureEnabled: false,
          }}
        />
      </Stack.Protected>
      <Stack.Protected guard={seedPhraseSaved && nicknameComplete}>
        <Stack.Screen
          name="location"
          options={{ title: "Location sharing", headerBackVisible: false, gestureEnabled: false }}
        />
      </Stack.Protected>
    </Stack>
  );
}
