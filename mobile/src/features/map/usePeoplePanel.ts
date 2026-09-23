import { useCallback, useEffect, useRef, useState } from "react";
import { Animated, PanResponder } from "react-native";

export function usePeoplePanel(height: number) {
  const [peopleCollapsed, setPeopleCollapsed] = useState(false);
  const panelCollapsedHeight = 112;
  const panelExpandedHeight = Math.min(height * 0.44, 360);
  const panelHeight = useRef(new Animated.Value(panelExpandedHeight)).current;
  const panelHeightRef = useRef(panelExpandedHeight);
  const panelDragStartHeight = useRef(panelExpandedHeight);
  const peopleCollapsedRef = useRef(false);
  const panelBounds = useRef({
    collapsed: panelCollapsedHeight,
    expanded: panelExpandedHeight,
  });
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
  return {
    peopleCollapsed,
    panelHeight,
    panelHeightRef,
    peoplePanelGesture,
    settlePeoplePanel,
  };
}
