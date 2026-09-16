import { CameraView, useCameraPermissions } from "expo-camera";
import { useState } from "react";
import { Text, View } from "react-native";
import { Stack, router } from "expo-router";
import { useTheme } from "../../src/theme";
import { ScreenContainer } from "../../src/components/ScreenContainer";
import { PageHeading } from "../../src/components/PageHeading";
import { Button } from "../../src/components/Button";
import { Notice } from "../../src/components/Notice";

export default function ScanInvite() {
  const [permission, requestPermission] = useCameraPermissions();
  const [error, setError] = useState<string | null>(null);
  const [scanned, setScanned] = useState(false);
  const { colors, type, radii } = useTheme();
  const accept = (value: string) => {
    if (scanned) return;
    const code = value.trim();
    if (code.split(".").length < 3) {
      setError("That QR code isn't a Family Circle invitation.");
      return;
    }
    setScanned(true);
    router.replace({ pathname: "/(app)", params: { inviteCode: code } });
  };
  return (
    <ScreenContainer>
      <Stack.Screen options={{ title: "Scan invitation" }} />
      <PageHeading
        title="Scan an invitation"
        body="Point your camera at the QR code from your Circle admin."
      />
      {!permission ? (
        <Text style={[type.body, { color: colors.textSecondary }]}>
          Checking camera permission…
        </Text>
      ) : !permission.granted ? (
        <View style={{ gap: 14 }}>
          <Text style={[type.body, { color: colors.textSecondary }]}>
            Camera access is needed only to scan an invitation QR code.
          </Text>
          <Button title="Allow camera" onPress={() => void requestPermission()} />
        </View>
      ) : (
        <View
          style={{
            overflow: "hidden",
            borderRadius: radii.lg,
            aspectRatio: 1,
            backgroundColor: colors.surfaceAlt,
          }}
        >
          <CameraView
            style={{ flex: 1 }}
            facing="back"
            barcodeScannerSettings={{ barcodeTypes: ["qr"] }}
            onBarcodeScanned={scanned ? undefined : (event) => accept(event.data)}
          />
        </View>
      )}
      <Notice text={error} onDismiss={() => setError(null)} />
      <Button
        title="Enter invite code instead"
        variant="ghost"
        onPress={() => router.replace("/(app)")}
      />
    </ScreenContainer>
  );
}
