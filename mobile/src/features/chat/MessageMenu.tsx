import { useEffect, useState } from "react";
import { Modal, Pressable, ScrollView, Text, View, useWindowDimensions } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "../../theme";
import { MESSAGE_ACTION_WINDOW_MS } from "../../message-actions";

export type MessageMenuAnchor = { x: number; y: number; width: number };
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, max));

interface Props {
  anchor: MessageMenuAnchor | null;
  onClose: () => void;
  isOwn?: boolean;
  senderName?: string;
  at: number;
  editedAt?: number;
  text: string;
  canReact: boolean;
  hotbar: { emoji: string; label: string }[];
  mine?: string;
  busy: boolean;
  onReact: (emoji: string | null) => Promise<void>;
  onMoreEmoji: () => void;
  onReply?: () => void;
  onEdit?: () => void;
  onViewOriginal?: () => void;
  onDelete?: () => void;
}

export function MessageMenu({
  anchor,
  onClose,
  isOwn,
  senderName,
  at,
  editedAt,
  text,
  canReact,
  hotbar,
  mine,
  busy,
  onReact,
  onMoreEmoji,
  onReply,
  onEdit,
  onViewOriginal,
  onDelete,
}: Props) {
  const { colors, type } = useTheme();
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [menuHeight, setMenuHeight] = useState(420);
  const [, refreshClock] = useState(0);
  const now = Date.now();
  useEffect(() => {
    if (!anchor) return;
    const timer = setInterval(() => refreshClock((tick) => tick + 1), 500);
    return () => clearInterval(timer);
  }, [anchor]);
  const canModify = isOwn && now >= at && now - at < MESSAGE_ACTION_WINDOW_MS;
  const trayWidth = Math.min(336, width - insets.left - insets.right - 32);
  const trayLeft = clamp(
    anchor ? (isOwn ? anchor.x + anchor.width - trayWidth : anchor.x) : 16,
    insets.left + 16,
    width - insets.right - trayWidth - 16,
  );
  const trayTop = clamp(
    (anchor?.y ?? height / 2) - 80,
    insets.top + 12,
    height - insets.bottom - menuHeight - 24,
  );

  return (
    <Modal
      visible={anchor !== null}
      transparent
      statusBarTranslucent
      navigationBarTranslucent
      animationType="fade"
      onRequestClose={onClose}
    >
      <View style={{ flex: 1, backgroundColor: colors.overlay }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close message menu"
          onPress={onClose}
          style={{ position: "absolute", top: 0, bottom: 0, left: 0, right: 0 }}
        />
        <ScrollView
          accessibilityViewIsModal
          keyboardShouldPersistTaps="handled"
          onContentSizeChange={(_, measuredHeight) => setMenuHeight(measuredHeight)}
          style={{
            position: "absolute",
            left: trayLeft,
            top: trayTop,
            width: trayWidth,
            maxHeight: height - trayTop - insets.bottom - 12,
            borderRadius: 24,
            backgroundColor: colors.surface,
            shadowColor: "#000",
            shadowOpacity: 0.24,
            shadowRadius: 20,
            shadowOffset: { width: 0, height: 8 },
            elevation: 12,
          }}
          contentContainerStyle={{ padding: 8 }}
        >
          <View style={{ padding: 12, gap: 5 }}>
            <Text style={[type.subtitle, { color: colors.textPrimary }]}>
              {isOwn ? "You" : (senderName ?? "Circle member")}
            </Text>
            <Text style={[type.caption, { color: colors.textSecondary }]}>
              {new Date(at).toLocaleString([], {
                month: "short",
                day: "numeric",
                year: "numeric",
                hour: "2-digit",
                minute: "2-digit",
              })}
              {editedAt !== undefined ? " · Edited" : ""}
            </Text>
            <Text
              numberOfLines={3}
              style={[type.body, { color: colors.textPrimary, marginTop: 5 }]}
            >
              {text}
            </Text>
          </View>
          {canReact && (
            <View
              style={{
                backgroundColor: colors.surfaceAlt,
                borderRadius: 24,
                padding: 4,
                flexDirection: "row",
                flexWrap: "wrap",
              }}
            >
              {hotbar.map(({ emoji, label }) => (
                <Pressable
                  key={emoji}
                  accessibilityRole="button"
                  accessibilityLabel={label}
                  accessibilityHint={
                    mine === emoji ? "Remove your reaction" : "React to this message"
                  }
                  accessibilityState={{ selected: mine === emoji, disabled: busy }}
                  disabled={busy}
                  onPress={() => {
                    void onReact(mine === emoji ? null : emoji);
                  }}
                  style={({ pressed }) => ({
                    minWidth: 44,
                    height: 48,
                    flexGrow: 1,
                    alignItems: "center",
                    justifyContent: "center",
                    borderRadius: 24,
                    backgroundColor:
                      mine === emoji || pressed ? colors.accentMuted : "transparent",
                    transform: [{ scale: pressed ? 1.12 : 1 }],
                  })}
                >
                  <Text allowFontScaling={false} style={{ fontSize: 26 }}>
                    {emoji}
                  </Text>
                </Pressable>
              ))}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="More emoji"
                onPress={onMoreEmoji}
                style={({ pressed }) => ({
                  minWidth: 44,
                  height: 48,
                  flexGrow: 1,
                  alignItems: "center",
                  justifyContent: "center",
                  borderRadius: 24,
                  backgroundColor: pressed ? colors.accentMuted : "transparent",
                })}
              >
                <Ionicons name="add" size={26} color={colors.textPrimary} />
              </Pressable>
            </View>
          )}
          <View style={{ marginTop: 8 }}>
            {(
              [
                { label: "Reply", icon: "arrow-undo-outline", action: onReply },
                {
                  label: "Edit",
                  icon: "create-outline",
                  action: canModify ? onEdit : undefined,
                },
                {
                  label: "View original",
                  icon: "document-text-outline",
                  action: onViewOriginal,
                },
                {
                  label: "Delete for everyone",
                  icon: "trash-outline",
                  action: canModify ? onDelete : undefined,
                },
              ] as const
            )
              .filter((row) => row.action)
              .map((row) => (
                <Pressable
                  key={row.label}
                  accessibilityRole="button"
                  accessibilityLabel={row.label}
                  onPress={() => {
                    onClose();
                    row.action?.();
                  }}
                  style={({ pressed }) => ({
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 14,
                    paddingHorizontal: 12,
                    minHeight: 48,
                    paddingVertical: 12,
                    borderRadius: 16,
                    backgroundColor: pressed ? colors.surfaceAlt : "transparent",
                  })}
                >
                  <Ionicons
                    name={row.icon}
                    size={21}
                    color={
                      row.label === "Delete for everyone" ? colors.danger : colors.textPrimary
                    }
                  />
                  <Text
                    style={[
                      type.subtitle,
                      {
                        color:
                          row.label === "Delete for everyone"
                            ? colors.danger
                            : colors.textPrimary,
                      },
                    ]}
                  >
                    {row.label}
                  </Text>
                </Pressable>
              ))}
          </View>
        </ScrollView>
      </View>
    </Modal>
  );
}
