import { useState } from "react";
import { Text } from "react-native";
import { enrollInstallation } from "../relay-access";
import { useTheme } from "../theme";
import { TextField } from "./TextField";
import { Button } from "./Button";
import { Notice } from "./Notice";
export function ServerAccess() {
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<string | null>(null);
  const { colors, type } = useTheme();
  return (
    <>
      <Text style={[type.body, { color: colors.textSecondary }]}>
        If your server requires an access code, enter the code provided by its administrator. This
        is separate from your Circle invitation.
      </Text>
      <TextField
        label="Server access code"
        value={code}
        onChangeText={setCode}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
      />
      <Button
        title="Enable server access"
        loading={busy}
        onPress={async () => {
          setBusy(true);
          try {
            await enrollInstallation(code);
            setCode("");
            setFeedback("Server access enabled on this phone.");
          } catch (e) {
            setFeedback(e instanceof Error ? e.message : "Couldn't enable server access.");
          } finally {
            setBusy(false);
          }
        }}
      />
      <Notice text={feedback} />
    </>
  );
}
