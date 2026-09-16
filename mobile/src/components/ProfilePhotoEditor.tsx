import { useRef, useState } from "react";
import { View } from "react-native";
import * as ImagePicker from "expo-image-picker";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import { validProfilePhoto } from "../profile-photo";
import { Avatar } from "./Avatar";
import { Button } from "./Button";
import { Notice } from "./Notice";

export function ProfilePhotoEditor({
  name,
  photo,
  onChange,
  onBusyChange,
}: {
  name?: string;
  photo?: string | null;
  onChange: (photo: string | null) => Promise<boolean> | boolean;
  onBusyChange?: (busy: boolean) => void;
}) {
  const [busy, setBusy] = useState(false);
  const working = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (remove = false) => {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    onBusyChange?.(true);
    setError(null);
    try {
      let next: string | null = null;
      if (!remove) {
        const result = await ImagePicker.launchImageLibraryAsync({
          mediaTypes: ["images"],
          allowsEditing: true,
          aspect: [1, 1],
          quality: 1,
        });
        if (result.canceled) return;
        const asset = result.assets[0];
        const side = Math.min(asset.width, asset.height);
        const context = ImageManipulator.manipulate(asset.uri);
        try {
          context.crop({
            originX: Math.floor((asset.width - side) / 2),
            originY: Math.floor((asset.height - side) / 2),
            width: side,
            height: side,
          });
          context.resize({ width: 256, height: 256 });
          const image = await context.renderAsync();
          try {
            for (const compress of [0.7, 0.45, 0.25]) {
              const saved = await image.saveAsync({
                format: SaveFormat.JPEG,
                compress,
                base64: true,
              });
              const candidate = `data:image/jpeg;base64,${saved.base64 ?? ""}`;
              if (validProfilePhoto(candidate)) {
                next = candidate;
                break;
              }
            }
          } finally {
            image.release();
          }
        } finally {
          context.release();
        }
        if (!next) throw new Error("This photo couldn't be prepared. Please choose another image.");
      }
      if (!(await onChange(next))) throw new Error("Couldn't save your photo. Please try again.");
    } catch (error) {
      setError(
        error instanceof Error ? error.message : "Couldn't open this photo. Please try again.",
      );
    } finally {
      working.current = false;
      setBusy(false);
      onBusyChange?.(false);
    }
  };
  return (
    <View style={{ gap: 12 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 16 }}>
        <Avatar name={name} photo={photo} size={80} />
        <View style={{ flex: 1, alignItems: "flex-start", gap: 4 }}>
          <Button
            title={photo ? "Change photo" : "Add photo"}
            variant="secondary"
            loading={busy}
            onPress={() => {
              void run();
            }}
          />
          {photo && (
            <Button
              title="Remove photo"
              variant="ghost"
              disabled={busy}
              onPress={() => {
                void run(true);
              }}
            />
          )}
        </View>
      </View>
      <Notice text={error} onDismiss={() => setError(null)} />
    </View>
  );
}
