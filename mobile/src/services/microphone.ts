import { AudioStudioModule, useAudioRecorder, type AudioDataEvent } from '@siteed/audio-studio';
import { activateKeepAwakeAsync, deactivateKeepAwake } from 'expo-keep-awake';
import { useCallback, useEffect, useRef, useState } from 'react';

import { base64ToBytes, bytesToInt16 } from '@/core/audio/pcm';
import type { Copilot } from '@/core/copilot';

const KEEP_AWAKE_TAG = 'listening';

/**
 * Streams the phone microphone into the Copilot: 48 kHz mono PCM16 in 100 ms chunks (the library cannot record
 * at 24 kHz; the core downsamples). A foreground-service notification keeps it running with the screen off and
 * shows the mic icon in the status bar.
 */
export function useMicrophone(copilot: Copilot | null) {
  const { startRecording, stopRecording, isRecording } = useAudioRecorder();
  const [starting, setStarting] = useState(false);
  // The audio callback is registered once per recording; it reads the current Copilot through this ref.
  const copilotRef = useRef(copilot);
  useEffect(() => {
    copilotRef.current = copilot;
  }, [copilot]);

  const onAudioStream = useCallback(async (event: AudioDataEvent) => {
    if (typeof event.data !== 'string') return; // native delivers base64 PCM
    copilotRef.current?.pushAudio48k(bytesToInt16(base64ToBytes(event.data)));
  }, []);

  const start = useCallback(async () => {
    if (!copilot || copilot.listening) return;
    setStarting(true);
    try {
      const permission = await AudioStudioModule.requestPermissionsAsync();
      if (!permission.granted) throw new Error('Microphone permission is needed to listen.');
      await copilot.startListening(); // connect transcription first, so no speech is lost
      try {
        await startRecording({
          sampleRate: 48000,
          channels: 1,
          encoding: 'pcm_16bit',
          interval: 100,
          keepAwake: true,
          showNotification: true,
          notification: {
            title: 'Live Copilot',
            text: 'Listening to the conversation',
            android: { channelId: 'listening', channelName: 'Listening', priority: 'low' },
          },
          output: { primary: { enabled: false } }, // stream only, never write audio to disk
          onAudioStream,
        });
      } catch (error) {
        copilot.stopListening();
        throw error;
      }
      await activateKeepAwakeAsync(KEEP_AWAKE_TAG);
    } finally {
      setStarting(false);
    }
  }, [copilot, onAudioStream, startRecording]);

  const stop = useCallback(async () => {
    copilot?.stopListening();
    await stopRecording().catch(() => null);
    await deactivateKeepAwake(KEEP_AWAKE_TAG);
  }, [copilot, stopRecording]);

  return { start, stop, isRecording, starting };
}
