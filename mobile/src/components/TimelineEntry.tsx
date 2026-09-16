import { AttachmentView } from "./AttachmentView";
import type { ChatAttachment } from "../attachment";
import { MESSAGE_ACTION_WINDOW_MS } from "../message-actions";
import { Ionicons } from "@expo/vector-icons";
import { ReplyPreview, type ReplyPreviewData } from "./ReplyPreview";
import type { VoiceMessage } from "../voice-message";
import { VoicePlayer } from "./VoicePlayer";
import { useEffect, useRef, useState } from "react";
import { Modal, Pressable, ScrollView, Text, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { doubleTapReaction, quickReactions, reactionLabel } from "../reactions";
import { rememberReaction, useReactionHistory } from "../reaction-history";
import { EmojiPicker } from "./EmojiPicker";
import { useTheme } from "../theme";
import { Avatar } from "./Avatar";
import { IconButton } from "./IconButton";

interface Props {
  kind: "chat" | "system";
  text: string;
  voice?: VoiceMessage;
  attachment?: ChatAttachment;
  attachmentParts?: Record<string, string>;
  senderName?: string;
  senderPhoto?: string | null;
  profilePhotos?: Record<string, string | null>;
  isOwn?: boolean;
  status?: string;
  at: number;
  editedAt?: number;
  onEdit?: () => void;
  onDelete?: () => void;
  onViewOriginal?: () => void;
  startsGroup?: boolean;
  endsGroup?: boolean;
  reactions?: Record<string, string>;
  deviceId?: string;
  nicknames?: Record<string, string>;
  reply?: ReplyPreviewData;
  onReply?: () => void;
  onGoToReply?: () => void;
  highlighted?: boolean;
  onReact?: (emoji: string | null) => Promise<boolean>;
}

type Anchor = { x: number; y: number; width: number };
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(value, max));

export function TimelineEntryView({
  kind,
  text,
  voice,
  attachment,
  attachmentParts,
  senderName,
  senderPhoto,
  profilePhotos = {},
  isOwn,
  status,
  at,
  editedAt,
  onEdit,
  onDelete,
  onViewOriginal,
  startsGroup = true,
  endsGroup = true,
  reactions = {},
  deviceId,
  nicknames = {},
  onReact,
  reply,
  onReply,
  onGoToReply,
  highlighted,
}: Props) {
  const { colors, radii, spacing, type } = useTheme();
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const bubble = useRef<View>(null);
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const [menuHeight, setMenuHeight] = useState(420);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!anchor) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(timer);
  }, [anchor]);
  const canModify = isOwn && now >= at && now - at < MESSAGE_ACTION_WINDOW_MS;
  const history = useReactionHistory(deviceId);
  const hotbar = quickReactions(history);
  const [showPicker, setShowPicker] = useState(false);
  const [showReactors, setShowReactors] = useState(false);
  const [busy, setBusy] = useState(false);
  const lastTap = useRef(0);
  const reacting = useRef(false);
  const mine = deviceId ? reactions[deviceId] : undefined;
  const groups = [...new Set(Object.values(reactions))].map((emoji) => ({
    emoji,
    label: reactionLabel(emoji),
    members: Object.keys(reactions).filter((id) => reactions[id] === emoji),
  }));
  const total = groups.reduce((count, group) => count + group.members.length, 0);
  const reactionDescription = groups
    .map(
      (group) =>
        `${group.label}: ${group.members.map((id) => (id === deviceId ? "You" : (nicknames[id] ?? "Circle member"))).join(", ")}`,
    )
    .join(". ");
  const close = () => {
    setAnchor(null);
    setShowPicker(false);
  };
  const openReactors = () => {
    lastTap.current = 0;
    close();
    setShowReactors(true);
  };
  const open = () => {
    setNow(Date.now());
    lastTap.current = 0;
    bubble.current?.measureInWindow((x, y, measuredWidth) => {
      if (measuredWidth > 0) setAnchor({ x, y, width: measuredWidth });
    });
  };
  const react = async (emoji: string | null) => {
    if (!onReact || reacting.current) return;
    reacting.current = true;
    setBusy(true);
    try {
      if (await onReact(emoji)) {
        close();
        if (emoji && deviceId) void rememberReaction(deviceId, emoji);
      }
    } finally {
      reacting.current = false;
      setBusy(false);
    }
  };
  const doubleTap = () => {
    const now = Date.now();
    if (lastTap.current && now - lastTap.current < 300) {
      lastTap.current = 0;
      void react(doubleTapReaction(mine));
    } else lastTap.current = now;
  };
  const bubbleStyle = {
    backgroundColor: isOwn ? colors.accent : colors.incomingBubble,
    borderRadius: radii.lg,
    borderBottomRightRadius: isOwn ? radii.sm : radii.lg,
    borderBottomLeftRadius: isOwn ? radii.lg : radii.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: 9,
  };
  const textStyle = [type.body, { color: isOwn ? colors.textOnAccent : colors.textPrimary }];
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

  if (kind === "system")
    return (
      <View style={{ alignItems: "center", marginVertical: spacing.xs }}>
        <View
          style={{
            backgroundColor: colors.surfaceAlt,
            borderRadius: radii.full,
            paddingHorizontal: spacing.md,
            paddingVertical: spacing.xs,
          }}
        >
          <Text style={[type.tiny, { color: colors.textSecondary }]}>{text}</Text>
        </View>
      </View>
    );

  return (
    <View
      style={{
        alignSelf: isOwn ? "flex-end" : "flex-start",
        maxWidth: "82%",
        marginTop: startsGroup ? spacing.md : 2,
        marginBottom: endsGroup ? spacing.md : 1,
        gap: 2,
      }}
    >
      {startsGroup && !isOwn && senderName && (
        <View
          style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm, marginBottom: 2 }}
        >
          <Avatar name={senderName} photo={senderPhoto} size={24} />
          <Text style={[type.tiny, { color: colors.textSecondary, flexShrink: 1 }]}>
            {senderName}
          </Text>
        </View>
      )}
      <View style={{ alignSelf: isOwn ? "flex-end" : "flex-start", maxWidth: "100%", gap: 2 }}>
        <Pressable
          ref={bubble}
          collapsable={false}
          accessible={voice || reply || attachment ? false : undefined}
          accessibilityRole="button"
          accessibilityLabel={text}
          accessibilityHint={
            onReact
              ? "Double tap to toggle your heart reaction. Hold to react or reply."
              : undefined
          }
          accessibilityActions={
            onReact
              ? [
                  {
                    name: "heart",
                    label: mine === "❤️" ? "Remove heart reaction" : "Add heart reaction",
                  },
                  { name: "react", label: "Choose reaction" },
                  ...(onReply ? [{ name: "reply", label: "Reply to message" }] : []),
                ]
              : undefined
          }
          onAccessibilityAction={(event) => {
            if (event.nativeEvent.actionName === "heart") void react(doubleTapReaction(mine));
            else if (event.nativeEvent.actionName === "react") open();
            else if (event.nativeEvent.actionName === "reply") onReply?.();
          }}
          onPress={onReact ? doubleTap : undefined}
          onLongPress={open}
          delayLongPress={350}
          style={[
            bubbleStyle,
            {
              opacity: anchor ? 0.92 : 1,
              outlineWidth: highlighted ? 2 : 0,
              outlineColor: colors.accent,
              outlineOffset: 3,
            },
          ]}
        >
          {reply && <ReplyPreview reply={reply} isOwn={isOwn} onPress={onGoToReply} />}
          {attachment ? (
            <AttachmentView attachment={attachment} parts={attachmentParts} isOwn={isOwn} />
          ) : voice ? (
            <VoicePlayer voice={voice} isOwn={isOwn} />
          ) : (
            <Text style={textStyle}>{text}</Text>
          )}
        </Pressable>
        {total > 0 && (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={reactionDescription}
            accessibilityHint={
              onReact ? "Tap to choose a reaction. Hold to see who reacted." : "See who reacted"
            }
            accessibilityActions={[{ name: "showReactors", label: "See who reacted" }]}
            onAccessibilityAction={(event) => {
              if (event.nativeEvent.actionName === "showReactors") openReactors();
            }}
            onPress={onReact ? open : openReactors}
            onLongPress={openReactors}
            delayLongPress={350}
            hitSlop={{ top: 4, bottom: 8, left: 8, right: 8 }}
            style={{
              alignSelf: isOwn ? "flex-end" : "flex-start",
              marginLeft: isOwn ? 0 : 6,
              marginRight: isOwn ? 6 : 0,
              marginTop: -5,
              zIndex: 1,
              flexDirection: "row",
              flexWrap: "wrap",
              alignItems: "center",
              gap: 3,
              minHeight: 26,
              paddingHorizontal: 6,
              paddingVertical: 2,
              borderRadius: radii.full,
              backgroundColor: colors.surfaceAlt,
              borderWidth: 2,
              borderColor: colors.background,
            }}
          >
            {groups.map((group) => (
              <Text
                key={group.emoji}
                style={{ fontSize: 14, lineHeight: 18, includeFontPadding: false }}
              >
                {group.emoji}
              </Text>
            ))}
            {total > 1 && (
              <Text style={[type.tiny, { color: colors.textSecondary, paddingHorizontal: 2 }]}>
                {total}
              </Text>
            )}
          </Pressable>
        )}
      </View>
      {editedAt !== undefined && (
        <Text style={[type.tiny, { color: colors.textSecondary, marginHorizontal: spacing.sm }]}>
          Edited
        </Text>
      )}
      {isOwn && status && (
        <Text
          style={[
            type.tiny,
            {
              color: colors.textSecondary,
              textAlign: isOwn ? "right" : "left",
              marginHorizontal: spacing.sm,
              marginTop: total ? 2 : 4,
            },
          ]}
        >
          {status}
        </Text>
      )}

      {showPicker && (
        <EmojiPicker
          selected={mine}
          history={history}
          busy={busy}
          onClose={close}
          onSelect={(emoji) => {
            void react(mine === emoji ? null : emoji);
          }}
        />
      )}

      <Modal
        visible={showReactors}
        transparent
        statusBarTranslucent
        navigationBarTranslucent
        animationType="fade"
        onRequestClose={() => setShowReactors(false)}
      >
        <View style={{ flex: 1, justifyContent: "flex-end", backgroundColor: colors.overlay }}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close reaction details"
            onPress={() => setShowReactors(false)}
            style={{ position: "absolute", top: 0, bottom: 0, left: 0, right: 0 }}
          />
          <View
            accessibilityViewIsModal
            style={{
              backgroundColor: colors.surface,
              borderTopLeftRadius: 30,
              borderTopRightRadius: 30,
              maxHeight: height - insets.top - 24,
              paddingTop: spacing.sm,
              paddingBottom: Math.max(insets.bottom, spacing.lg),
              paddingLeft: Math.max(insets.left, spacing.lg),
              paddingRight: Math.max(insets.right, spacing.lg),
            }}
          >
            <View
              style={{
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "space-between",
                gap: spacing.sm,
              }}
            >
              <Text
                accessibilityRole="header"
                style={[type.title, { color: colors.textPrimary, flex: 1 }]}
              >
                Reactions · {total}
              </Text>
              <IconButton
                plain
                icon="close"
                label="Close reaction details"
                onPress={() => setShowReactors(false)}
              />
            </View>
            <ScrollView
              style={{ flexGrow: 0 }}
              contentContainerStyle={{ paddingBottom: spacing.sm }}
            >
              <Text
                numberOfLines={2}
                style={[type.caption, { color: colors.textSecondary, marginBottom: spacing.md }]}
              >
                {text}
              </Text>
              {groups.flatMap((group) =>
                group.members.map((id) => {
                  const name =
                    nicknames[id] || (id === deviceId ? "You" : `Member ${id.slice(0, 6)}`);
                  const displayName = id === deviceId && name !== "You" ? `${name} (You)` : name;
                  return (
                    <View
                      key={id}
                      accessible
                      accessibilityLabel={`${displayName}: ${group.label}`}
                      style={{
                        flexDirection: "row",
                        alignItems: "center",
                        gap: spacing.md,
                        paddingVertical: spacing.md,
                      }}
                    >
                      <Avatar name={name} photo={profilePhotos[id]} />
                      <Text style={[type.body, { color: colors.textPrimary, flex: 1 }]}>
                        {displayName}
                      </Text>
                      <Text style={{ fontSize: 26 }}>{group.emoji}</Text>
                    </View>
                  );
                }),
              )}
              {total === 0 && (
                <Text style={[type.body, { color: colors.textSecondary }]}>No reactions yet.</Text>
              )}
            </ScrollView>
          </View>
        </View>
      </Modal>

      <Modal
        visible={anchor !== null}
        transparent
        statusBarTranslucent
        navigationBarTranslucent
        animationType="fade"
        onRequestClose={close}
      >
        <View style={{ flex: 1, backgroundColor: colors.overlay }}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close message menu"
            onPress={close}
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
            {onReact && (
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
                      void react(mine === emoji ? null : emoji);
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
                  onPress={() => {
                    setAnchor(null);
                    setShowPicker(true);
                  }}
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
                  { label: "Edit", icon: "create-outline", action: canModify ? onEdit : undefined },
                  { label: "View original", icon: "document-text-outline", action: onViewOriginal },
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
                      close();
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
    </View>
  );
}
