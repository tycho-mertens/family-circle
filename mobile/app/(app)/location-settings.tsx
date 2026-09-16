import { router } from "expo-router";
import { LocationSetup } from "../../src/components/LocationSetup";
export default function LocationSettings() {
  return <LocationSetup onDone={() => router.back()} />;
}
