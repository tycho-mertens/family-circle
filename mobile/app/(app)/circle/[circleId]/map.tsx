import { PersonMarker } from "../../../../src/features/map/PersonMarker";
import { PinDetails } from "../../../../src/features/map/PinDetails";
import { MapPeoplePanel } from "../../../../src/features/map/MapPeoplePanel";
import { Camera, LogManager, Map as WorldMap } from "@maplibre/maplibre-react-native";
import { Stack, router, useLocalSearchParams } from "expo-router";
import { useEffect, useState } from "react";
import { Text, View, useWindowDimensions } from "react-native";
import { Button } from "../../../../src/components/Button";
import { CircleTabs } from "../../../../src/components/CircleTabs";
import { IconButton } from "../../../../src/components/IconButton";
import { ScreenContainer } from "../../../../src/components/ScreenContainer";
import { ShareLocationSheet } from "../../../../src/components/ShareLocationSheet";
import { distanceMeters, formatDistance } from "../../../../src/distance";
import { useMapCamera } from "../../../../src/features/map/useMapCamera";
import { useMapRefresh } from "../../../../src/features/map/useMapRefresh";
import { usePeoplePanel } from "../../../../src/features/map/usePeoplePanel";
import type { LocationPin } from "../../../../src/location";
import { circleLabel, useCircles } from "../../../../src/state/circles";
import { useIdentity } from "../../../../src/state/identity";
import { useLocations } from "../../../../src/state/locations";
import { usePreferences } from "../../../../src/state/preferences";
import { useTheme } from "../../../../src/theme";
import { useDistanceLocation } from "../../../../src/use-distance-location";

LogManager.onLog(() => true);
const mapBase = process.env.EXPO_PUBLIC_MAP_URL?.replace(/\/$/, "");
export default function CircleMap() {
  const { circleId } = useLocalSearchParams<{ circleId: string }>();
  const { circles, pollNow } = useCircles();
  const circle = circles[circleId];
  const { deviceId } = useIdentity();
  const locations = useLocations();
  const { colors, type, scheme } = useTheme();
  const { distanceUnit } = usePreferences();
  const { height } = useWindowDimensions();
  const [sheet, setSheet] = useState(false);
  const [mapFailed, setMapFailed] = useState(false);
  const now = useMapRefresh(pollNow);
  const [overviewOnly, setOverviewOnly] = useState(false);
  const panel = usePeoplePanel(height);
  useEffect(() => {
    let active = true;
    if (mapBase)
      void fetch(`${mapBase}/coverage.json`, { signal: AbortSignal.timeout(10000) })
        .then((r) => r.json())
        .then((c) => {
          if (active) setOverviewOnly(c.development === true);
        })
        .catch(() => {});
    return () => {
      active = false;
    };
  }, []);
  const pins = locations.state.pins.filter(
    (p) =>
      p.circleId === circleId &&
      p.fix &&
      circle?.role === "member" &&
      circle.members.includes(p.senderId),
  );
  const ownFix =
    locations.state.pins
      .filter((p) => p.senderId === deviceId && p.fix)
      .sort((a, b) => b.fix!.observedAt - a.fix!.observedAt)[0]?.fix ?? null;
  const distance = useDistanceLocation(ownFix);
  const away = (p: LocationPin) =>
    p.senderId !== deviceId && distance.origin && p.fix
      ? `${formatDistance(distanceMeters(distance.origin, p.fix), distanceUnit)} away`
      : null;
  const { camera, selected, selectionTick, select, focus, fit, clearSelection } =
    useMapCamera(pins, distance.origin, panel.panelHeightRef);
  const selectedPin = pins.find((pin) => pin.sessionId === selected);
  if (!circle)
    return (
      <ScreenContainer>
        <Text style={[type.title, { color: colors.textPrimary }]}>
          Circle unavailable
        </Text>
        <Button title="Your Circles" onPress={() => router.replace("/(app)")} />
      </ScreenContainer>
    );
  return (
    <ScreenContainer scroll={false} padded={false}>
      <Stack.Screen
        options={{
          title: circleLabel(circle),
          headerRight: () => (
            <IconButton
              label="Circle settings"
              icon="options-outline"
              onPress={() =>
                router.push({
                  pathname: "/circle/[circleId]/manage",
                  params: { circleId },
                })
              }
            />
          ),
        }}
      />
      <CircleTabs circleId={circleId} selected="map" />
      <View
        style={{
          flex: 1,
          minHeight: 160,
          overflow: "hidden",
          backgroundColor: colors.surfaceAlt,
        }}
      >
        {mapBase ? (
          <WorldMap
            onPress={clearSelection}
            style={{ flex: 1 }}
            mapStyle={`${mapBase}/styles/${scheme}.json?v=2`}
            logo={false}
            onDidFailLoadingMap={() => setMapFailed(true)}
            onDidFinishLoadingMap={() => setMapFailed(false)}
          >
            <Camera ref={camera} initialViewState={{ center: [0, 20], zoom: 1 }} />
            {pins.map((pin) => (
              <PersonMarker
                key={pin.sessionId}
                pin={pin}
                pins={pins}
                selected={selected === pin.sessionId}
                tick={selectionTick}
                now={now}
                onSelect={select}
              />
            ))}
          </WorldMap>
        ) : (
          <View style={{ padding: 24 }}>
            <Text style={[type.body, { color: colors.textSecondary }]}>
              Map unavailable. You can still manage sharing below.
            </Text>
          </View>
        )}
        <View style={{ position: "absolute", right: 12, top: 12, gap: 8 }}>
          <IconButton label="Show everyone" icon="scan-outline" onPress={fit} />
          <IconButton
            label="Use my location for distances"
            icon="locate-outline"
            disabled={distance.busy}
            onPress={distance.refresh}
          />
        </View>
        {selectedPin?.fix && (
          <PinDetails
            pin={selectedPin}
            panelHeight={panel.panelHeight}
            now={now}
            distanceLabel={away(selectedPin)}
            onClose={clearSelection}
          />
        )}
        <MapPeoplePanel
          circleId={circleId}
          role={circle.role}
          pins={pins}
          selected={selected}
          now={now}
          distance={distance}
          panel={panel}
          overviewOnly={overviewOnly}
          mapFailed={mapFailed}
          away={away}
          focus={focus}
          onOpenSharing={() => setSheet(true)}
        />
      </View>
      <ShareLocationSheet
        circleId={circleId}
        visible={sheet}
        onClose={() => setSheet(false)}
      />
    </ScreenContainer>
  );
}
