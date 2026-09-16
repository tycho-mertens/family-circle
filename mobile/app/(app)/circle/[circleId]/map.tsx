import { useCallback, useEffect, useRef, useState } from "react";
import {
  AppState,
  Animated,
  PanResponder,
  Pressable,
  ScrollView,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { Stack, router, useFocusEffect, useLocalSearchParams } from "expo-router";
import {
  Map as WorldMap,
  Camera,
  Marker,
  LogManager,
  type CameraRef,
} from "@maplibre/maplibre-react-native";
import { Ionicons } from "@expo/vector-icons";
import { useTheme } from "../../../../src/theme";
import { useCircles, circleLabel } from "../../../../src/state/circles";
import { useIdentity } from "../../../../src/state/identity";
import { useLocations } from "../../../../src/state/locations";
import { usePreferences } from "../../../../src/state/preferences";
import { useDistanceLocation } from "../../../../src/use-distance-location";
import { distanceMeters, formatDistance } from "../../../../src/distance";
import { ScreenContainer } from "../../../../src/components/ScreenContainer";
import { CircleTabs } from "../../../../src/components/CircleTabs";
import { Button } from "../../../../src/components/Button";
import { Avatar } from "../../../../src/components/Avatar";
import { IconButton } from "../../../../src/components/IconButton";
import { Notice } from "../../../../src/components/Notice";
import { ShareLocationSheet } from "../../../../src/components/ShareLocationSheet";
import { possiblyOffline } from "../../../../src/location-freshness";
import type { LocationPin } from "../../../../src/location";

LogManager.onLog(() => true);
const mapBase = process.env.EXPO_PUBLIC_MAP_URL?.replace(/\/$/, "");
function age(at: number, now: number) {
  const total = Math.max(0, Math.floor((now - at) / 5000) * 5);
  if (total === 0) return "Just now";
  const seconds = total % 60,
    minutes = Math.floor(total / 60) % 60,
    hours = Math.floor(total / 3600) % 24,
    days = Math.floor(total / 86400);
  return `${days ? `${days} d ` : ""}${total >= 3600 ? `${hours} hr ` : ""}${total >= 60 ? `${minutes} min ` : ""}${seconds} sec ago`;
}
export default function CircleMap() {
  const { circleId } = useLocalSearchParams<{ circleId: string }>();
  const { circles, pollNow } = useCircles();
  const circle = circles[circleId];
  const { deviceId, nicknames, profilePhotos } = useIdentity();
  const locations = useLocations();
  const { colors, type, scheme, spacing, radii } = useTheme();
  const { distanceUnit } = usePreferences();
  const { height } = useWindowDimensions();
  const camera = useRef<CameraRef>(null);
  const [selectionTick, setSelectionTick] = useState(0);
  const [sheet, setSheet] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [mapFailed, setMapFailed] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [overviewOnly, setOverviewOnly] = useState(false);
  const centered = useRef(false);
  const [peopleCollapsed, setPeopleCollapsed] = useState(false);
  const panelCollapsedHeight = 112;
  const panelExpandedHeight = Math.min(height * 0.44, 360);
  const panelHeight = useRef(new Animated.Value(panelExpandedHeight)).current;
  const panelHeightRef = useRef(panelExpandedHeight);
  const panelDragStartHeight = useRef(panelExpandedHeight);
  const peopleCollapsedRef = useRef(false);
  const panelBounds = useRef({ collapsed: panelCollapsedHeight, expanded: panelExpandedHeight });
  panelBounds.current = { collapsed: panelCollapsedHeight, expanded: panelExpandedHeight };
  const settlePeoplePanel = useCallback(
    (collapsed: boolean) => {
      const target = collapsed ? panelBounds.current.collapsed : panelBounds.current.expanded;
      peopleCollapsedRef.current = collapsed;
      setPeopleCollapsed(collapsed);
      panelHeight.stopAnimation();
      Animated.spring(panelHeight, {
        toValue: target,
        useNativeDriver: false,
        stiffness: 280,
        damping: 30,
        mass: 0.7,
      }).start(({ finished }) => {
        if (finished) panelHeightRef.current = target;
      });
    },
    [panelHeight],
  );
  const settlePeoplePanelRef = useRef(settlePeoplePanel);
  settlePeoplePanelRef.current = settlePeoplePanel;
  const peoplePanelGesture = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponder: (_, gesture) =>
        Math.abs(gesture.dy) > 8 && Math.abs(gesture.dy) > Math.abs(gesture.dx),
      onPanResponderGrant: () => {
        panelHeight.stopAnimation((value) => {
          panelHeightRef.current = value;
          panelDragStartHeight.current = value;
        });
      },
      onPanResponderMove: (_, gesture) => {
        const { collapsed, expanded } = panelBounds.current;
        const next = Math.max(
          collapsed,
          Math.min(expanded, panelDragStartHeight.current - gesture.dy),
        );
        panelHeight.setValue(next);
        panelHeightRef.current = next;
      },
      onPanResponderRelease: (_, gesture) => {
        const { collapsed, expanded } = panelBounds.current;
        const midpoint = (collapsed + expanded) / 2;
        const shouldCollapse =
          gesture.vy > 0.35 || (gesture.vy >= -0.35 && panelHeightRef.current < midpoint);
        settlePeoplePanelRef.current(shouldCollapse);
      },
      onPanResponderTerminate: () =>
        settlePeoplePanelRef.current(
          panelHeightRef.current <
            (panelBounds.current.collapsed + panelBounds.current.expanded) / 2,
        ),
    }),
  ).current;
  useEffect(() => {
    const target = peopleCollapsedRef.current
      ? panelBounds.current.collapsed
      : panelBounds.current.expanded;
    panelHeight.stopAnimation();
    panelHeight.setValue(target);
    panelHeightRef.current = target;
  }, [panelExpandedHeight, panelHeight]);
  useFocusEffect(
    useCallback(() => {
      let timer: ReturnType<typeof setInterval> | undefined;
      let syncTimer: ReturnType<typeof setInterval> | undefined;
      let syncing = false;
      const syncNow = async () => {
        // Calling pollNow while its coordinator is running queues another pass,
        // by design. A fixed timer therefore has to suppress overlap, or it can
        // keep that promise alive forever and block anything waiting on it.
        if (syncing) return;
        syncing = true;
        try {
          await pollNow();
        } catch {
          /* The next visible-map pass retries. */
        } finally {
          syncing = false;
        }
      };
      const updateTimer = () => {
        if (timer) clearInterval(timer);
        if (syncTimer) clearInterval(syncTimer);
        if (AppState.currentState === "active") {
          setNow(Date.now());
          void syncNow();
          timer = setInterval(() => setNow(Date.now()), 5000);
          // A person viewing the map needs prompt snapshots even when they are
          // not sharing locally and a transient socket hint was missed.
          syncTimer = setInterval(() => {
            void syncNow();
          }, 5000);
        }
      };
      updateTimer();
      const subscription = AppState.addEventListener("change", updateTimer);
      return () => {
        if (timer) clearInterval(timer);
        if (syncTimer) clearInterval(syncTimer);
        subscription.remove();
      };
    }, [pollNow]),
  );
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
  const share = locations.state.shares.find((s) => s.circleId === circleId);
  const active = !!share?.active;
  const selectedPin = pins.find((p) => p.sessionId === selected);
  const name = (p: LocationPin) => nicknames[p.senderId] ?? "Circle member";
  const away = (p: LocationPin) =>
    p.senderId !== deviceId && distance.origin && p.fix
      ? `${formatDistance(distanceMeters(distance.origin, p.fix), distanceUnit)} away`
      : null;
  const select = (p: LocationPin) => {
    setSelected(p.sessionId);
    setSelectionTick((t) => t + 1);
  };
  // The People sheet overlays the lower map. Keep focused pins inside the
  // visible viewport rather than centering them behind the sheet.
  const cameraPadding = () => ({
    top: 70,
    right: 50,
    bottom: Math.round(panelHeightRef.current) + 24,
    left: 50,
  });
  const focus = (p: LocationPin) => {
    select(p);
    camera.current?.flyTo({
      center: [p.fix!.longitude, p.fix!.latitude],
      zoom: 14,
      padding: cameraPadding(),
      duration: 600,
    });
  };
  const fit = () => {
    if (pins.length === 1) {
      focus(pins[0]);
      return;
    }
    if (!pins.length) {
      if (distance.origin)
        camera.current?.flyTo({
          center: [distance.origin.longitude, distance.origin.latitude],
          zoom: 13,
          duration: 600,
        });
      return;
    }
    const xs = pins.map((p) => p.fix!.longitude),
      ys = pins.map((p) => p.fix!.latitude);
    camera.current?.fitBounds(
      [
        Math.min(...xs) - 0.003,
        Math.min(...ys) - 0.003,
        Math.max(...xs) + 0.003,
        Math.max(...ys) + 0.003,
      ],
      { duration: 600, padding: cameraPadding() },
    );
  };
  // Nearby members can otherwise occupy the same native marker view. This
  // changes only the annotation's screen offset, never its true coordinate.
  const markerOffset = (pin: LocationPin): [number, number] => {
    const nearby = pins
      .filter((other) => other.fix && pin.fix && distanceMeters(pin.fix, other.fix) < 100)
      .sort((a, b) => a.sessionId.localeCompare(b.sessionId));
    if (nearby.length < 2) return [0, 0];
    const index = nearby.findIndex((other) => other.sessionId === pin.sessionId);
    const angle = (Math.PI * 2 * index) / nearby.length - Math.PI / 2;
    return [Math.round(Math.cos(angle) * 28), Math.round(Math.sin(angle) * 28)];
  };
  useEffect(() => {
    if (pins.length && !centered.current) {
      const t = setTimeout(() => {
        fit();
        centered.current = true;
      }, 400);
      return () => clearTimeout(t);
    }
  }, [pins.length]);
  if (!circle)
    return (
      <ScreenContainer>
        <Text style={[type.title, { color: colors.textPrimary }]}>Circle unavailable</Text>
        <Button title="Your Circles" onPress={() => router.replace("/(app)")} />
      </ScreenContainer>
    );
  const pendingStop = locations.state.pending.some(
    (p) => p.stopped && p.sessionId === share?.sessionId,
  );
  const stopTime = share?.expiresAt
    ? new Date(share.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : null;
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
                router.push({ pathname: "/circle/[circleId]/manage", params: { circleId } })
              }
            />
          ),
        }}
      />
      <CircleTabs circleId={circleId} selected="map" />
      <View
        style={{ flex: 1, minHeight: 160, overflow: "hidden", backgroundColor: colors.surfaceAlt }}
      >
        {mapBase ? (
          <WorldMap
            onPress={() => setSelected(null)}
            style={{ flex: 1 }}
            mapStyle={`${mapBase}/styles/${scheme}.json?v=2`}
            logo={false}
            onDidFailLoadingMap={() => setMapFailed(true)}
            onDidFinishLoadingMap={() => setMapFailed(false)}
          >
            <Camera ref={camera} initialViewState={{ center: [0, 20], zoom: 1 }} />
            {pins.map((p) => (
              <Marker
                key={p.sessionId}
                id={p.sessionId}
                lngLat={[p.fix!.longitude, p.fix!.latitude]}
                offset={markerOffset(p)}
                onPress={(event) => {
                  event.stopPropagation();
                  select(p);
                }}
              >
                <PinFeedback selected={selected === p.sessionId} tick={selectionTick}>
                  <View
                    accessibilityLabel={`${name(p)}, ${age(p.fix!.observedAt, now)}`}
                    style={{ alignItems: "center", padding: 4 }}
                  >
                    <View
                      style={{
                        borderWidth: 3,
                        borderColor: possiblyOffline(p.fix, now)
                          ? colors.warning
                          : selected === p.sessionId
                            ? colors.accent
                            : colors.surface,
                        borderRadius: 30,
                      }}
                    >
                      <Avatar
                        name={nicknames[p.senderId]}
                        photo={profilePhotos[p.senderId]}
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
                      {p.senderId === deviceId ? "You" : name(p)}
                    </Text>
                    {possiblyOffline(p.fix, now) && <OfflineBadge />}
                  </View>
                </PinFeedback>
              </Marker>
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
              name={nicknames[selectedPin.senderId]}
              photo={profilePhotos[selectedPin.senderId]}
              size={40}
            />
            <View style={{ flex: 1, gap: 3 }}>
              <Text style={[type.subtitle, { color: colors.textPrimary }]}>
                {name(selectedPin)}
                {selectedPin.senderId === deviceId ? " · You" : ""}
              </Text>
              <Text style={[type.body, { color: colors.accent }]}>
                {away(selectedPin) ?? "Location shared"}
              </Text>
              {possiblyOffline(selectedPin.fix, now) && <OfflineBadge />}
              <Text style={[type.caption, { color: colors.textSecondary }]}>
                {age(selectedPin.fix.observedAt, now)} · ±{Math.round(selectedPin.fix.accuracy)} m
                {selectedPin.fix.batteryPercent != null
                  ? ` · Battery ${selectedPin.fix.batteryPercent}%`
                  : ""}
              </Text>
            </View>
            <IconButton label="Close pin details" icon="close" onPress={() => setSelected(null)} />
          </Animated.View>
        )}
        <Animated.View
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            bottom: 0,
            height: panelHeight,
            backgroundColor: colors.surface,
            borderTopLeftRadius: 28,
            borderTopRightRadius: 28,
            overflow: "hidden",
            shadowColor: "#000",
            shadowOpacity: 0.12,
            shadowRadius: 14,
            shadowOffset: { width: 0, height: -4 },
            elevation: 8,
          }}
        >
          <View
            {...peoplePanelGesture.panHandlers}
            accessibilityLabel={
              peopleCollapsed
                ? "Drag up to show the people list"
                : "Drag down to hide the people list"
            }
            style={{ height: 20, alignItems: "center", justifyContent: "center" }}
          >
            <View
              style={{ width: 38, height: 4, borderRadius: 4, backgroundColor: colors.border }}
            />
          </View>
          <View
            style={{
              paddingHorizontal: 20,
              paddingTop: peopleCollapsed ? 6 : 10,
              paddingBottom: peopleCollapsed ? 10 : 16,
              flexDirection: "row",
              alignItems: "center",
              gap: 12,
              borderBottomWidth: peopleCollapsed ? 0 : 1,
              borderColor: colors.border,
            }}
          >
            <View style={{ flex: 1, gap: 4 }}>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                <View
                  style={{
                    width: 7,
                    height: 7,
                    borderRadius: 4,
                    backgroundColor: active ? colors.success : colors.textSecondary,
                  }}
                />
                <Text style={[type.subtitle, { color: colors.textPrimary }]}>
                  {active ? "You're sharing" : "Your location is private"}
                </Text>
              </View>
              <Text style={[type.caption, { color: colors.textSecondary }]}>
                {active
                  ? `${stopTime ? `Until ${stopTime}` : "Until you stop"} · Every ${share!.interval / 60000} min`
                  : "Share only when you choose"}
              </Text>
            </View>
            {active ? (
              <>
                <IconButton
                  label="Sharing settings"
                  icon="options-outline"
                  onPress={() => setSheet(true)}
                />
                <Button
                  title="Stop"
                  variant="danger"
                  loading={locations.busy}
                  onPress={() => locations.stop(circleId)}
                />
              </>
            ) : (
              <Button
                title="Share location"
                disabled={!locations.ready || locations.busy || circle.role !== "member"}
                onPress={() => setSheet(true)}
              />
            )}
          </View>
          {!peopleCollapsed && (
            <ScrollView
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={{ paddingHorizontal: 20, paddingVertical: 14, gap: 12 }}
            >
              {(locations.error || mapFailed || distance.error || pendingStop) && (
                <Notice
                  text={
                    pendingStop
                      ? "Stopped here. Removing your pin when connected."
                      : (locations.error ??
                        distance.error ??
                        "Map couldn't load. Locations are listed below.")
                  }
                />
              )}
              {active && locations.nativeStatus && <Notice text={locations.nativeStatus} />}
              <View
                style={{
                  flexDirection: "row",
                  alignItems: "center",
                  justifyContent: "space-between",
                }}
              >
                <Text style={[type.subtitle, { color: colors.textPrimary }]}>
                  People · {pins.length} sharing
                </Text>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Location settings"
                  onPress={() => router.push("/(app)/location-settings")}
                  style={{ minHeight: 32, justifyContent: "center" }}
                >
                  <Text style={[type.caption, { color: colors.accent }]}>Phone settings</Text>
                </Pressable>
              </View>
              {pins.length === 0 && (
                <Text style={[type.body, { color: colors.textSecondary }]}>
                  Shared locations will appear here. Everyone controls their own sharing.
                </Text>
              )}
              {pins.map((p) => (
                <Pressable
                  key={p.sessionId}
                  accessibilityRole="button"
                  accessibilityLabel={`Find ${name(p)}`}
                  onPress={() => focus(p)}
                  accessibilityState={{ selected: selected === p.sessionId }}
                  style={({ pressed }) => ({
                    flexDirection: "row",
                    alignItems: "center",
                    gap: 12,
                    minHeight: 60,
                    paddingHorizontal: 8,
                    borderRadius: radii.md,
                    backgroundColor:
                      pressed || selected === p.sessionId ? colors.surfaceAlt : "transparent",
                  })}
                >
                  <Avatar
                    name={nicknames[p.senderId]}
                    photo={profilePhotos[p.senderId]}
                    size={40}
                  />
                  <View style={{ flex: 1, gap: 4 }}>
                    <Text style={[type.subtitle, { color: colors.textPrimary }]}>
                      {name(p)}
                      {p.senderId === deviceId ? " · You" : ""}
                    </Text>
                    {possiblyOffline(p.fix, now) && <OfflineBadge />}
                    <Text style={[type.caption, { color: colors.textSecondary }]}>
                      {age(p.fix!.observedAt, now)}
                      {p.fix!.batteryPercent != null ? ` · Battery ${p.fix!.batteryPercent}%` : ""}
                    </Text>
                  </View>
                  <Text style={[type.subtitle, { color: colors.accent }]}>
                    {away(p) ?? (p.senderId === deviceId ? "" : "—")}
                  </Text>
                  <Ionicons name="chevron-forward" size={16} color={colors.textSecondary} />
                </Pressable>
              ))}
              <Text style={[type.tiny, { color: colors.textSecondary }]}>
                {distance.origin
                  ? `Approximate straight-line distances · Your position: ${age(distance.origin.observedAt, now).toLowerCase()}`
                  : distance.busy
                    ? "Calculating distances…"
                    : "Enable location or tap locate to calculate distances."}
                {overviewOnly ? " · Overview map only" : ""}
              </Text>
            </ScrollView>
          )}
        </Animated.View>
      </View>
      <ShareLocationSheet circleId={circleId} visible={sheet} onClose={() => setSheet(false)} />
    </ScreenContainer>
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

function OfflineBadge() {
  const { colors, type } = useTheme();
  return (
    <View
      style={{
        alignSelf: "flex-start",
        flexDirection: "row",
        alignItems: "center",
        gap: 5,
        backgroundColor: colors.warningSurface,
        borderColor: colors.warning,
        borderWidth: 1,
        borderRadius: 8,
        paddingHorizontal: 8,
        paddingVertical: 4,
        marginTop: 3,
      }}
    >
      <Ionicons name="warning" size={15} color={colors.warningText} />
      <Text style={[type.caption, { fontWeight: "700", color: colors.warningText }]}>
        Possibly offline
      </Text>
    </View>
  );
}
