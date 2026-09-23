import { Marker } from "@maplibre/maplibre-react-native";
import { useEffect, useRef } from "react";
import { Animated, Text, View } from "react-native";
import { Avatar } from "../../components/Avatar";
import type { LocationPin } from "../../location";
import { possiblyOffline } from "../../location-freshness";
import { useIdentity } from "../../state/identity";
import { useTheme } from "../../theme";
import { OfflineBadge } from "./OfflineBadge";
import { age, markerOffset } from "./pin-presentation";

interface Props {
  pin: LocationPin;
  pins: LocationPin[];
  selected: boolean;
  tick: number;
  now: number;
  onSelect: (pin: LocationPin) => void;
}

export function PersonMarker({ pin, pins, selected, tick, now, onSelect }: Props) {
  const { deviceId, nicknames, profilePhotos } = useIdentity();
  const { colors, type } = useTheme();
  const name = nicknames[pin.senderId] ?? "Circle member";
  if (!pin.fix) return null;
  return (
    <Marker
      id={pin.sessionId}
      lngLat={[pin.fix.longitude, pin.fix.latitude]}
      offset={markerOffset(pin, pins)}
      onPress={(event) => {
        event.stopPropagation();
        onSelect(pin);
      }}
    >
      <PinFeedback selected={selected} tick={tick}>
        <View
          accessibilityLabel={`${name}, ${age(pin.fix.observedAt, now)}`}
          style={{ alignItems: "center", padding: 4 }}
        >
          <View
            style={{
              borderWidth: 3,
              borderColor: possiblyOffline(pin.fix, now)
                ? colors.warning
                : selected
                  ? colors.accent
                  : colors.surface,
              borderRadius: 30,
            }}
          >
            <Avatar
              name={nicknames[pin.senderId]}
              photo={profilePhotos[pin.senderId]}
              size={40}
            />
          </View>
          <Text
            style={[
              type.tiny,
              {
                color: colors.textPrimary,
                backgroundColor: colors.surface,
                paddingHorizontal: 8,
                paddingVertical: 3,
                borderRadius: 8,
                marginTop: 2,
              },
            ]}
          >
            {pin.senderId === deviceId ? "You" : name}
          </Text>
          {possiblyOffline(pin.fix, now) && <OfflineBadge />}
        </View>
      </PinFeedback>
    </Marker>
  );
}

function PinFeedback({
  selected,
  tick,
  children,
}: {
  selected: boolean;
  tick: number;
  children: React.ReactNode;
}) {
  const scale = useRef(new Animated.Value(1)).current;
  useEffect(() => {
    scale.setValue(1);
    if (!selected) return;
    const animation = Animated.sequence([
      Animated.timing(scale, { toValue: 1.18, duration: 110, useNativeDriver: true }),
      Animated.spring(scale, { toValue: 1, friction: 5, useNativeDriver: true }),
    ]);
    animation.start();
    return () => animation.stop();
  }, [selected, tick, scale]);
  return <Animated.View style={{ transform: [{ scale }] }}>{children}</Animated.View>;
}
