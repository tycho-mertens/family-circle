import { BottomSheet } from "./BottomSheet";
import { Ionicons } from "@expo/vector-icons";
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, AppState, Linking, Text, View } from "react-native";
import { useFocusEffect } from "expo-router";
import {
  AudioModule,
  RecordingPresets,
  setAudioModeAsync,
  useAudioRecorder,
  useAudioRecorderState,
} from "expo-audio";
import { File } from "expo-file-system";
import {
  MAX_VOICE_DURATION_MS,
  validVoiceMessage,
  voiceDuration,
  type VoiceMessage,
} from "../voice-message";
import { stopVoicePlayback } from "../voice-playback";
import { useTheme } from "../theme";
import { Button } from "./Button";
import { Notice } from "./Notice";
import { VoicePlayer } from "./VoicePlayer";

const options = {
  ...RecordingPresets.HIGH_QUALITY,
  sampleRate: 24000,
  numberOfChannels: 1,
  bitRate: 16000,
};
export function VoiceRecorder({
  onClose,
  onSend,
  replyLabel,
}: {
  replyLabel?: string;
  onClose: () => void;
  onSend: (voice: VoiceMessage) => Promise<boolean>;
}) {
  const { colors, type } = useTheme();
  const [voice, setVoice] = useState<VoiceMessage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [denied, setDenied] = useState(false);
  const [busy, setBusy] = useState(false);
  const [recording, setRecording] = useState(false);
  const alive = useRef(true);
  const started = useRef(false);
  const stopping = useRef(false);
  const working = useRef(false);
  const duration = useRef(0);
  const source = useRef<string | null>(null);
  const finishRef = useRef<() => Promise<void>>(async () => {});
  const recorder = useAudioRecorder(options, (status) => {
    if (status.url) source.current = status.url;
    if (status.hasError && alive.current) setError("Recording was interrupted. Please try again.");
    if (status.isFinished && started.current && !stopping.current) void finishRef.current();
  });
  const state = useAudioRecorderState(recorder, 200);
  if (state.durationMillis > 0) duration.current = state.durationMillis;
  const deleteSource = () => {
    try {
      const uri = source.current ?? recorder.uri;
      if (uri) {
        const file = new File(uri);
        if (file.exists) file.delete();
      }
    } catch {}
  };
  useEffect(
    () => () => {
      alive.current = false;
      started.current = false;
      void (async () => {
        try {
          if (recorder.getStatus().canRecord) await recorder.stop();
        } catch {
        } finally {
          deleteSource();
        }
      })();
      void setAudioModeAsync({ allowsRecording: false }).catch(() => {});
    },
    [recorder],
  );
  useFocusEffect(
    useCallback(
      () => () => {
        started.current = false;
        void (async () => {
          try {
            if (recorder.getStatus().canRecord) await recorder.stop();
          } catch {}
        })();
      },
      [recorder],
    ),
  );
  useEffect(() => {
    const sub = AppState.addEventListener("change", (state) => {
      if (state !== "active" && started.current) void finishRef.current();
    });
    return () => sub.remove();
  }, []);
  const start = async () => {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setError(null);
    setDenied(false);
    try {
      const permission = await AudioModule.requestRecordingPermissionsAsync();
      if (!alive.current) return;
      if (!permission.granted) {
        setDenied(true);
        setError("Allow microphone access to record a voice message.");
        return;
      }
      if (AppState.currentState !== "active") return;
      stopVoicePlayback();
      await setAudioModeAsync({
        allowsRecording: true,
        playsInSilentMode: true,
        shouldPlayInBackground: false,
        interruptionMode: "doNotMix",
      });
      await recorder.prepareToRecordAsync();
      if (!alive.current || AppState.currentState !== "active") {
        await recorder.stop();
        return;
      }
      source.current = recorder.uri;
      duration.current = 0;
      started.current = true;
      setRecording(true);
      recorder.record({ forDuration: MAX_VOICE_DURATION_MS / 1000 });
    } catch {
      started.current = false;
      setRecording(false);
      deleteSource();
      setError("Couldn't start recording. Please try again.");
    } finally {
      if (!started.current) void setAudioModeAsync({ allowsRecording: false }).catch(() => {});
      working.current = false;
      if (alive.current) setBusy(false);
    }
  };
  const finish = async () => {
    if (!started.current || stopping.current) return;
    stopping.current = true;
    started.current = false;
    setBusy(true);
    setRecording(false);
    try {
      duration.current = Math.max(duration.current, recorder.getStatus().durationMillis);
      if (recorder.getStatus().canRecord) await recorder.stop();
      const uri = recorder.uri ?? source.current;
      source.current = uri;
      if (!uri) throw new Error("No recording was saved. Please try again.");
      const file = new File(uri);
      if (file.size > 144 * 1024)
        throw new Error("This recording is too large. Please record a shorter message.");
      const clip: VoiceMessage = {
        mimeType: "audio/mp4",
        base64: await file.base64(),
        durationMs: Math.min(duration.current, MAX_VOICE_DURATION_MS),
      };
      if (!validVoiceMessage(clip))
        throw new Error("Record for at least a second, then try again.");
      if (alive.current) setVoice(clip);
    } catch (error) {
      if (alive.current)
        setError(error instanceof Error ? error.message : "Couldn't save this recording.");
    } finally {
      deleteSource();
      await setAudioModeAsync({ allowsRecording: false }).catch(() => {});
      stopping.current = false;
      if (alive.current) setBusy(false);
    }
  };
  finishRef.current = finish;
  // Native duration limits stop the microphone even if JS timers are suspended.
  const send = async () => {
    if (!voice || working.current) return;
    working.current = true;
    setBusy(true);
    stopVoicePlayback();
    try {
      if (await onSend(voice)) onClose();
      else setError("Couldn't save your voice message. You can try sending again.");
    } finally {
      working.current = false;
      if (alive.current) setBusy(false);
    }
  };
  const requestClose = () => {
    if (busy) return;
    if (voice || recording)
      Alert.alert("Discard recording?", "Your voice message hasn’t been sent.", [
        { text: recording ? "Keep recording" : "Keep message", style: "cancel" },
        { text: "Discard", style: "destructive", onPress: onClose },
      ]);
    else onClose();
  };
  return (
    <BottomSheet
      title={recording ? "Recording…" : voice ? "Ready to send" : "Voice message"}
      subtitle={replyLabel ? `Replying to ${replyLabel}` : "A little more personal than a message."}
      busy={busy}
      onClose={requestClose}
      footer={
        <View style={{ gap: 4 }}>
          {voice ? (
            <Button
              title="Send voice message"
              fullWidth
              loading={busy}
              onPress={() => {
                void send();
              }}
            />
          ) : (
            <Button
              title={recording ? "Stop recording" : "Start recording"}
              icon={recording ? "stop" : "mic-outline"}
              fullWidth
              loading={busy}
              onPress={() => {
                void (recording ? finish() : start());
              }}
            />
          )}
          {(voice || recording) && (
            <Button title="Discard recording" variant="ghost" disabled={busy} onPress={onClose} />
          )}
        </View>
      }
    >
      {voice ? (
        <View style={{ padding: 16, borderRadius: 16, backgroundColor: colors.surfaceAlt }}>
          <VoicePlayer voice={voice} />
        </View>
      ) : (
        <View style={{ alignItems: "center", gap: 12, paddingVertical: 20 }}>
          <View
            style={{
              width: 64,
              height: 64,
              borderRadius: 32,
              alignItems: "center",
              justifyContent: "center",
              backgroundColor: colors.accentMuted,
            }}
          >
            <Ionicons
              name="mic-outline"
              size={28}
              color={recording ? colors.danger : colors.accent}
            />
          </View>
          <Text
            style={{
              fontSize: 32,
              lineHeight: 40,
              fontVariant: ["tabular-nums"],
              fontWeight: "600",
              color: recording ? colors.danger : colors.textPrimary,
            }}
          >
            {recording ? voiceDuration(state.durationMillis) : "0:00"}
          </Text>
          <Text style={[type.caption, { color: colors.textSecondary }]}>
            {recording ? "Recording · Up to 1 minute" : "Listen before you send · Up to 1 minute"}
          </Text>
        </View>
      )}
      <Notice text={error} />
      {denied && (
        <Button
          title="Open microphone settings"
          variant="ghost"
          onPress={() => {
            void Linking.openSettings();
          }}
        />
      )}
    </BottomSheet>
  );
}
