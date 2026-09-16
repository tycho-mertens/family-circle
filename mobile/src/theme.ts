/**
 * Shared colors, spacing, radii, and typography.
 * useTheme() resolves the saved appearance preference against the system theme.
 */
import { useColorScheme } from "react-native";
import { createContext, createElement, useContext, useState, type PropsWithChildren } from "react";

import Native from "../modules/family-circle-bridge";

export type ThemePreference = "system" | "light" | "dark";

export interface ThemeColors {
  background: string;
  surface: string;
  surfaceAlt: string;
  incomingBubble: string;
  border: string;
  textPrimary: string;
  textSecondary: string;
  textOnAccent: string;
  accent: string;
  accentMuted: string;
  success: string;
  warning: string;
  warningSurface: string;
  warningText: string;
  danger: string;
  overlay: string;
}

const light: ThemeColors = {
  background: "#F5F6F5",
  surface: "#FFFFFF",
  surfaceAlt: "#ECEFED",
  incomingBubble: "#E7EEEA",
  border: "#E1E6E3",
  textPrimary: "#172F27",
  textSecondary: "#5F7269",
  textOnAccent: "#FFFFFF",
  accent: "#176B50",
  accentMuted: "#E0F1E8",
  success: "#277D56",
  warning: "#B9862B",
  warningSurface: "#FFF0C2",
  warningText: "#704600",
  danger: "#C1483A",
  overlay: "rgba(12, 27, 21, 0.42)",
};

const dark: ThemeColors = {
  background: "#101613",
  surface: "#1B241F",
  surfaceAlt: "#27332C",
  incomingBubble: "#31473B",
  border: "#35443B",
  textPrimary: "#EFF6F1",
  textSecondary: "#ADBEB3",
  textOnAccent: "#111B16",
  accent: "#8CD8AD",
  accentMuted: "#2A4B38",
  success: "#6BBE8C",
  warning: "#E6B85C",
  warningSurface: "#503A12",
  warningText: "#FFE09A",
  danger: "#E17F63",
  overlay: "rgba(0, 0, 0, 0.6)",
};

export const spacing = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
  xxxl: 40,
};

export const radii = {
  sm: 8,
  md: 16,
  lg: 24,
  full: 999,
};

export const type = {
  display: { fontSize: 30, fontWeight: "700" as const, lineHeight: 36 },
  title: { fontSize: 19, fontWeight: "600" as const, lineHeight: 26 },
  subtitle: { fontSize: 15, fontWeight: "600" as const, lineHeight: 20 },
  body: { fontSize: 15, fontWeight: "400" as const, lineHeight: 22 },
  caption: { fontSize: 13, fontWeight: "400" as const, lineHeight: 18 },
  tiny: { fontSize: 12, fontWeight: "500" as const, lineHeight: 16 },
};

export interface Theme {
  colors: ThemeColors;
  spacing: typeof spacing;
  radii: typeof radii;
  type: typeof type;
  scheme: "light" | "dark";
  themePreference: ThemePreference;
  setThemePreference: (preference: ThemePreference) => void;
}

const ThemeContext = createContext<Theme | null>(null);

export function ThemeProvider({ children }: PropsWithChildren) {
  const systemScheme = useColorScheme();
  const [themePreference, setPreference] = useState<ThemePreference>(() => {
    const saved = Native.getThemePreference();
    return saved === "light" || saved === "dark" ? saved : "system";
  });
  const setThemePreference = (preference: ThemePreference) => {
    Native.setThemePreference(preference);
    setPreference(preference);
  };
  const isDark = (themePreference === "system" ? systemScheme : themePreference) === "dark";
  return createElement(
    ThemeContext.Provider,
    {
      value: {
        themePreference,
        setThemePreference,
        colors: isDark ? dark : light,
        spacing,
        radii,
        type,
        scheme: isDark ? "dark" : "light",
      },
    },
    children,
  );
}

export function useTheme(): Theme {
  const theme = useContext(ThemeContext);
  if (!theme) throw new Error("useTheme must be used within ThemeProvider");
  return theme;
}
