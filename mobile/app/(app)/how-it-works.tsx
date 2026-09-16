import { Text } from "react-native";
import { useTheme } from "../../src/theme";
import { ScreenContainer } from "../../src/components/ScreenContainer";
import { PageHeading } from "../../src/components/PageHeading";
import { Card } from "../../src/components/Card";

const sections = [
  [
    "Private conversations",
    "Your messages are encrypted on your device and opened on your Circle members' devices. The server delivers them but can't read their contents. People in a Circle can still save or share what they receive.",
  ],
  [
    "An invitation brings you in",
    "A Circle's admin shares a single-use code that expires after 10 minutes. Keep the admin's app open while someone joins. New members can read messages sent after they join, not earlier conversations.",
  ],
  [
    "When someone leaves",
    "The admin confirms membership changes. Once a removal is confirmed, that person can't read new messages. This doesn't erase messages they already read or saved. For now, the admin needs to stay in the Circle.",
  ],
  [
    "Your recovery phrase",
    "The 12 words shown during setup are the only way to restore your identity and backed-up Circles on a new phone. Keep them private and in order. There is no email reset, and the app can't show the phrase again.",
  ],
  [
    "What comes back",
    "On this phone, your identity and Circle memberships reopen from an encrypted local backup, even offline. On a new phone, choose Restore and enter your recovery phrase to fetch the server backup. Chat history is saved encrypted on this phone, but isn't included in recovery backups. Avoid using the same restored identity on two phones at once.",
  ],
  [
    "If a Circle needs a fresh start",
    "If messages won't open after recovery, ask your admin for a fresh invite code and choose Request to rejoin in Circle settings. Your admin reviews it and adds you back. You won't be able to read messages from before that approval.",
  ],
  [
    "Staying in touch",
    "Messages arrive every few seconds while the app checks for updates. On Android, allow notifications to hear about new messages while the app is in the background. After a force stop or phone restart, open the app again to resume updates.",
  ],
];

export default function HowItWorks() {
  const { colors, type } = useTheme();
  return (
    <ScreenContainer>
      <PageHeading
        eyebrow="A little peace of mind"
        title="Your Circle, explained."
        body="A few things to know about invitations, privacy, and finding your way back."
      />
      {sections.map(([title, body]) => (
        <Card key={title}>
          <Text accessibilityRole="header" style={[type.title, { color: colors.textPrimary }]}>
            {title}
          </Text>
          <Text style={[type.body, { color: colors.textSecondary }]}>{body}</Text>
        </Card>
      ))}
    </ScreenContainer>
  );
}
