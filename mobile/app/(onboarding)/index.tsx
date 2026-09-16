import { useRef, useState } from "react";
import { ScrollView, Text, View, useWindowDimensions } from "react-native";
import { Ionicons } from "@expo/vector-icons";
import { router } from "expo-router";
import { useTheme } from "../../src/theme";
import { ScreenContainer } from "../../src/components/ScreenContainer";
import { Button } from "../../src/components/Button";
import { SlideIndicator } from "../../src/components/SlideIndicator";

const slides = [
  {
    icon: "heart-outline" as const,
    eyebrow: "Your people, a little closer",
    title: "A small space.\nFor your closest people.",
    body: "Bring your family and friends into a private Circle. Messages are encrypted between your devices, so the server can't read them.",
  },
  {
    icon: "people-outline" as const,
    eyebrow: "Together, by invitation",
    title: "Your Circle starts\nwith an invitation.",
    body: "Share an invite code with someone you trust. New members can't read earlier messages. Once someone's removal is confirmed, they can't read new ones.",
  },
  {
    icon: "key-outline" as const,
    eyebrow: "A way back to your people",
    title: "Twelve words.\nKeep them somewhere safe.",
    body: "Your recovery phrase restores your identity and backed-up Circles on a new phone. We can't recover a lost phrase or show it again later. Chat history isn't backed up.",
  },
];

export default function Intro() {
  const { colors, radii, spacing, type } = useTheme();
  const { width } = useWindowDimensions();
  const [active, setActive] = useState(0);
  const scroll = useRef<ScrollView>(null);
  return (
    <ScreenContainer scroll={false} padded={false} headerShown={false}>
      <View
        style={{
          paddingHorizontal: spacing.xl,
          paddingTop: spacing.lg,
          flexDirection: "row",
          justifyContent: "space-between",
          alignItems: "center",
        }}
      >
        <Text style={[type.subtitle, { color: colors.textPrimary }]}>Family Circle</Text>
        <Button
          title="Skip intro"
          variant="ghost"
          onPress={() => router.push("/(onboarding)/setup")}
        />
      </View>
      <ScrollView
        ref={scroll}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onMomentumScrollEnd={(event) =>
          setActive(Math.round(event.nativeEvent.contentOffset.x / width))
        }
      >
        {slides.map((slide, index) => (
          <ScrollView
            key={slide.eyebrow}
            style={{ width }}
            contentContainerStyle={{
              flexGrow: 1,
              padding: spacing.xl,
              justifyContent: "center",
              gap: spacing.xl,
            }}
          >
            <View
              style={{
                alignSelf: "center",
                width: 180,
                height: 180,
                borderRadius: radii.full,
                backgroundColor: colors.accentMuted,
                alignItems: "center",
                justifyContent: "center",
                marginVertical: spacing.lg,
              }}
            >
              <Ionicons name={slide.icon} size={76} color={colors.accent} />
            </View>
            <Text
              style={[
                type.tiny,
                { color: colors.accent, letterSpacing: 1.8, textTransform: "uppercase" },
              ]}
            >
              {slide.eyebrow}
            </Text>
            <Text
              accessibilityRole="header"
              style={[type.display, { fontSize: 32, lineHeight: 39, color: colors.textPrimary }]}
            >
              {slide.title}
            </Text>
            <Text
              style={[type.body, { fontSize: 17, lineHeight: 26, color: colors.textSecondary }]}
            >
              {slide.body}
            </Text>
            <Text style={[type.tiny, { color: colors.textSecondary }]}>0{index + 1} / 03</Text>
          </ScrollView>
        ))}
      </ScrollView>
      <View style={{ padding: spacing.xl, gap: spacing.xl }}>
        <SlideIndicator count={slides.length} active={active} />
        <Button
          title={active === 2 ? "Let's get started" : "Continue"}
          fullWidth
          onPress={() => {
            if (active === 2) router.push("/(onboarding)/setup");
            else {
              scroll.current?.scrollTo({ x: (active + 1) * width, animated: true });
              setActive(active + 1);
            }
          }}
        />
      </View>
    </ScreenContainer>
  );
}
