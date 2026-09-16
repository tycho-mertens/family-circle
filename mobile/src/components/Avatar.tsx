import { useState } from "react";
import { Image, Text, View } from "react-native";
import { useTheme } from "../theme";
import { Ionicons } from "@expo/vector-icons";

/** Shared avatar: encrypted profile thumbnail, with an initial fallback. */
export function Avatar({
  name,
  photo,
  size = 40,
}: {
  name?: string;
  photo?: string | null;
  size?: number;
}) {
  const [failedPhoto, setFailedPhoto] = useState<string | null>(null);
  const { colors } = useTheme();
  const initial = name?.trim()?.[0]?.toUpperCase();
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        backgroundColor: colors.accentMuted,
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {photo && photo !== failedPhoto ? (
        <Image
          source={{ uri: photo }}
          accessibilityLabel={`${name ?? "Member"}'s profile photo`}
          onError={() => setFailedPhoto(photo)}
          style={{ width: size, height: size, borderRadius: size / 2 }}
          resizeMode="cover"
        />
      ) : initial ? (
        <Text style={{ color: colors.accent, fontWeight: "700", fontSize: size * 0.42 }}>
          {initial}
        </Text>
      ) : (
        <Ionicons name="person-outline" size={size * 0.45} color={colors.accent} />
      )}
    </View>
  );
}
