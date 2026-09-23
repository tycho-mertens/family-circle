import test from "node:test";
import assert from "node:assert/strict";
import * as React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import { loadTypeScriptModule } from "./helpers/typescript-module.mjs";

const handlers = new Map();
const container = ({ children }) => React.createElement("div", null, children);
const button = ({
  children,
  accessibilityLabel,
  accessibilityState,
  disabled,
  title,
  onPress,
}) => {
  const label = accessibilityLabel ?? title;
  handlers.set(label, disabled ? undefined : onPress);
  return React.createElement(
    "button",
    {
      "aria-label": label,
      "aria-pressed": accessibilityState?.selected,
      disabled,
    },
    children ?? title,
  );
};
class Value {
  constructor(value) {
    this.value = value;
  }
  setValue(value) {
    this.value = value;
  }
  stopAnimation(callback) {
    callback?.(this.value);
  }
}
const animation = (value, { toValue }) => ({
  start: (done) => {
    value.setValue(toValue);
    done?.({ finished: true });
  },
  stop() {},
});
let locations;
const mocks = {
  react: React,
  "react/jsx-runtime": jsxRuntime,
  "react-native": {
    View: container,
    Text: container,
    ScrollView: container,
    Pressable: button,
    Animated: { View: container, Value, add: () => 0, spring: animation },
    PanResponder: { create: (handlers) => ({ panHandlers: handlers }) },
  },
  "@expo/vector-icons": { Ionicons: () => null },
  "expo-router": { router: { push() {} } },
  "@maplibre/maplibre-react-native": {
    Marker: ({ children, id, onPress }) => {
      handlers.set(`marker:${id}`, onPress);
      return container({ children });
    },
  },
  "../../theme": { useTheme: () => ({ colors: {}, type: {}, radii: {}, spacing: {} }) },
  "../../state/identity": {
    useIdentity: () => ({
      deviceId: "alice",
      nicknames: { bob: "Bob" },
      profilePhotos: {},
    }),
  },
  "../../state/locations": { useLocations: () => locations },
  "../../components/Avatar": { Avatar: () => null },
  "../../components/IconButton": {
    IconButton: ({ label, ...props }) => button({ ...props, accessibilityLabel: label }),
  },
  "../../components/Button": { Button: button },
  "../../components/Notice": {
    Notice: ({ text }) => React.createElement("span", null, text),
  },
};
const { MapPeoplePanel } = await loadTypeScriptModule(
  "src/features/map/MapPeoplePanel.tsx",
  { mocks },
);
const { PersonMarker } = await loadTypeScriptModule("src/features/map/PersonMarker.tsx", {
  mocks,
});
const { PinDetails } = await loadTypeScriptModule("src/features/map/PinDetails.tsx", {
  mocks,
});
const { usePeoplePanel } = await loadTypeScriptModule(
  "src/features/map/usePeoplePanel.ts",
  { mocks },
);
const pin = {
  circleId: "circle",
  sessionId: "session",
  senderId: "bob",
  fix: { latitude: 50, longitude: 20, accuracy: 10, observedAt: 1000 },
};
const defaults = {
  circleId: "circle",
  role: "member",
  pins: [pin],
  selected: "session",
  now: 1000,
  distance: { origin: null, busy: false, error: null },
  panel: {
    peopleCollapsed: false,
    panelHeight: new Value(300),
    peoplePanelGesture: { panHandlers: {} },
  },
  overviewOnly: false,
  mapFailed: false,
  away: () => "1 km away",
  focus() {},
  onOpenSharing() {},
};
const renderPanel = (props = {}) => {
  handlers.clear();
  return renderToStaticMarkup(
    React.createElement(MapPeoplePanel, { ...defaults, ...props }),
  );
};

test("map panel exposes sharing permissions, member focus, and pending stop status", () => {
  const actions = [];
  locations = {
    state: { shares: [], pending: [] },
    ready: true,
    busy: false,
    stop: (id) => actions.push(`stop:${id}`),
  };
  let html = renderPanel({
    focus: (pin) => actions.push(pin.sessionId),
    onOpenSharing: () => actions.push("share"),
  });
  assert.match(html, /Your location is private/);
  assert.match(html, /aria-label="Find Bob" aria-pressed="true"/);
  handlers.get("Find Bob")();
  handlers.get("Share location")();
  assert.deepEqual(actions, ["session", "share"]);
  renderPanel({ role: "removed" });
  assert.equal(handlers.get("Share location"), undefined);
  locations.state.shares = [
    { circleId: "circle", sessionId: "own", active: true, interval: 60000 },
  ];
  locations.state.pending = [{ sessionId: "own", stopped: true }];
  html = renderPanel();
  assert.match(html, /Stopped here. Removing your pin when connected./);
  handlers.get("Stop")();
  assert.equal(actions.at(-1), "stop:circle");
  html = renderPanel({ panel: { ...defaults.panel, peopleCollapsed: true } });
  assert.doesNotMatch(html, /Find Bob/);
  assert.match(html, /Stop/);
});

test("marker taps select a member without triggering the map and pin details can close", () => {
  let selected;
  let propagationStopped = false;
  renderToStaticMarkup(
    React.createElement(PersonMarker, {
      pin,
      pins: [pin],
      now: 1000,
      selected: true,
      tick: 1,
      onSelect: (value) => {
        selected = value;
      },
    }),
  );
  handlers.get("marker:session")({
    stopPropagation: () => {
      propagationStopped = true;
    },
  });
  assert.equal(propagationStopped, true);
  assert.equal(selected, pin);
  let closed = false;
  const html = renderToStaticMarkup(
    React.createElement(PinDetails, {
      pin,
      panelHeight: new Value(300),
      now: 1000,
      distanceLabel: "1 km away",
      onClose: () => {
        closed = true;
      },
    }),
  );
  assert.match(html, /Bob/);
  assert.match(html, /1 km away/);
  handlers.get("Close pin details")();
  assert.equal(closed, true);
});

test("people panel gestures clamp height and settle in both directions", () => {
  let panel;
  function Harness() {
    panel = usePeoplePanel(800);
    return null;
  }
  renderToStaticMarkup(React.createElement(Harness));
  const gestures = panel.peoplePanelGesture.panHandlers;
  assert.equal(gestures.onMoveShouldSetPanResponder(null, { dx: 20, dy: 5 }), false);
  assert.equal(gestures.onMoveShouldSetPanResponder(null, { dx: 0, dy: 20 }), true);
  gestures.onPanResponderGrant();
  gestures.onPanResponderMove(null, { dy: -1000 });
  assert.equal(panel.panelHeightRef.current, 352);
  gestures.onPanResponderMove(null, { dy: 1000 });
  assert.equal(panel.panelHeightRef.current, 112);
  gestures.onPanResponderRelease(null, { vy: 1 });
  assert.equal(panel.panelHeight.value, 112);
  gestures.onPanResponderGrant();
  gestures.onPanResponderMove(null, { dy: -150 });
  gestures.onPanResponderRelease(null, { vy: -1 });
  assert.equal(panel.panelHeight.value, 352);
});
