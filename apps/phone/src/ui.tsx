// The app's few building blocks: its colours, light and dark, and its buttons.
import { Pressable, StyleSheet, Text, useColorScheme } from "react-native";

export interface Colors {
  readonly background: string;
  readonly text: string;
  readonly muted: string;
  readonly line: string;
  readonly accent: string;
  readonly onAccent: string;
}

export function useColors(): Colors {
  return useColorScheme() === "dark"
    ? {
        background: "#16181c",
        text: "#eceef1",
        muted: "#9aa1ab",
        line: "#2a2e35",
        accent: "#8ab4ff",
        onAccent: "#0d1a33",
      }
    : {
        background: "#ffffff",
        text: "#16181c",
        muted: "#5b626d",
        line: "#e4e6ea",
        accent: "#2457c5",
        onAccent: "#ffffff",
      };
}

export function Button(props: {
  label: string;
  onPress: () => void;
  colors: Colors;
  primary?: boolean;
  disabled?: boolean;
  /** A plain word in the text's flow, not a block. */
  quiet?: boolean;
}) {
  const { label, onPress, colors, primary = false, disabled = false, quiet = false } = props;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      hitSlop={quiet ? 12 : 0}
      style={({ pressed }) => [
        quiet ? styles.quiet : styles.button,
        quiet ? null : { borderColor: colors.accent },
        primary ? { backgroundColor: colors.accent } : null,
        pressed || disabled ? styles.pressed : null,
      ]}
    >
      <Text style={[styles.text, { color: primary ? colors.onAccent : colors.accent }]}>
        {label}
      </Text>
    </Pressable>
  );
}

export const shared = StyleSheet.create({
  fill: { flex: 1 },
  middle: { flex: 1, justifyContent: "center", padding: 24, gap: 12 },
  bottom: { padding: 24, gap: 12 },
  title: { fontSize: 28, fontWeight: "600" },
  body: { fontSize: 16, lineHeight: 22 },
  small: { fontSize: 14, lineHeight: 20 },
  input: {
    fontSize: 18,
    borderWidth: 1,
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
});

const styles = StyleSheet.create({
  button: { borderWidth: 1, borderRadius: 8, paddingVertical: 12, alignItems: "center" },
  quiet: { paddingVertical: 4 },
  text: { fontSize: 16, fontWeight: "600" },
  pressed: { opacity: 0.6 },
});
