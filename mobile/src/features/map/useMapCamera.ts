import { useEffect, useRef, useState, type RefObject } from "react";
import type { CameraRef } from "@maplibre/maplibre-react-native";
import type { LocationPin } from "../../location";

export function useMapCamera(
  pins: LocationPin[],
  origin: { longitude: number; latitude: number } | null,
  panelHeightRef: RefObject<number>,
) {
  const camera = useRef<CameraRef>(null);
  const [selectionTick, setSelectionTick] = useState(0);
  const [selected, setSelected] = useState<string | null>(null);
  const centered = useRef(false);
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
      if (origin)
        camera.current?.flyTo({
          center: [origin.longitude, origin.latitude],
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
  useEffect(() => {
    if (pins.length && !centered.current) {
      const t = setTimeout(() => {
        fit();
        centered.current = true;
      }, 400);
      return () => clearTimeout(t);
    }
  }, [pins.length]);
  return {
    camera,
    selected,
    selectionTick,
    select,
    focus,
    fit,
    clearSelection: () => setSelected(null),
  };
}
