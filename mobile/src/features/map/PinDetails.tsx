import { Animated, Text, View } from "react-native";
import { Avatar } from "../../components/Avatar";
import { IconButton } from "../../components/IconButton";
import type { LocationPin } from "../../location";
import { possiblyOffline } from "../../location-freshness";
import { useIdentity } from "../../state/identity";
import { useTheme } from "../../theme";
import { OfflineBadge } from "./OfflineBadge";
import { age } from "./pin-presentation";

interface Props {
  pin: LocationPin;
  panelHeight: Animated.Value;
  now: number;
  distanceLabel: string | null;
  onClose: () => void;
}

export function PinDetails({ pin, panelHeight, now, distanceLabel, onClose }: Props) {
  const { deviceId, nicknames, profilePhotos } = useIdentity();
  const { colors, type, radii } = useTheme();
  const name = nicknames[pin.senderId] ?? "Circle member";
  if (!pin.fix) return null;
  return (
    <Animated.View
      style={{
        position: "absolute",
        left: 12,
        right: 12,
        bottom: Animated.add(panelHeight, 12),
        backgroundColor: colors.surface,
        borderRadius: radii.lg,
        padding: 16,
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        shadowColor: "#000",
        shadowOpacity: 0.2,
        shadowRadius: 16,
        shadowOffset: { width: 0, height: 6 },
        elevation: 8,
      }}
    >
      <Avatar
        name={nicknames[pin.senderId]}
        photo={profilePhotos[pin.senderId]}
        size={40}
      />
      <View style={{ flex: 1, gap: 3 }}>
        <Text style={[type.subtitle, { color: colors.textPrimary }]}>
          {name}
          {pin.senderId === deviceId ? " · You" : ""}
        </Text>
        <Text style={[type.body, { color: colors.accent }]}>
          {distanceLabel ?? "Location shared"}
        </Text>
        {possiblyOffline(pin.fix, now) && <OfflineBadge />}
        <Text testID="location-pin-metadata" style={[type.caption, { color: colors.textSecondary }]}>
          {age(pin.fix.observedAt, now)} · ±{Math.round(pin.fix.accuracy)} m
          {pin.fix.batteryPercent != null ? ` · Battery ${pin.fix.batteryPercent}%` : ""}
        </Text>
      </View>
      <IconButton label="Close pin details" icon="close" onPress={onClose} />
    </Animated.View>
  );
}
