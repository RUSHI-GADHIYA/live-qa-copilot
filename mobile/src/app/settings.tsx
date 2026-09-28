import { useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';

import { DEFAULT_SETTINGS, type Settings } from '@/core/config';
import { OpenAIClient } from '@/core/openai';
import { useCopilot } from '@/services/copilot';
import { useConversation } from '@/store';
import { useTheme } from '@/ui/theme';

export default function SettingsScreen() {
  const settings = useCopilot((s) => s.settings);
  const theme = useTheme();
  // Settings load at app start; the form starts from them once they are there.
  return settings ? <SettingsForm initial={settings} /> : <ActivityIndicator style={styles.loading} color={theme.accent} />;
}

function SettingsForm({ initial }: { initial: Settings }) {
  const theme = useTheme();
  const { hasKey, setApiKey, updateSettings } = useCopilot();
  const listening = useConversation((s) => s.listening);
  const [key, setKey] = useState('');
  const [keyStatus, setKeyStatus] = useState<{ ok: boolean; text: string } | null>(null);
  const [checking, setChecking] = useState(false);
  const [draft, setDraft] = useState<Settings>(initial);
  const [saved, setSaved] = useState(false);

  const saveKey = async () => {
    const trimmed = key.trim();
    if (!trimmed) return;
    setChecking(true);
    setKeyStatus(null);
    try {
      // Verify before storing, so a typo does not silently break listening. Free: no tokens.
      await new OpenAIClient(trimmed).checkAccess(draft.answerModel);
      await setApiKey(trimmed);
      setKey('');
      setKeyStatus({ ok: true, text: `Key saved (ending …${trimmed.slice(-4)}).` });
    } catch (error) {
      setKeyStatus({ ok: false, text: (error as Error).message });
    } finally {
      setChecking(false);
    }
  };

  const set = <K extends keyof Settings>(name: K, value: Settings[K]) => {
    setDraft((d) => ({ ...d, [name]: value }));
    setSaved(false);
  };

  const field = (label: string, name: 'transcribeModel' | 'detectorModel' | 'answerModel') => (
    <View style={styles.field}>
      <Text style={[styles.label, { color: theme.text }]}>{label}</Text>
      <TextInput
        value={draft[name]}
        onChangeText={(v) => set(name, v.trim())}
        autoCapitalize="none"
        autoCorrect={false}
        style={[styles.input, { color: theme.text, borderColor: theme.border, backgroundColor: theme.panel }]}
      />
    </View>
  );

  const toggle = (label: string, hint: string, name: 'speculativeAnswers' | 'skipSilence') => (
    <View style={styles.toggle}>
      <View style={styles.toggleText}>
        <Text style={[styles.label, { color: theme.text }]}>{label}</Text>
        <Text style={[styles.hint, { color: theme.muted }]}>{hint}</Text>
      </View>
      <Switch value={draft[name]} onValueChange={(v) => set(name, v)} />
    </View>
  );

  return (
    <ScrollView contentContainerStyle={styles.pad} keyboardShouldPersistTaps="handled">
      <Text style={[styles.section, { color: theme.text }]}>OpenAI API key</Text>
      <Text style={[styles.hint, { color: theme.muted }]}>
        {hasKey ? 'A key is saved on this phone. Enter a new one to replace it.' : 'Needed to transcribe and answer.'} It is kept
        in Android’s secure storage and sent only to OpenAI.
      </Text>
      <TextInput
        value={key}
        onChangeText={setKey}
        placeholder="sk-..."
        placeholderTextColor={theme.muted}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
        style={[styles.input, { color: theme.text, borderColor: theme.border, backgroundColor: theme.panel }]}
      />
      <Pressable onPress={saveKey} disabled={checking || !key.trim()} style={[styles.button, { backgroundColor: theme.accent, opacity: checking || !key.trim() ? 0.5 : 1 }]}>
        {checking ? <ActivityIndicator color="#fff" /> : <Text style={styles.buttonText}>Check and save key</Text>}
      </Pressable>
      {keyStatus ? <Text style={{ color: keyStatus.ok ? theme.accent : theme.danger }}>{keyStatus.text}</Text> : null}

      <Text style={[styles.section, { color: theme.text }]}>Behaviour</Text>
      {toggle('Answer while checking', 'Start the answer while the question check runs. About 1 s faster.', 'speculativeAnswers')}
      {toggle('Skip silence', 'Only send audio while someone speaks. Lower cost, same accuracy.', 'skipSilence')}
      <View style={styles.field}>
        <Text style={[styles.label, { color: theme.text }]}>End-of-question pause (ms)</Text>
        <Text style={[styles.hint, { color: theme.muted }]}>Raise it if slow speakers get cut off mid-sentence.</Text>
        <TextInput
          value={String(draft.vadSilenceMs)}
          onChangeText={(v) => set('vadSilenceMs', Math.min(2000, Math.max(200, Number(v.replace(/\D/g, '')) || 0)))}
          keyboardType="number-pad"
          style={[styles.input, { color: theme.text, borderColor: theme.border, backgroundColor: theme.panel }]}
        />
      </View>

      <Text style={[styles.section, { color: theme.text }]}>Models</Text>
      {field('Transcription', 'transcribeModel')}
      {field('Question check', 'detectorModel')}
      {field('Answers', 'answerModel')}

      <Pressable
        onPress={async () => {
          await updateSettings(draft);
          setSaved(true);
        }}
        style={[styles.button, { backgroundColor: theme.accent }]}>
        <Text style={styles.buttonText}>{saved ? 'Saved' : 'Save settings'}</Text>
      </Pressable>
      {listening ? (
        <Text style={[styles.hint, { color: theme.muted }]}>Transcription changes apply the next time you start listening.</Text>
      ) : null}
      <Pressable onPress={() => { setDraft(DEFAULT_SETTINGS); setSaved(false); }} style={styles.reset}>
        <Text style={{ color: theme.muted }}>Reset to defaults</Text>
      </Pressable>

      <Text style={[styles.hint, styles.privacy, { color: theme.muted }]}>
        While listening, audio is streamed to OpenAI for transcription, and questions, your documents and answers are sent
        to OpenAI. Tell the people you are talking to, and get their consent before recording them.
      </Text>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  loading: { flex: 1 },
  pad: { padding: 16, gap: 10 },
  section: { fontSize: 16, fontWeight: '700', marginTop: 14 },
  field: { gap: 4 },
  label: { fontSize: 15, fontWeight: '600' },
  hint: { fontSize: 13, lineHeight: 18 },
  input: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15 },
  button: { borderRadius: 10, paddingVertical: 12, alignItems: 'center', minHeight: 46, justifyContent: 'center' },
  buttonText: { color: '#fff', fontSize: 15, fontWeight: '600' },
  toggle: { flexDirection: 'row', alignItems: 'center', gap: 12 },
  toggleText: { flex: 1, gap: 2 },
  reset: { alignItems: 'center', paddingVertical: 8 },
  privacy: { marginTop: 16 },
});
