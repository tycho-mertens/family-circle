import type { PropsWithChildren, ReactNode } from "react";
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Text,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "../theme";
import { IconButton } from "./IconButton";

export function BottomSheet({
  visible = true,
  title,
  subtitle,
  busy,
  onClose,
  children,
  footer,
}: PropsWithChildren<{
  visible?: boolean;
  title: string;
  subtitle?: string;
  busy?: boolean;
  onClose: () => void;
  footer?: ReactNode;
}>) {
  const { colors, type } = useTheme();
  const insets = useSafeAreaInsets();
  const close = () => {
    if (!busy) onClose();
  };
  return (
    <Modal
      visible={visible}
      transparent
      statusBarTranslucent
      navigationBarTranslucent
      animationType="slide"
      onRequestClose={close}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        style={{
          flex: 1,
          justifyContent: "flex-end",
          paddingTop: insets.top + 16,
          backgroundColor: colors.overlay,
        }}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close sheet"
          disabled={busy}
          onPress={close}
          style={{ position: "absolute", inset: 0 }}
        />
        <View
          accessibilityViewIsModal
          style={{
            maxHeight: "100%",
            backgroundColor: colors.surface,
            borderTopLeftRadius: 30,
            borderTopRightRadius: 30,
            paddingTop: 10,
            paddingBottom: Math.max(insets.bottom, 16),
            paddingLeft: Math.max(insets.left, 20),
            paddingRight: Math.max(insets.right, 20),
            shadowColor: "#000",
            shadowOpacity: 0.18,
            shadowRadius: 24,
            shadowOffset: { width: 0, height: -4 },
            elevation: 12,
          }}
        >
          <View
            style={{
              width: 36,
              height: 5,
              borderRadius: 3,
              backgroundColor: colors.border,
              alignSelf: "center",
              marginBottom: 10,
            }}
          />
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8, marginBottom: 12 }}>
            <View style={{ flex: 1, gap: 4 }}>
              <Text accessibilityRole="header" style={[type.title, { color: colors.textPrimary }]}>
                {title}
              </Text>
              {subtitle && (
                <Text style={[type.caption, { color: colors.textSecondary }]}>{subtitle}</Text>
              )}
            </View>
            <IconButton plain label="Close" icon="close" disabled={busy} onPress={close} />
          </View>
          <ScrollView
            style={{ flexGrow: 0, flexShrink: 1 }}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
            contentContainerStyle={{ gap: 16, paddingBottom: 12 }}
          >
            {children}
          </ScrollView>
          {footer && (
            <View
              style={{
                paddingTop: 12,
                borderTopWidth: 1,
                borderColor: colors.border,
                backgroundColor: colors.surface,
              }}
            >
              {footer}
            </View>
          )}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
