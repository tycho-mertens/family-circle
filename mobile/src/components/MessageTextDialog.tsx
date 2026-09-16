import { useState } from "react";
import { KeyboardAvoidingView, Modal, Platform, ScrollView, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "../theme";
import { Button } from "./Button";
import { TextField } from "./TextField";

export function MessageTextDialog({
  text,
  onClose,
  onSave,
}: {
  text: string;
  onClose: () => void;
  onSave?: (text: string) => Promise<boolean>;
}) {
  const { colors, type } = useTheme();
  const insets = useSafeAreaInsets();
  const [draft, setDraft] = useState(text);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const save = async () => {
    if (!onSave || busy) return;
    setBusy(true);
    try {
      if (await onSave(draft)) onClose();
      else
        setError(
          "This message can no longer be edited. Editing is available for 15 minutes after sending.",
        );
    } catch {
      setError("Couldn’t save your edit. Please try again.");
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      transparent
      animationType="fade"
      onRequestClose={() => {
        if (!busy) onClose();
      }}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        style={{
          flex: 1,
          justifyContent: "center",
          padding: 24,
          paddingTop: insets.top + 24,
          paddingBottom: insets.bottom + 24,
          backgroundColor: colors.overlay,
        }}
      >
        <View
          accessibilityViewIsModal
          style={{
            maxHeight: "100%",
            backgroundColor: colors.surface,
            borderRadius: 24,
            padding: 20,
            gap: 16,
          }}
        >
          <Text accessibilityRole="header" style={[type.title, { color: colors.textPrimary }]}>
            {onSave ? "Edit message" : "Original message"}
          </Text>
          <ScrollView keyboardShouldPersistTaps="handled" style={{ flexGrow: 0 }}>
            {onSave ? (
              <TextField
                accessibilityLabel="Edit message text"
                value={draft}
                onChangeText={setDraft}
                multiline
                autoFocus
                maxLength={10000}
                style={{ maxHeight: 260 }}
              />
            ) : (
              <Text selectable style={[type.body, { color: colors.textPrimary }]}>
                {text}
              </Text>
            )}
          </ScrollView>
          {!!error && (
            <Text accessibilityRole="alert" style={[type.caption, { color: colors.danger }]}>
              {error}
            </Text>
          )}
          <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 8 }}>
            <Button
              title={onSave ? "Cancel" : "Close"}
              variant="ghost"
              disabled={busy}
              onPress={onClose}
            />
            {onSave && (
              <Button
                title="Save edit"
                loading={busy}
                disabled={!draft.trim() || draft.trim() === text}
                onPress={() => void save()}
              />
            )}
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
