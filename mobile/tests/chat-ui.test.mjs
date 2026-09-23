import test from "node:test";
import assert from "node:assert/strict";
import * as React from "react";
import * as jsxRuntime from "react/jsx-runtime";
import { renderToStaticMarkup } from "react-dom/server";
import { loadTypeScriptModule } from "./helpers/typescript-module.mjs";

// Render the real components with React. Native layout and gestures still need
// a device; these checks cover which actions and states each component exposes.
const container = ({ children }) => React.createElement("div", null, children);
const button = ({ children, accessibilityLabel, disabled, title }) =>
  React.createElement(
    "button",
    { "aria-label": accessibilityLabel, disabled },
    children ?? title,
  );
const theme = {
  colors: {},
  spacing: { sm: 8, md: 12, lg: 20 },
  radii: {},
  type: {},
};
const mocks = {
  react: React,
  "react/jsx-runtime": jsxRuntime,
  "react-native": {
    Modal: ({ visible, children }) => (visible ? container({ children }) : null),
    View: container,
    Text: container,
    ScrollView: container,
    Pressable: button,
    TextInput: "input",
    useWindowDimensions: () => ({ width: 400, height: 800 }),
  },
  "@expo/vector-icons": { Ionicons: () => null },
  "react-native-safe-area-context": {
    useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
  },
  "../../theme": { useTheme: () => theme },
  "../../components/Avatar": { Avatar: () => null },
  "../../components/IconButton": {
    IconButton: ({ label, ...props }) => button({ ...props, accessibilityLabel: label }),
  },
};
const { MessageMenu } = await loadTypeScriptModule("src/features/chat/MessageMenu.tsx", {
  mocks,
});
const { ReactionDetails } = await loadTypeScriptModule(
  "src/features/chat/ReactionDetails.tsx",
  { mocks },
);
const { ChatComposer } = await loadTypeScriptModule("src/features/chat/ChatComposer.tsx", {
  mocks: {
    ...mocks,
    "../../state/circles": { useCircles: () => ({}) },
    "../../components/AttachmentComposer": { AttachmentComposer: () => null },
    "../../components/VoiceRecorder": { VoiceRecorder: () => null },
    "../../components/TextField": {
      TextField: ({ value }) => React.createElement("input", { value, readOnly: true }),
    },
  },
});
const menuProps = {
  anchor: { x: 10, y: 200, width: 250 },
  text: "Hello",
  isOwn: true,
  at: Date.now(),
  hotbar: [],
  canReact: true,
  busy: false,
  onClose() {},
  onReact: async () => {},
  onMoreEmoji() {},
  onReply() {},
  onEdit() {},
  onDelete() {},
  onViewOriginal() {},
};
const renderMenu = (props = {}) =>
  renderToStaticMarkup(React.createElement(MessageMenu, { ...menuProps, ...props }));

test("a recent own message offers editing, deletion, replies, and reactions", () => {
  const html = renderMenu();
  for (const action of ["Edit", "Delete for everyone", "Reply", "More emoji", "View original"])
    assert.ok(html.includes(`aria-label="${action}"`), action);
});

test("expired and other members' messages never offer edit or delete", () => {
  for (const props of [
    { at: Date.now() - 16 * 60_000 },
    { isOwn: false },
    { at: Date.now() + 60_000 },
  ]) {
    const html = renderMenu(props);
    assert.ok(!html.includes('aria-label="Edit"'));
    assert.ok(!html.includes('aria-label="Delete for everyone"'));
    assert.ok(html.includes('aria-label="Reply"'));
  }
});

test("closed menus and reaction dialogs do not expose hidden actions", () => {
  assert.equal(renderMenu({ anchor: null }), "");
  const html = renderToStaticMarkup(
    React.createElement(ReactionDetails, {
      visible: false,
      groups: [],
      total: 0,
      text: "Hello",
      nicknames: {},
      profilePhotos: {},
      onClose() {},
    }),
  );
  assert.equal(html, "");
});

test("reaction details identify the current member and show an empty state", () => {
  const props = {
    visible: true,
    groups: [],
    total: 0,
    text: "Hello",
    nicknames: {},
    profilePhotos: {},
    onClose() {},
  };
  assert.match(
    renderToStaticMarkup(React.createElement(ReactionDetails, props)),
    /No reactions yet/,
  );
  const html = renderToStaticMarkup(
    React.createElement(ReactionDetails, {
      ...props,
      deviceId: "alice",
      nicknames: { alice: "Alice" },
      total: 1,
      groups: [{ emoji: "❤️", label: "Heart", members: ["alice"] }],
    }),
  );
  assert.match(html, /Alice \(You\)/);
});

test("the composer keeps all send controls disabled while the Circle cannot send", () => {
  const html = renderToStaticMarkup(
    React.createElement(ChatComposer, {
      circleId: "family",
      canSend: false,
      canRecord: false,
      replyTarget: null,
      setReplyTarget() {},
      memberName: () => "Alice",
      onSent() {},
    }),
  );
  for (const action of ["Add attachment", "Record voice message", "Send message"])
    assert.ok(html.includes(`aria-label="${action}" disabled=""`), action);
});
