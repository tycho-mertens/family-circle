import { Pressable, Text } from "react-native";
import { useTheme } from "../theme";

export interface ReplyPreviewData {
  name: string;
  text: string;
  available: boolean;
}
export function ReplyPreview({
  reply,
  isOwn = false,
  onPress,
}: {
  reply: ReplyPreviewData;
  isOwn?: boolean;
  onPress?: () => void;
}) {
  const { colors, type } = useTheme();
  const foreground = isOwn ? colors.textOnAccent : colors.textPrimary;
  return (
    <Pressable
      accessibilityRole={onPress ? "button" : undefined}
      accessibilityLabel={
        reply.available
          ? `Reply to ${reply.name}: ${reply.text}`
          : reply.text || "Original message isn't on this phone"
      }
      accessibilityHint={onPress ? "Go to original message" : undefined}
      onPress={onPress}
      style={{
        borderLeftWidth: 3,
        borderLeftColor: isOwn ? colors.textOnAccent : colors.accent,
        borderRadius: 6,
        paddingHorizontal: 10,
        paddingVertical: 8,
        marginBottom: 8,
        backgroundColor: isOwn ? "#FFFFFF20" : colors.accentMuted,
      }}
    >
      {reply.available && (
        <Text numberOfLines={1} style={[type.caption, { color: foreground, fontWeight: "600" }]}>
          {reply.name}
        </Text>
      )}
      <Text numberOfLines={2} style={[type.caption, { color: foreground, opacity: 0.85 }]}>
        {reply.available ? reply.text : reply.text || "Original message isn't on this phone"}
      </Text>
    </Pressable>
  );
}
