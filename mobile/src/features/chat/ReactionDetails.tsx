import { Modal, Pressable, ScrollView, Text, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTheme } from "../../theme";
import { Avatar } from "../../components/Avatar";
import { IconButton } from "../../components/IconButton";

interface Props {
  visible: boolean;
  onClose: () => void;
  groups: { emoji: string; label: string; members: string[] }[];
  total: number;
  text: string;
  nicknames: Record<string, string>;
  deviceId?: string;
  profilePhotos: Record<string, string | null>;
}

export function ReactionDetails({
  visible,
  onClose,
  groups,
  total,
  text,
  nicknames,
  deviceId,
  profilePhotos,
}: Props) {
  const { colors, spacing, type } = useTheme();
  const { height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  return (
    <Modal
      visible={visible}
      transparent
      statusBarTranslucent
      navigationBarTranslucent
      animationType="fade"
      onRequestClose={onClose}
    >
      <View style={{ flex: 1, justifyContent: "flex-end", backgroundColor: colors.overlay }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close reaction details"
          onPress={onClose}
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
            <IconButton plain icon="close" label="Close reaction details" onPress={onClose} />
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
              <Text style={[type.body, { color: colors.textSecondary }]}>
                No reactions yet.
              </Text>
            )}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}
