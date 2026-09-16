import type { PropsWithChildren } from "react";
import { ScrollView, StyleSheet, View, KeyboardAvoidingView, Platform } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { StatusBar } from "expo-status-bar";
import { useTheme } from "../theme";

interface Props {
  scroll?: boolean;
  padded?: boolean;
  headerShown?: boolean;
}

/**
 * Shared safe area, background, and screen padding.
 * Set scroll=false when the screen manages its own scrolling.
 */
export function ScreenContainer({
  children,
  scroll = true,
  padded = true,
  headerShown = true,
}: PropsWithChildren<Props>) {
  const { colors, spacing, scheme } = useTheme();
  const contentStyle = {
    paddingHorizontal: padded ? 20 : 0,
    paddingTop: padded ? spacing.lg : 0,
    paddingBottom: padded ? 28 : 0,
    gap: padded ? spacing.lg : 0,
    flexGrow: 1,
  };
  return (
    <SafeAreaView
      style={[styles.flex, { backgroundColor: colors.background }]}
      edges={headerShown ? ["bottom", "left", "right"] : ["top", "bottom", "left", "right"]}
    >
      <StatusBar style={scheme === "dark" ? "light" : "dark"} />
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        keyboardVerticalOffset={headerShown ? 96 : 0}
      >
        {scroll ? (
          <ScrollView
            style={styles.flex}
            contentContainerStyle={contentStyle}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
            showsVerticalScrollIndicator={false}
          >
            {children}
          </ScrollView>
        ) : (
          <View style={[styles.flex, contentStyle]}>{children}</View>
        )}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
});
