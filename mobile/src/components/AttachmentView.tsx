import { StorageAccessFramework, writeAsStringAsync, EncodingType } from "expo-file-system/legacy";
import { useEffect, useState } from "react";
import {
  Alert,
  AppState,
  Image,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Text,
  View,
} from "react-native";
import { Directory, File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";
import { useVideoPlayer, VideoView } from "expo-video";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";
import { base64ToBytes } from "../base64";
import { type ChatAttachment, fileSize } from "../attachment";
import { useTheme } from "../theme";
import { IconButton } from "./IconButton";
import { Button } from "./Button";

function VideoContent({ uri }: { uri: string }) {
  const player = useVideoPlayer(uri);
  const [error, setError] = useState(false);
  useEffect(() => {
    const state = AppState.addEventListener("change", (next) => {
      if (next !== "active") player.pause();
    });
    const status = player.addListener("statusChange", (event) =>
      setError(event.status === "error"),
    );
    return () => {
      state.remove();
      status.remove();
    };
  }, [player]);
  return (
    <View style={{ flex: 1 }}>
      <VideoView player={player} nativeControls style={{ flex: 1 }} contentFit="contain" />
      {error && (
        <Text style={{ color: "white", padding: 16 }}>
          This video format cannot be played here. Use Open or save to try another app.
        </Text>
      )}
    </View>
  );
}
function AttachmentViewer({
  attachment,
  onClose,
}: {
  attachment: ChatAttachment;
  onClose: () => void;
}) {
  const { colors, type } = useTheme();
  const insets = useSafeAreaInsets();
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState("");
  const [sharing, setSharing] = useState(false);
  useEffect(() => {
    let directory: Directory | null = null;
    try {
      directory = new Directory(
        Paths.cache,
        `attachment-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      );
      directory.create();
      const temporary = new File(directory, attachment.name);
      temporary.write(base64ToBytes(attachment.base64));
      setFile(temporary);
    } catch {
      setError("Couldn't open this attachment.");
    }
    return () => {
      try {
        if (directory?.exists) directory.delete();
      } catch {}
    };
  }, [attachment]);
  const share = async () => {
    if (!file || sharing) return;
    setSharing(true);
    try {
      if (!(await Sharing.isAvailableAsync())) throw Error();
      await Sharing.shareAsync(file.uri, {
        mimeType: attachment.mimeType,
        dialogTitle: attachment.name,
      });
    } catch {
      Alert.alert("Couldn't open sharing", "Try again in a moment.");
    } finally {
      setSharing(false);
    }
  };
  const save = async () => {
    if (sharing) return;
    setSharing(true);
    try {
      const permission = await StorageAccessFramework.requestDirectoryPermissionsAsync();
      if (!permission.granted) return;
      const destination = await StorageAccessFramework.createFileAsync(
        permission.directoryUri,
        attachment.name,
        attachment.mimeType,
      );
      await writeAsStringAsync(destination, attachment.base64, { encoding: EncodingType.Base64 });
      Alert.alert("File saved", attachment.name);
    } catch {
      Alert.alert("Couldn't save file", "Please choose another folder and try again.");
    } finally {
      setSharing(false);
    }
  };
  return (
    <Modal
      animationType="fade"
      onRequestClose={() => {
        if (!sharing) onClose();
      }}
    >
      <View
        style={{
          flex: 1,
          backgroundColor: colors.background,
          paddingTop: insets.top,
          paddingBottom: insets.bottom,
        }}
      >
        <View style={{ flexDirection: "row", alignItems: "center", padding: 12, gap: 8 }}>
          <IconButton
            plain
            label="Close attachment"
            icon="close"
            disabled={sharing}
            onPress={onClose}
          />
          <View style={{ flex: 1 }}>
            <Text numberOfLines={1} style={[type.subtitle, { color: colors.textPrimary }]}>
              {attachment.name}
            </Text>
            <Text style={[type.caption, { color: colors.textSecondary }]}>
              {fileSize(attachment.size)}
            </Text>
          </View>
        </View>
        {file && attachment.kind === "image" ? (
          <Image source={{ uri: file.uri }} resizeMode="contain" style={{ flex: 1 }} />
        ) : file && attachment.kind === "video" ? (
          <VideoContent uri={file.uri} />
        ) : file && attachment.mimeType === "text/plain" ? (
          <ScrollView style={{ flex: 1 }} contentContainerStyle={{ padding: 20 }}>
            <Text selectable style={[type.body, { color: colors.textPrimary }]}>
              {new TextDecoder().decode(base64ToBytes(attachment.base64)).slice(0, 100000)}
            </Text>
          </ScrollView>
        ) : (
          <View
            style={{
              flex: 1,
              alignItems: "center",
              justifyContent: "center",
              gap: 12,
              padding: 24,
            }}
          >
            <Ionicons name="document-outline" size={64} color={colors.accent} />
            <Text style={[type.body, { color: colors.textPrimary }]}>
              {error || attachment.name}
            </Text>
            <Text style={[type.caption, { color: colors.textSecondary }]}>
              {attachment.mimeType}
            </Text>
          </View>
        )}
        <View style={{ padding: 16, gap: 8 }}>
          {Platform.OS === "android" && (
            <Button
              title="Save file"
              icon="download-outline"
              variant="secondary"
              fullWidth
              disabled={!file || sharing}
              onPress={() => void save()}
            />
          )}
          <Button
            title="Open or share"
            icon="share-outline"
            fullWidth
            loading={sharing}
            disabled={!file}
            onPress={() => void share()}
          />
        </View>
      </View>
    </Modal>
  );
}
export function AttachmentView({
  attachment,
  parts,
  isOwn,
}: {
  attachment: ChatAttachment;
  parts?: Record<string, string>;
  isOwn?: boolean;
}) {
  const { colors, type } = useTheme();
  const [open, setOpen] = useState(false);
  const foreground = isOwn ? colors.textOnAccent : colors.textPrimary;
  const received = Object.values(parts ?? {}).reduce((n, part) => n + part.length, 0);
  return (
    <View style={{ width: 224, maxWidth: "100%", gap: 8 }}>
      {attachment.kind === "image" && attachment.base64 ? (
        <Image
          accessibilityLabel={attachment.name}
          source={{ uri: `data:${attachment.mimeType};base64,${attachment.base64}` }}
          style={{ width: "100%", height: 180, borderRadius: 10 }}
          resizeMode="cover"
        />
      ) : (
        <View
          style={{
            height: attachment.kind === "video" ? 120 : 48,
            alignItems: "center",
            justifyContent: "center",
            borderRadius: 10,
            backgroundColor: isOwn ? "#FFFFFF20" : colors.accentMuted,
          }}
        >
          <Ionicons
            name={
              attachment.kind === "video"
                ? "play-circle-outline"
                : attachment.kind === "image"
                  ? "image-outline"
                  : "document-outline"
            }
            size={40}
            color={foreground}
          />
        </View>
      )}
      <Text numberOfLines={2} style={[type.caption, { color: foreground }]}>
        {attachment.name}
      </Text>
      <Text style={[type.tiny, { color: foreground, opacity: 0.8 }]}>
        {attachment.base64
          ? fileSize(attachment.size)
          : `Receiving · ${Math.min(99, Math.floor((received / (4 * Math.ceil(attachment.size / 3))) * 100))}%`}
      </Text>
      {!!attachment.base64 && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Open ${attachment.name}`}
          onPress={() => setOpen(true)}
          style={{
            minHeight: 40,
            justifyContent: "center",
            alignItems: "center",
            borderRadius: 20,
            backgroundColor: isOwn ? "#FFFFFF20" : colors.accentMuted,
          }}
        >
          <Text style={[type.caption, { color: foreground, fontWeight: "600" }]}>
            {attachment.kind === "image"
              ? "View photo"
              : attachment.kind === "video"
                ? "Play video"
                : "Open file"}
          </Text>
        </Pressable>
      )}
      {open && attachment.base64 && (
        <AttachmentViewer attachment={attachment} onClose={() => setOpen(false)} />
      )}
    </View>
  );
}
