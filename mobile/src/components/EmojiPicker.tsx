import { useMemo, useRef, useState } from "react";
import {
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { EMOJI_CATALOG, EMOJI_CATEGORIES } from "../emoji-catalog";
import { reactionLabel, type EmojiUsage } from "../reactions";
import { useTheme } from "../theme";
import { IconButton } from "./IconButton";
import { TextField } from "./TextField";

export function EmojiPicker({
  selected,
  history,
  busy,
  onSelect,
  onClose,
}: {
  selected?: string;
  history: EmojiUsage[];
  busy: boolean;
  onSelect: (emoji: string) => void;
  onClose: () => void;
}) {
  const { colors, type } = useTheme();
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState(history.length ? "Recent" : "All");
  const list = useRef<FlatList>(null);
  const columns = Math.max(
    4,
    Math.floor((width - Math.max(insets.left, 16) - Math.max(insets.right, 16)) / 48),
  );
  const data = useMemo(() => {
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const source =
      words.length || category === "All"
        ? EMOJI_CATALOG
        : category === "Recent"
          ? history.map((item) => ({
              emoji: item.emoji,
              label: reactionLabel(item.emoji),
              category: "Recent",
            }))
          : EMOJI_CATALOG.filter((item) => item.category === category);
    return source.filter((item) =>
      words.every((word) =>
        (item.label + " " + item.emoji + " " + reactionLabel(item.emoji))
          .toLowerCase()
          .includes(word),
      ),
    );
  }, [query, category, history]);
  return (
    <Modal
      transparent
      animationType="slide"
      statusBarTranslucent
      navigationBarTranslucent
      onRequestClose={onClose}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : "height"}
        style={{ flex: 1, justifyContent: "flex-end", backgroundColor: colors.overlay }}
      >
        <Pressable
          accessibilityLabel="Close emoji library"
          accessibilityRole="button"
          onPress={onClose}
          style={{ position: "absolute", inset: 0 }}
        />
        <View
          accessibilityViewIsModal
          style={{
            height: Math.min(620, height - insets.top - 24),
            maxHeight: "92%",
            backgroundColor: colors.surface,
            borderTopLeftRadius: 28,
            borderTopRightRadius: 28,
            paddingTop: 8,
            paddingBottom: Math.max(insets.bottom, 12),
            paddingLeft: Math.max(insets.left, 16),
            paddingRight: Math.max(insets.right, 16),
            gap: 8,
          }}
        >
          <View
            style={{
              width: 36,
              height: 4,
              borderRadius: 2,
              backgroundColor: colors.border,
              alignSelf: "center",
            }}
          />
          <View style={{ flexDirection: "row", alignItems: "center" }}>
            <Text
              accessibilityRole="header"
              style={[type.title, { flex: 1, color: colors.textPrimary }]}
            >
              Choose a reaction
            </Text>
            <IconButton plain label="Close emoji library" icon="close" onPress={onClose} />
          </View>
          <TextField
            placeholder="Search emoji"
            accessibilityLabel="Search emoji"
            value={query}
            onChangeText={(value) => {
              setQuery(value);
              list.current?.scrollToOffset({ offset: 0, animated: false });
            }}
            autoCorrect={false}
          />
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            style={{ flexGrow: 0, flexShrink: 0, height: 44 }}
            contentContainerStyle={{ gap: 6 }}
            keyboardShouldPersistTaps="handled"
          >
            {["Recent", "All", ...EMOJI_CATEGORIES].map((name) => (
              <Pressable
                key={name}
                accessibilityRole="button"
                accessibilityState={{ selected: category === name && !query }}
                onPress={() => {
                  setCategory(name);
                  setQuery("");
                  list.current?.scrollToOffset({ offset: 0, animated: false });
                }}
                style={{
                  minHeight: 44,
                  justifyContent: "center",
                  paddingHorizontal: 14,
                  borderRadius: 22,
                  backgroundColor:
                    category === name && !query ? colors.accentMuted : colors.surfaceAlt,
                }}
              >
                <Text
                  style={[
                    type.caption,
                    { color: category === name ? colors.accent : colors.textSecondary },
                  ]}
                >
                  {name}
                </Text>
              </Pressable>
            ))}
          </ScrollView>
          <FlatList
            ref={list}
            key={columns}
            data={data}
            numColumns={columns}
            keyExtractor={(item) => item.emoji}
            keyboardShouldPersistTaps="handled"
            keyboardDismissMode="on-drag"
            initialNumToRender={42}
            windowSize={5}
            // FlatList passes row indices for multi-column grids, not emoji indices.
            getItemLayout={(_, index) => ({ length: 52, offset: 52 * index, index })}
            ListEmptyComponent={
              <Text style={[type.body, { color: colors.textSecondary, paddingVertical: 24 }]}>
                {query ? "No matching emoji." : "Your recent reactions will appear here."}
              </Text>
            }
            renderItem={({ item }) => (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={item.label}
                accessibilityState={{ selected: selected === item.emoji, disabled: busy }}
                disabled={busy}
                onPress={() => onSelect(item.emoji)}
                style={({ pressed }) => ({
                  width: `${100 / columns}%`,
                  height: 52,
                  alignItems: "center",
                  justifyContent: "center",
                  borderRadius: 16,
                  backgroundColor:
                    pressed || selected === item.emoji ? colors.accentMuted : "transparent",
                })}
              >
                <Text allowFontScaling={false} style={{ fontSize: 28 }}>
                  {item.emoji}
                </Text>
              </Pressable>
            )}
          />
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
