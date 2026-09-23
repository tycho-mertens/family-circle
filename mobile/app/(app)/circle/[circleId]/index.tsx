import { canWriteMessages } from "../../../../src/runtime/circle-lifecycle";
import { Ionicons } from "@expo/vector-icons";
import { Stack, router, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { Alert, FlatList, Pressable, Text, View } from "react-native";
import { Button } from "../../../../src/components/Button";
import { CircleTabs } from "../../../../src/components/CircleTabs";
import { EmptyState } from "../../../../src/components/EmptyState";
import { MessageTextDialog } from "../../../../src/components/MessageTextDialog";
import { Notice } from "../../../../src/components/Notice";
import { ScreenContainer } from "../../../../src/components/ScreenContainer";
import { TimelineEntryView } from "../../../../src/components/TimelineEntry";
import { ChatComposer } from "../../../../src/features/chat/ChatComposer";
import { useChatNavigation } from "../../../../src/features/chat/useChatNavigation";
import { messageGroupDisplay } from "../../../../src/message-groups";
import { circleLabel, useCircles, type TimelineItem } from "../../../../src/state/circles";
import { useIdentity } from "../../../../src/state/identity";
import { useTheme } from "../../../../src/theme";

export default function CircleDetail() {
  const { circleId } = useLocalSearchParams<{ circleId: string }>();
  const { circles, timeline, reactToMessage, editMessage, deleteMessage, notice } =
    useCircles();
  const { deviceId, nicknames, profilePhotos } = useIdentity();
  const { colors, spacing, type } = useTheme();
  const [textDialog, setTextDialog] = useState<{ item: TimelineItem; editing: boolean } | null>(
    null,
  );
  const [replyTarget, setReplyTarget] = useState<TimelineItem | null>(null);
  useEffect(() => {
    setReplyTarget(null);
    setTextDialog(null);
  }, [circleId]);
  const entries = timeline.filter(
    (item) => item.circleId === circleId && item.deletedAt === undefined,
  );
  const { list, atBottom, highlighted, goToOriginal, listEvents } = useChatNavigation(
    circleId,
    entries,
  );
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
  const groups = messageGroupDisplay(entries);
  const canSend = canWriteMessages(circle);
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
              (circle.isAdmin
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
        {...listEvents}
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
        <ChatComposer
          key={circleId}
          circleId={circleId}
          canSend={canSend}
          canRecord={circle.role === "member" && !circle.deleting}
          replyTarget={replyTarget}
          setReplyTarget={setReplyTarget}
          memberName={memberName}
          onSent={() => {
            atBottom.current = true;
          }}
        />
      ) : circle.role === "removed" ? (
        <View style={{ padding: spacing.lg }}>
          <Notice text="Membership ended. Open Circle settings to request an invitation back." />
        </View>
      ) : null}
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
    </ScreenContainer>
  );
}
