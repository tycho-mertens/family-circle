import { useIdentity } from "../state/identity";
import type { ReactNode } from "react";
import { Text, View } from "react-native";
import { useTheme } from "../theme";
import { Avatar } from "./Avatar";

interface Props {
  id: string;
  nickname?: string;
  isYou?: boolean;
  isAdmin?: boolean;
  trailing?: ReactNode;
  showId?: boolean;
}

/** Member avatar, display name, role badges, and an optional trailing action. */
export function MemberRow({ id, nickname, isYou, isAdmin, trailing, showId = false }: Props) {
  const { profilePhotos } = useIdentity();
  const { colors, spacing, type } = useTheme();
  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: spacing.md,
        paddingVertical: spacing.sm,
      }}
    >
      <Avatar photo={profilePhotos[id]} name={nickname} size={40} />
      <View style={{ flex: 1 }}>
        <Text style={[type.body, { color: colors.textPrimary }]} numberOfLines={1}>
          {nickname ?? "Unnamed device"}
          {isYou ? " (you)" : ""}
        </Text>
        {(showId || isAdmin) && (
          <Text style={[type.tiny, { color: colors.textSecondary }]} numberOfLines={1}>
            {isAdmin ? "Admin" : ""}
            {showId ? ` ${id}` : ""}
          </Text>
        )}
      </View>
      {trailing}
    </View>
  );
}
