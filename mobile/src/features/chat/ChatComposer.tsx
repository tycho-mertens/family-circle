import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { Text, TextInput, View } from "react-native";
import { useCircles, type TimelineItem } from "../../state/circles";
import { useTheme } from "../../theme";
import { AttachmentComposer } from "../../components/AttachmentComposer";
import { VoiceRecorder } from "../../components/VoiceRecorder";
import { IconButton } from "../../components/IconButton";
import { TextField } from "../../components/TextField";

interface Props {
  circleId: string;
  canSend: boolean;
  canRecord: boolean;
  replyTarget: TimelineItem | null;
  setReplyTarget: Dispatch<SetStateAction<TimelineItem | null>>;
  memberName: (id?: string) => string;
  onSent: () => void;
}

export function ChatComposer({
  circleId,
  canSend,
  canRecord,
  replyTarget,
  setReplyTarget,
  memberName,
  onSent,
}: Props) {
  const { sendMessage, sendAttachment, sendVoiceMessage } = useCircles();
  const { colors, spacing, type } = useTheme();
  const [showAttachments, setShowAttachments] = useState(false);
  const [showRecorder, setShowRecorder] = useState(false);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const input = useRef<TextInput>(null);
  useEffect(() => {
    if (!replyTarget) return;
    const timer = setTimeout(() => input.current?.focus(), 250);
    return () => clearTimeout(timer);
  }, [replyTarget]);
  const send = async () => {
    if (busy || !message.trim()) return;
    const draft = message;
    const replyingTo = replyTarget;
    setBusy(true);
    try {
      if (await sendMessage(circleId, draft, replyingTo?.id)) {
        setMessage((current) => (current === draft ? "" : current));
        setReplyTarget((current) => (current?.id === replyingTo?.id ? null : current));
        onSent();
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <View
        style={{
          paddingHorizontal: spacing.md,
          paddingTop: spacing.sm,
          paddingBottom: Math.max(spacing.sm, 10),
          borderTopWidth: 1,
          borderColor: colors.border,
          backgroundColor: colors.surface,
        }}
      >
        {replyTarget && (
          <View
            style={{ flexDirection: "row", alignItems: "center", gap: 8, paddingVertical: 8 }}
          >
            <View
              style={{
                flex: 1,
                borderLeftWidth: 3,
                borderLeftColor: colors.accent,
                paddingLeft: 10,
                gap: 2,
              }}
            >
              <Text
                numberOfLines={1}
                style={[type.caption, { color: colors.accent, fontWeight: "600" }]}
              >
                Replying to {memberName(replyTarget.senderId)}
              </Text>
              <Text numberOfLines={2} style={[type.caption, { color: colors.textSecondary }]}>
                {replyTarget.text}
              </Text>
            </View>
            <IconButton
              plain
              label="Cancel reply"
              icon="close"
              onPress={() => setReplyTarget(null)}
            />
          </View>
        )}
        <View style={{ flexDirection: "row", alignItems: "flex-end", gap: spacing.sm }}>
          <IconButton
            label="Add attachment"
            icon="add"
            disabled={busy || !canSend}
            onPress={() => setShowAttachments(true)}
          />
          <View style={{ flex: 1 }}>
            <TextField
              inputRef={input}
              placeholder="Message"
              accessibilityLabel="Message"
              value={message}
              onChangeText={setMessage}
              multiline
              maxLength={10000}
              style={{
                maxHeight: 140,
                borderRadius: 22,
                borderWidth: 0,
                paddingHorizontal: 16,
              }}
            />
          </View>
          {!message.trim() && (
            <IconButton
              label="Record voice message"
              icon="mic-outline"
              disabled={busy || !canSend}
              onPress={() => setShowRecorder(true)}
            />
          )}
          <IconButton
            label="Send message"
            icon="arrow-up"
            filled
            loading={busy}
            disabled={!message.trim() || !canSend}
            onPress={send}
          />
        </View>
      </View>{" "}
      {showAttachments && canSend && (
        <AttachmentComposer
          onClose={() => setShowAttachments(false)}
          onSend={async (attachment) => {
            const replyingTo = replyTarget;
            const sent = await sendAttachment(circleId, attachment, replyingTo?.id);
            if (sent) {
              onSent();
              setReplyTarget((current) => (current?.id === replyingTo?.id ? null : current));
            }
            return sent;
          }}
        />
      )}
      {showRecorder && canRecord && (
        <VoiceRecorder
          replyLabel={replyTarget ? memberName(replyTarget.senderId) : undefined}
          onClose={() => setShowRecorder(false)}
          onSend={async (voice) => {
            const replyingTo = replyTarget;
            const sent = await sendVoiceMessage(circleId, voice, replyingTo?.id);
            if (sent) {
              onSent();
              setReplyTarget((current) => (current?.id === replyingTo?.id ? null : current));
            }
            return sent;
          }}
        />
      )}
    </>
  );
}
