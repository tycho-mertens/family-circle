import { createContext, useContext, useState, type PropsWithChildren } from "react";
import Native from "../../modules/family-circle-bridge";
import type { DistanceUnit } from "../distance";
const Preferences = createContext<{
  distanceUnit: DistanceUnit;
  setDistanceUnit: (unit: DistanceUnit) => void;
} | null>(null);
export function PreferencesProvider({ children }: PropsWithChildren) {
  const [distanceUnit, setUnit] = useState<DistanceUnit>(() =>
    Native.getDistanceUnit?.() === "mi" ? "mi" : "km",
  );
  const setDistanceUnit = (unit: DistanceUnit) => {
    Native.setDistanceUnit(unit);
    setUnit(unit);
  };
  return (
    <Preferences.Provider value={{ distanceUnit, setDistanceUnit }}>
      {children}
    </Preferences.Provider>
  );
}
export function usePreferences() {
  const value = useContext(Preferences);
  if (!value) throw new Error("Preferences provider is missing");
  return value;
}
