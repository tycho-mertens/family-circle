import { useState, type Ref } from "react";
import { Text, TextInput, View, type TextInputProps } from "react-native";
import { useTheme } from "../theme";

interface Props extends TextInputProps {
  label?: string;
  inputRef?: Ref<TextInput>;
}

/** Labeled text input with theme colors. */
export function TextField({ label, inputRef, style, onFocus, onBlur, ...rest }: Props) {
  const [focused, setFocused] = useState(false);
  const { colors, radii, spacing, type } = useTheme();
  return (
    <View style={{ gap: spacing.xs }}>
      {label && (
        <Text
          style={[type.caption, { color: colors.textPrimary, fontWeight: "500", marginBottom: 4 }]}
        >
          {label}
        </Text>
      )}
      <TextInput
        ref={inputRef}
        accessibilityLabel={label ?? rest.placeholder}
        placeholderTextColor={colors.textSecondary}
        selectionColor={colors.accent}
        onFocus={(event) => {
          setFocused(true);
          onFocus?.(event);
        }}
        onBlur={(event) => {
          setFocused(false);
          onBlur?.(event);
        }}
        style={[
          type.body,
          {
            color: colors.textPrimary,
            backgroundColor: focused ? colors.surface : colors.surfaceAlt,
            borderRadius: radii.md,
            borderWidth: 1,
            borderColor: focused ? colors.accent : colors.border,
            paddingHorizontal: spacing.md,
            minHeight: 48,
            textAlignVertical: rest.multiline ? "top" : "center",
            paddingVertical: 10,
          },
          style,
        ]}
        {...rest}
      />
    </View>
  );
}
