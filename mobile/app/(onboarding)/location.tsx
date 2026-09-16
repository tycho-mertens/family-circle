import { LocationSetup } from "../../src/components/LocationSetup";
import { useIdentity } from "../../src/state/identity";
export default function LocationOnboarding() {
  const { finishSetup } = useIdentity();
  return <LocationSetup onboarding onDone={finishSetup} />;
}
