import qrcode from "qrcode-generator";
import { View } from "react-native";

type MatrixCode = ReturnType<typeof qrcode> & {
  getModuleCount(): number;
  isDark(row: number, column: number): boolean;
};

export function InviteQrCode({ value, size = 232 }: { value: string; size?: number }) {
  const code = qrcode(0, "M") as MatrixCode;
  code.addData(value);
  code.make();
  const modules = code.getModuleCount();
  const cell = size / modules;
  return (
    <View
      accessibilityLabel="QR code for this invitation"
      style={{ width: size, height: size, padding: 8, backgroundColor: "#fff", borderRadius: 16 }}
    >
      {Array.from({ length: modules }, (_, row) => (
        <View key={row} style={{ flexDirection: "row", height: cell }}>
          {Array.from({ length: modules }, (_, column) => (
            <View
              key={column}
              style={{
                width: cell,
                height: cell,
                backgroundColor: code.isDark(row, column) ? "#111" : "#fff",
              }}
            />
          ))}
        </View>
      ))}
    </View>
  );
}
