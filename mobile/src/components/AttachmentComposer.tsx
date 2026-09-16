import { BottomSheet } from "./BottomSheet";
import { useEffect, useRef, useState } from "react";
import { Text, View } from "react-native";
import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import { ImageManipulator, SaveFormat } from "expo-image-manipulator";
import { File, Paths } from "expo-file-system";
import {
  attachmentKind,
  validAttachment,
  MAX_ATTACHMENT_BYTES,
  type ChatAttachment,
} from "../attachment";
import { useTheme } from "../theme";
import { AttachmentView } from "./AttachmentView";
import { Button } from "./Button";

export function AttachmentComposer({
  onClose,
  onSend,
}: {
  onClose: () => void;
  onSend: (attachment: ChatAttachment) => Promise<boolean>;
}) {
  const { colors, type } = useTheme();
  const cached = useRef(new Set<string>());
  const track = (uri: string) => {
    if (uri.startsWith(Paths.cache.uri)) cached.current.add(uri);
  };
  useEffect(
    () => () => {
      for (const uri of cached.current) {
        try {
          const file = new File(uri);
          if (file.exists) file.delete();
        } catch {}
      }
    },
    [],
  );
  const [attachment, setAttachment] = useState<ChatAttachment | null>(null);
  const [busy, setBusy] = useState(false);
  const working = useRef(false);
  const [error, setError] = useState("");
  const pick = async (media: boolean) => {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setError("");
    try {
      let uri: string, name: string, mimeType: string;
      if (media) {
        const result = await ImagePicker.launchImageLibraryAsync({
          mediaTypes: ["images", "videos"],
          quality: 0.8,
          allowsMultipleSelection: false,
        });
        if (result.canceled) return;
        const asset = result.assets[0];
        uri = asset.uri;
        track(uri);
        name = asset.fileName ?? (asset.type === "video" ? "Video.mp4" : "Photo.jpg");
        mimeType = asset.mimeType ?? (asset.type === "video" ? "video/mp4" : "image/jpeg");
        if (asset.type === "image") {
          const context = ImageManipulator.manipulate(uri);
          if (asset.width > 1600 || asset.height > 1600)
            context.resize(asset.width >= asset.height ? { width: 1600 } : { height: 1600 });
          const image = await context.renderAsync();
          const saved = await image.saveAsync({ format: SaveFormat.JPEG, compress: 0.82 });
          uri = saved.uri;
          track(uri);
          name = name.replace(/\.[^.]+$/, "") + ".jpg";
          mimeType = "image/jpeg";
        }
      } else {
        const result = await DocumentPicker.getDocumentAsync({
          type: "*/*",
          copyToCacheDirectory: true,
          multiple: false,
        });
        if (result.canceled) return;
        const asset = result.assets[0];
        uri = asset.uri;
        track(uri);
        name = asset.name;
        mimeType = asset.mimeType ?? "application/octet-stream";
      }
      const file = new File(uri);
      if (!file.size || file.size > MAX_ATTACHMENT_BYTES) {
        setError("Choose a file up to 10 MB.");
        return;
      }
      const value = {
        name: name.replace(/[\x00-\x1f\x7f/\\]/g, "_").slice(0, 180),
        mimeType,
        kind: attachmentKind(mimeType),
        size: file.size,
        base64: await file.base64(),
      };
      if (!validAttachment(value)) throw Error();
      setAttachment(value);
    } catch {
      setError("Couldn't read this attachment. Try another file.");
    } finally {
      working.current = false;
      setBusy(false);
    }
  };
  const send = async () => {
    if (!attachment || working.current) return;
    working.current = true;
    setBusy(true);
    setError("");
    try {
      if (await onSend(attachment)) onClose();
      else setError("Couldn't send this attachment. Your preview is kept so you can try again.");
    } catch {
      setError("Couldn't send this attachment. Please try again.");
    } finally {
      working.current = false;
      setBusy(false);
    }
  };
  return (
    <BottomSheet
      title={attachment ? "Send attachment" : "Add to chat"}
      subtitle="Photos, videos and files · Up to 10 MB each"
      busy={busy}
      onClose={onClose}
      footer={
        attachment ? (
          <Button title="Send attachment" fullWidth loading={busy} onPress={() => void send()} />
        ) : undefined
      }
    >
      {attachment && (
        <View
          style={{
            alignItems: "center",
            padding: 12,
            borderRadius: 16,
            backgroundColor: colors.surfaceAlt,
          }}
        >
          <AttachmentView attachment={attachment} />
        </View>
      )}
      {!!error && (
        <Text accessibilityRole="alert" style={[type.caption, { color: colors.danger }]}>
          {error}
        </Text>
      )}
      <Button
        title={attachment ? "Choose another photo or video" : "Photos or videos"}
        icon="images-outline"
        variant="secondary"
        disabled={busy}
        onPress={() => void pick(true)}
        fullWidth
      />
      <Button
        title={attachment ? "Choose another file" : "Choose file"}
        icon="document-outline"
        variant="secondary"
        disabled={busy}
        onPress={() => void pick(false)}
        fullWidth
      />
    </BottomSheet>
  );
}
