import { fetch as expoFetch } from 'expo/fetch';
import { create } from 'zustand';

import type { Settings } from '@/core/config';
import { Copilot } from '@/core/copilot';
import type { FetchLike } from '@/core/openai';
import type { SocketLike } from '@/core/transcriber';
import { useConversation } from '@/store';

import { apiKeyStore, contextStorage, loadSettings, saveSettings } from './persistence';

// expo/fetch streams response bodies on Android, which live answers need.
const fetchImpl = expoFetch as unknown as FetchLike;

// React Native's WebSocket takes headers as a third argument; the Realtime API authenticates with one.
const socketFactory = (url: string, headers: Record<string, string>) =>
  new (WebSocket as unknown as new (url: string, protocols: undefined, options: { headers: Record<string, string> }) => SocketLike)(
    url,
    undefined,
    { headers },
  );

interface CopilotState {
  copilot: Copilot | null;
  ready: boolean; // key and settings loaded
  hasKey: boolean;
  settings: Settings | null;
  init: () => Promise<void>;
  setApiKey: (key: string) => Promise<void>;
  updateSettings: (settings: Settings) => Promise<void>;
}

function build(apiKey: string, settings: Settings): Copilot {
  const copilot = new Copilot({
    apiKey,
    fetch: fetchImpl,
    socketFactory,
    settings,
    contextStorage,
    emit: (event) => useConversation.getState().apply(event),
    log: __DEV__ ? (message) => console.log(`[copilot] ${message}`) : undefined,
  });
  void copilot.context.load().then(() => useCopilot.setState({}));
  return copilot;
}

/** The app's single Copilot, rebuilt when the API key changes. */
export const useCopilot = create<CopilotState>((set, get) => ({
  copilot: null,
  ready: false,
  hasKey: false,
  settings: null,
  init: async () => {
    const [apiKey, settings] = await Promise.all([apiKeyStore.get(), loadSettings()]);
    set({ settings, hasKey: !!apiKey, ready: true, copilot: apiKey ? build(apiKey, settings) : null });
  },
  setApiKey: async (key) => {
    get().copilot?.stopListening();
    await apiKeyStore.set(key);
    set({ hasKey: true, copilot: build(key.trim(), get().settings!) });
  },
  updateSettings: async (settings) => {
    await saveSettings(settings);
    const copilot = get().copilot;
    if (copilot) copilot.settings = settings; // takes effect for the next question / next listening start
    set({ settings });
  },
}));
