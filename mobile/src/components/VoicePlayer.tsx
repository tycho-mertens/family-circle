import { useEffect, useRef, useState } from "react";
import { AppState, Pressable, Text, View } from "react-native";
import { useFocusEffect } from "expo-router";
import { useCallback } from "react";
import { useAudioPlayer, useAudioPlayerStatus, setAudioModeAsync } from "expo-audio";
import { File, Paths } from "expo-file-system";
import { Ionicons } from "@expo/vector-icons";
import { base64ToBytes } from "../base64";
import { claimVoicePlayback, releaseVoicePlayback, ownsVoicePlayback } from "../voice-playback";
import { type VoiceMessage, voiceDuration } from "../voice-message";
import { useTheme } from "../theme";

export function VoicePlayer({ voice, isOwn = false }: { voice: VoiceMessage; isOwn?: boolean }) {
  const { colors, type } = useTheme();
  const player = useAudioPlayer(null, { updateInterval: 200 });
  const status = useAudioPlayerStatus(player);
  const file = useRef<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const active = useRef(true);
  const loaded = useRef(false);
  const stop = useCallback(() => {
    try {
      player.pause();
    } catch {}
  }, [player]);
  const detach = useCallback(() => {
    stop();
    releaseVoicePlayback(stop);
    loaded.current = false;
    try {
      player.replace(null);
    } catch {}
  }, [player, stop]);
  useFocusEffect(
    useCallback(() => {
      active.current = true;
      return () => {
        active.current = false;
        detach();
      };
    }, [detach]),
  );
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state !== "active") detach();
    });
    return () => {
      active.current = false;
      subscription.remove();
      stop();
      releaseVoicePlayback(stop);
      try {
        if (file.current?.exists) file.current.delete();
      } catch {}
    };
  }, [stop, detach]);
  const toggle = async () => {
    if (busy) return;
    if (status.playing) {
      stop();
      return;
    }
    setBusy(true);
    setError(null);
    try {
      claimVoicePlayback(stop);
      await setAudioModeAsync({
        allowsRecording: false,
        playsInSilentMode: true,
        shouldPlayInBackground: false,
        interruptionMode: "doNotMix",
        shouldRouteThroughEarpiece: false,
      });
      if (!active.current || AppState.currentState !== "active" || !ownsVoicePlayback(stop)) return;
      if (!file.current) {
        const next = new File(
          Paths.cache,
          `voice-play-${Date.now()}-${Math.random().toString(36).slice(2)}.m4a`,
        );
        file.current = next;
        next.write(base64ToBytes(voice.base64));
      }
      if (!loaded.current) {
        player.replace({ uri: file.current.uri });
        loaded.current = true;
      } else if (
        status.didJustFinish ||
        (status.duration > 0 && status.currentTime >= status.duration - 0.1)
      )
        await player.seekTo(0);
      if (active.current && ownsVoicePlayback(stop)) player.play();
    } catch {
      setError("Couldn't play this voice message. Try again.");
    } finally {
      setBusy(false);
    }
  };
  const foreground = isOwn ? colors.textOnAccent : colors.textPrimary;
  const progress = Math.min(1, status.currentTime / (status.duration || voice.durationMs / 1000));
  return (
    <View style={{ minWidth: 180, maxWidth: "100%", gap: 6 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={status.playing ? "Pause voice message" : "Play voice message"}
          accessibilityState={{ disabled: busy }}
          disabled={busy}
          onPress={() => {
            void toggle();
          }}
          style={{
            width: 44,
            height: 44,
            alignItems: "center",
            justifyContent: "center",
            borderRadius: 22,
            backgroundColor: isOwn ? "#FFFFFF25" : colors.accentMuted,
          }}
        >
          <Ionicons name={status.playing ? "pause" : "play"} color={foreground} size={22} />
        </Pressable>
        <View style={{ flex: 1, gap: 7 }}>
          <Text style={[type.caption, { color: foreground }]}>Voice message</Text>
          <View
            accessibilityRole="progressbar"
            accessibilityValue={{ min: 0, max: 100, now: Math.round(progress * 100) }}
            style={{
              height: 4,
              borderRadius: 2,
              backgroundColor: isOwn ? "#FFFFFF35" : colors.border,
            }}
          >
            <View
              style={{
                height: 4,
                width: `${progress * 100}%`,
                backgroundColor: foreground,
                borderRadius: 2,
              }}
            />
          </View>
          <Text style={[type.tiny, { color: foreground }]}>
            {voiceDuration(status.currentTime * 1000)} / {voiceDuration(voice.durationMs)}
          </Text>
        </View>
      </View>
      {(error || status.error) && (
        <Text accessibilityRole="alert" style={[type.caption, { color: foreground }]}>
          {error ?? "Couldn't play this voice message."}
        </Text>
      )}
    </View>
  );
}
