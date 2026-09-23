import { useEffect, useRef, useState } from "react";
import { FlatList, type FlatListProps } from "react-native";
import type { TimelineItem } from "../../runtime/circle-types";

export function useChatNavigation(circleId: string, entries: TimelineItem[]) {
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const jump = useRef<{ index: number; attempts: number } | null>(null);
  const jumpTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (!highlighted) return;
    const timer = setTimeout(() => setHighlighted(null), 2000);
    return () => clearTimeout(timer);
  }, [highlighted]);
  useEffect(
    () => () => {
      if (jumpTimer.current) clearTimeout(jumpTimer.current);
    },
    [],
  );
  const list = useRef<FlatList<TimelineItem>>(null);
  const atBottom = useRef(true);
  useEffect(() => {
    setHighlighted(null);
    jump.current = null;
    if (jumpTimer.current) clearTimeout(jumpTimer.current);
  }, [circleId]);
  const goToOriginal = (target: TimelineItem) => {
    const index = entries.findIndex((item) => item.id === target.id);
    if (index < 0) return;
    atBottom.current = false;
    jump.current = { index, attempts: 0 };
    setHighlighted(target.id);
    list.current?.scrollToIndex({ index, viewPosition: 0.5, animated: true });
  };
  const listEvents: Pick<
    FlatListProps<TimelineItem>,
    | "onScrollBeginDrag"
    | "onScrollToIndexFailed"
    | "onScroll"
    | "scrollEventThrottle"
    | "onContentSizeChange"
  > = {
    onScrollBeginDrag: () => {
      jump.current = null;
    },
    onScrollToIndexFailed: ({ index, averageItemLength }) => {
      if (!jump.current || jump.current.index !== index || jump.current.attempts++ >= 4) return;
      list.current?.scrollToOffset({
        offset: Math.max(0, averageItemLength * index),
        animated: false,
      });
      if (jumpTimer.current) clearTimeout(jumpTimer.current);
      jumpTimer.current = setTimeout(() => {
        if (jump.current?.index === index)
          list.current?.scrollToIndex({ index, viewPosition: 0.5, animated: true });
      }, 180);
    },
    onScroll: (event) => {
      const { contentOffset, contentSize, layoutMeasurement } = event.nativeEvent;
      atBottom.current = contentSize.height - contentOffset.y - layoutMeasurement.height < 100;
    },
    scrollEventThrottle: 100,
    onContentSizeChange: () => {
      if (atBottom.current) list.current?.scrollToEnd({ animated: true });
    },
  };
  return { list, atBottom, highlighted, goToOriginal, listEvents };
}
