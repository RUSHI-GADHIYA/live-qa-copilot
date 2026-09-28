import { File, Paths } from 'expo-file-system';
import * as SecureStore from 'expo-secure-store';

import { DEFAULT_SETTINGS, type Settings } from '@/core/config';
import type { ContextStorage } from '@/core/contextStore';

const API_KEY = 'openai_api_key';

/** The OpenAI key lives only in Android's keystore-backed secure storage, never in the app bundle. */
export const apiKeyStore = {
  get: () => SecureStore.getItemAsync(API_KEY),
  set: (key: string) => SecureStore.setItemAsync(API_KEY, key.trim()),
  clear: () => SecureStore.deleteItemAsync(API_KEY),
};

function jsonFile(name: string) {
  const file = new File(Paths.document, name);
  return {
    read: async (): Promise<string | null> => (file.exists ? file.text() : null),
    write: async (json: string) => {
      if (!file.exists) file.create();
      file.write(json);
    },
  };
}

const settingsFile = jsonFile('settings.json');

export async function loadSettings(): Promise<Settings> {
  const json = await settingsFile.read();
  return json ? { ...DEFAULT_SETTINGS, ...JSON.parse(json) } : DEFAULT_SETTINGS;
}

export async function saveSettings(settings: Settings): Promise<void> {
  await settingsFile.write(JSON.stringify(settings));
}

/** Documents and their embeddings, kept between launches. */
export const contextStorage: ContextStorage = (() => {
  const file = jsonFile('context.json');
  return { load: file.read, save: file.write };
})();
