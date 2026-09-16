import { AttachmentComposer } from "../../../../src/components/AttachmentComposer";
import { MessageTextDialog } from "../../../../src/components/MessageTextDialog";
import { VoiceRecorder } from "../../../../src/components/VoiceRecorder";
import { messageGroupDisplay } from "../../../../src/message-groups";
import { useEffect, useRef, useState } from "react";
import { Alert, FlatList, Pressable, Text, View, TextInput } from "react-native";
import { Stack, router, useLocalSearchParams } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { useTheme } from "../../../../src/theme";
import { useCircles, circleLabel, type TimelineItem } from "../../../../src/state/circles";
import { useIdentity } from "../../../../src/state/identity";
import { ScreenContainer } from "../../../../src/components/ScreenContainer";
import { EmptyState } from "../../../../src/components/EmptyState";
import { TimelineEntryView } from "../../../../src/components/TimelineEntry";
import { IconButton } from "../../../../src/components/IconButton";
import { TextField } from "../../../../src/components/TextField";
import { Button } from "../../../../src/components/Button";
import { CircleTabs } from "../../../../src/components/CircleTabs";
import { Notice } from "../../../../src/components/Notice";

export default function CircleDetail() {
  const { circleId } = useLocalSearchParams<{ circleId: string }>();
  const {
    circles,
    timeline,
    sendMessage,
    sendVoiceMessage,
    sendAttachment,
    reactToMessage,
    editMessage,
    deleteMessage,
    notice,
  } = useCircles();
  const { deviceId, nicknames, profilePhotos } = useIdentity();
  const { colors, spacing, type } = useTheme();
  const [textDialog, setTextDialog] = useState<{ item: TimelineItem; editing: boolean } | null>(
    null,
  );
  const [replyTarget, setReplyTarget] = useState<TimelineItem | null>(null);
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const input = useRef<TextInput>(null);
  const jump = useRef<{ index: number; attempts: number } | null>(null);
  const jumpTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!replyTarget) return;
    const timer = setTimeout(() => input.current?.focus(), 250);
    return () => clearTimeout(timer);
  }, [replyTarget]);
  useEffect(() => {
    setReplyTarget(null);
    setTextDialog(null);
    setHighlighted(null);
    jump.current = null;
  }, [circleId]);
  useEffect(() => {
    if (!highlighted) return;
    const timer = setTimeout(() => setHighlighted(null), 2000);
    return () => clearTimeout(timer);
  }, [highlighted]);
  useEffect(
    () => () => {
      if (jumpTimer.current) clearTimeout(jumpTimer.current);
    },
    [],
  );
  const [showAttachments, setShowAttachments] = useState(false);
  const [showRecorder, setShowRecorder] = useState(false);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const list = useRef<FlatList<TimelineItem>>(null);
  const atBottom = useRef(true);
  const circle = circles[circleId];
  if (!circle)
    return (
      <ScreenContainer>
        <EmptyState
          title="This Circle isn't here."
          body={notice ?? "Return to your Circles to accept a new invitation."}
        >
          <Button title="Your Circles" onPress={() => router.replace("/(app)")} />
        </EmptyState>
      </ScreenContainer>
    );
  const entries = timeline.filter(
    (item) => item.circleId === circleId && item.deletedAt === undefined,
  );
  const groups = messageGroupDisplay(entries);
  const canSend =
    circle.role === "member" && !circle.deleting && !circle.recoveryRequired && !circle.syncError;
  const memberName = (id?: string) =>
    id === deviceId ? "You" : (nicknames[id ?? ""] ?? "Circle member");
  const originalFor = (item: TimelineItem) =>
    item.replyTo
      ? timeline.find(
          (original) =>
            original.circleId === circleId &&
            original.kind === "chat" &&
            original.messageId === item.replyTo!.messageId &&
            original.senderId === item.replyTo!.senderId,
        )
      : undefined;
  const goToOriginal = (target: TimelineItem) => {
    const index = entries.findIndex((item) => item.id === target.id);
    if (index < 0) return;
    atBottom.current = false;
    jump.current = { index, attempts: 0 };
    setHighlighted(target.id);
    list.current?.scrollToIndex({ index, viewPosition: 0.5, animated: true });
  };
  const send = async () => {
    if (busy || !message.trim()) return;
    const draft = message;
    const replyingTo = replyTarget;
    setBusy(true);
    try {
      if (await sendMessage(circleId, draft, replyingTo?.id)) {
        setMessage((current) => (current === draft ? "" : current));
        setReplyTarget((current) => (current?.id === replyingTo?.id ? null : current));
        atBottom.current = true;
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <ScreenContainer scroll={false} padded={false}>
      <Stack.Screen
        options={{
          title: circleLabel(circle),
          headerRight: () => (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Circle settings"
              onPress={() =>
                router.push({ pathname: "/circle/[circleId]/manage", params: { circleId } })
              }
              style={{ padding: spacing.md }}
            >
              <Ionicons name="options-outline" size={24} color={colors.accent} />
            </Pressable>
          ),
        }}
      />
      <CircleTabs circleId={circleId} selected="chat" />
      <View
        style={{
          marginHorizontal: 20,
          marginBottom: 8,
          paddingHorizontal: 12,
          paddingVertical: 8,
          flexDirection: "row",
          alignItems: "center",
          gap: 7,
          borderRadius: 12,
          backgroundColor: colors.surfaceAlt,
        }}
      >
        <Ionicons name="lock-closed-outline" size={14} color={colors.accent} />
        <Text style={[type.caption, { color: colors.textSecondary, flex: 1 }]}>
          {circle.role === "member"
            ? `${circle.members.length} ${circle.members.length === 1 ? "member" : "members"} · End-to-end encrypted`
            : circle.role === "joining"
              ? "Your invitation is on its way"
              : "No longer a member"}
        </Text>
      </View>
      {!!circle.pendingSends && (
        <View style={{ paddingHorizontal: spacing.lg }}>
          <Notice
            text={`${circle.pendingSends} message${circle.pendingSends === 1 ? "" : "s"} saved on this phone, waiting to send. Retries are automatic.`}
          />
        </View>
      )}
      {!!circle.pendingCommitEventId && (
        <View style={{ paddingHorizontal: spacing.lg }}>
          <Notice text="Confirming a membership update. New outgoing messages will wait until it is confirmed." />
        </View>
      )}
      {(circle.syncError || circle.recoveryRequired) && (
        <View style={{ paddingHorizontal: spacing.lg }}>
          <Notice
            text={
              circle.syncError ??
              (circle.isCreator
                ? "Refreshing this Circle's connection after restoring saved state. Connect to your server to continue."
                : "This saved membership needs fresh connection keys. Your admin can refresh the Circle or invite you to rejoin in Circle settings.")
            }
          />
        </View>
      )}
      {notice && (
        <View style={{ paddingHorizontal: spacing.lg }}>
          <Notice text={notice} />
        </View>
      )}
      <FlatList
        ref={list}
        data={entries}
        keyExtractor={(item) => item.id}
        style={{ flex: 1 }}
        contentContainerStyle={{
          paddingHorizontal: spacing.lg,
          paddingBottom: spacing.md,
          flexGrow: 1,
        }}
        keyboardShouldPersistTaps="handled"
        onScrollBeginDrag={() => {
          jump.current = null;
        }}
        onScrollToIndexFailed={({ index, averageItemLength }) => {
          if (!jump.current || jump.current.index !== index || jump.current.attempts++ >= 4) return;
          list.current?.scrollToOffset({
            offset: Math.max(0, averageItemLength * index),
            animated: false,
          });
          if (jumpTimer.current) clearTimeout(jumpTimer.current);
          jumpTimer.current = setTimeout(() => {
            if (jump.current?.index === index)
              list.current?.scrollToIndex({ index, viewPosition: 0.5, animated: true });
          }, 180);
        }}
        onScroll={(event) => {
          const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
          atBottom.current = contentSize.height - contentOffset.y - layoutMeasurement.height < 100;
        }}
        scrollEventThrottle={100}
        onContentSizeChange={() => {
          if (atBottom.current) list.current?.scrollToEnd({ animated: true });
        }}
        ListEmptyComponent={
          <EmptyState
            title={
              circle.role === "joining"
                ? "Making introductions…"
                : circle.role === "removed"
                  ? "You're no longer in this Circle."
                  : "A good place to say hello."
            }
            body={
              circle.role === "joining"
                ? "Your admin needs to have their app open to let you in. This usually takes a few seconds."
                : circle.role === "removed"
                  ? "You can't send or read new messages. Your admin can invite you back through Circle settings."
                  : "Say hello. Messages are saved encrypted on this phone."
            }
          />
        }
        renderItem={({ item, index }) => {
          const original = originalFor(item);
          return (
            <TimelineEntryView
              attachment={item.attachment}
              attachmentParts={item.attachmentParts}
              voice={item.voice}
              profilePhotos={profilePhotos}
              senderPhoto={item.senderId ? profilePhotos[item.senderId] : undefined}
              kind={item.kind}
              text={item.text}
              senderName={item.senderId ? memberName(item.senderId) : undefined}
              isOwn={item.senderId === deviceId}
              startsGroup={groups[index].startsGroup}
              endsGroup={groups[index].endsGroup}
              at={item.sentAt ?? item.at}
              editedAt={item.editedAt}
              status={groups[index].status}
              reactions={item.reactions}
              deviceId={deviceId ?? undefined}
              nicknames={nicknames}
              reply={
                item.replyTo
                  ? {
                      available: !!original && original.deletedAt === undefined,
                      name: memberName(original?.senderId),
                      text:
                        original?.deletedAt !== undefined
                          ? "Message deleted"
                          : (original?.text ?? ""),
                    }
                  : undefined
              }
              onGoToReply={
                original && original.deletedAt === undefined
                  ? () => goToOriginal(original)
                  : undefined
              }
              highlighted={highlighted === item.id}
              onViewOriginal={
                item.originalText !== undefined
                  ? () => setTextDialog({ item, editing: false })
                  : undefined
              }
              onEdit={
                canSend &&
                item.messageId &&
                item.senderId === deviceId &&
                !item.voice &&
                !item.attachment
                  ? () => setTextDialog({ item, editing: true })
                  : undefined
              }
              onDelete={
                canSend && item.messageId && item.senderId === deviceId
                  ? () =>
                      Alert.alert(
                        "Delete for everyone?",
                        "This message will be removed from everyone's chat.",
                        [
                          { text: "Cancel", style: "cancel" },
                          {
                            text: "Delete",
                            style: "destructive",
                            onPress: () => {
                              void deleteMessage(circleId, item.id).then((ok) => {
                                if (!ok)
                                  Alert.alert(
                                    "Couldn't delete message",
                                    "You can delete your own messages for 15 minutes after sending.",
                                  );
                              });
                            },
                          },
                        ],
                      )
                  : undefined
              }
              onReply={
                item.kind === "chat" && item.messageId && canSend
                  ? () => setReplyTarget(item)
                  : undefined
              }
              onReact={
                item.messageId && canSend
                  ? (emoji) => reactToMessage(circleId, item.id, emoji)
                  : undefined
              }
            />
          );
        }}
      />
      {circle.role === "member" ? (
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
                style={{ maxHeight: 140, borderRadius: 22, borderWidth: 0, paddingHorizontal: 16 }}
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
        </View>
      ) : circle.role === "removed" ? (
        <View style={{ padding: spacing.lg }}>
          <Notice text="Membership ended. Open Circle settings to request an invitation back." />
        </View>
      ) : null}
      {showAttachments && canSend && (
        <AttachmentComposer
          onClose={() => setShowAttachments(false)}
          onSend={async (attachment) => {
            const replyingTo = replyTarget;
            const sent = await sendAttachment(circleId, attachment, replyingTo?.id);
            if (sent) {
              atBottom.current = true;
              setReplyTarget((current) => (current?.id === replyingTo?.id ? null : current));
            }
            return sent;
          }}
        />
      )}
      {textDialog && (
        <MessageTextDialog
          key={textDialog.item.id + String(textDialog.editing)}
          text={
            textDialog.editing
              ? textDialog.item.text
              : (textDialog.item.originalText ?? textDialog.item.text)
          }
          onClose={() => setTextDialog(null)}
          onSave={
            textDialog.editing
              ? (text) => editMessage(circleId, textDialog.item.id, text)
              : undefined
          }
        />
      )}
      {showRecorder && circle.role === "member" && !circle.deleting && (
        <VoiceRecorder
          replyLabel={replyTarget ? memberName(replyTarget.senderId) : undefined}
          onClose={() => setShowRecorder(false)}
          onSend={async (voice) => {
            const replyingTo = replyTarget;
            const sent = await sendVoiceMessage(circleId, voice, replyingTo?.id);
            if (sent) {
              atBottom.current = true;
              setReplyTarget((current) => (current?.id === replyingTo?.id ? null : current));
            }
            return sent;
          }}
        />
      )}
    </ScreenContainer>
  );
}
