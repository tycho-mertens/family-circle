import { useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { ChatAttachment } from "../attachment";
import { MessageMenu, type MessageMenuAnchor } from "../features/chat/MessageMenu";
import { ReactionDetails } from "../features/chat/ReactionDetails";
import { rememberReaction, useReactionHistory } from "../reaction-history";
import { doubleTapReaction, quickReactions, reactionLabel } from "../reactions";
import { useTheme } from "../theme";
import type { VoiceMessage } from "../voice-message";
import { AttachmentView } from "./AttachmentView";
import { Avatar } from "./Avatar";
import { EmojiPicker } from "./EmojiPicker";
import { ReplyPreview, type ReplyPreviewData } from "./ReplyPreview";
import { VoicePlayer } from "./VoicePlayer";

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
  const bubble = useRef<View>(null);
  const [anchor, setAnchor] = useState<MessageMenuAnchor | null>(null);
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
      testID="chat-message-row"
      collapsable={false}
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
          style={{
            flexDirection: "row",
            alignItems: "center",
            gap: spacing.sm,
            marginBottom: 2,
          }}
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
            testID="chat-message-reactions"
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
        <Text
          style={[type.tiny, { color: colors.textSecondary, marginHorizontal: spacing.sm }]}
        >
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

      <ReactionDetails
        visible={showReactors}
        onClose={() => setShowReactors(false)}
        groups={groups}
        total={total}
        text={text}
        nicknames={nicknames}
        deviceId={deviceId}
        profilePhotos={profilePhotos}
      />

      <MessageMenu
        anchor={anchor}
        onClose={close}
        isOwn={isOwn}
        senderName={senderName}
        at={at}
        editedAt={editedAt}
        text={text}
        canReact={!!onReact}
        hotbar={hotbar}
        mine={mine}
        busy={busy}
        onReact={react}
        onMoreEmoji={() => {
          setAnchor(null);
          setShowPicker(true);
        }}
        onReply={onReply}
        onEdit={onEdit}
        onViewOriginal={onViewOriginal}
        onDelete={onDelete}
      />
    </View>
  );
}
