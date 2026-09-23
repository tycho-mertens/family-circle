import {
  createContext,
  useContext,
  useEffect,
  useSyncExternalStore,
  type PropsWithChildren,
} from "react";
import { circlesRuntime, type CirclesContextValue } from "../runtime/circles";
import { useIdentity } from "./identity";
export {
  circleLabel,
  shortId,
  displayMember,
  type CircleInfo,
  type TimelineItem,
  type Role,
} from "../runtime/circle-types";

const CirclesContext = createContext<CirclesContextValue | null>(null);
export function useCircles() {
  const value = useContext(CirclesContext);
  if (!value) throw new Error("Circles provider is missing");
  return value;
}
export function CirclesProvider({ children }: PropsWithChildren) {
  const identity = useIdentity();
  useSyncExternalStore(circlesRuntime.changes.subscribe, circlesRuntime.changes.getRevision);
  useEffect(() => {
    void circlesRuntime.initialize().catch(() => {});
  }, [identity.resuming, identity.pendingCircleSeed]);
  return (
    <CirclesContext.Provider value={circlesRuntime.getValue()}>
      {children}
    </CirclesContext.Provider>
  );
}
