import {
  createContext,
  useContext,
  useSyncExternalStore,
  useEffect,
  type PropsWithChildren,
} from "react";
import { identityRuntime, type IdentityContextValue } from "../runtime/identity";
export { describeError, MAX_NICKNAME_LEN } from "../runtime/identity";
const IdentityContext = createContext<IdentityContextValue | null>(null);
export function useIdentity() {
  const value = useContext(IdentityContext);
  if (!value) throw new Error("Identity provider is missing");
  return value;
}
export function IdentityProvider({ children }: PropsWithChildren) {
  useSyncExternalStore(identityRuntime.changes.subscribe, identityRuntime.changes.getRevision);
  useEffect(() => {
    void identityRuntime.initialize();
  }, []);
  return (
    <IdentityContext.Provider value={{ ...identityRuntime.value }}>
      {children}
    </IdentityContext.Provider>
  );
}
