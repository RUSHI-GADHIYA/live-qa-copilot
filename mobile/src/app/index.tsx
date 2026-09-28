import { Link } from 'expo-router';
import { useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useCopilot } from '@/services/copilot';
import { useMicrophone } from '@/services/microphone';
import { useConversation, type TimelineItem } from '@/store';
import { TimelineRow } from '@/ui/TimelineRow';
import { useTheme } from '@/ui/theme';

export default function ConversationScreen() {
  const theme = useTheme();
  const { copilot, ready, hasKey } = useCopilot();
  const { items, listening, notice, setNotice, clear } = useConversation();
  const mic = useMicrophone(copilot);
  const [typed, setTyped] = useState('');
  const list = useRef<FlatList<TimelineItem>>(null);

  if (!ready) return <ActivityIndicator style={styles.center} color={theme.accent} />;

  if (!hasKey || !copilot) {
    return (
      <View style={[styles.center, styles.setup]}>
        <Text style={[styles.setupTitle, { color: theme.text }]}>Add your OpenAI API key</Text>
        <Text style={[styles.setupText, { color: theme.muted }]}>
          It is stored only on this phone, in Android’s secure storage, and used to call OpenAI directly.
        </Text>
        <Link href="/settings" asChild>
          <Pressable style={[styles.primary, { backgroundColor: theme.accent }]}>
            <Text style={styles.primaryText}>Open settings</Text>
          </Pressable>
        </Link>
      </View>
    );
  }

  const toggle = async () => {
    setNotice(null);
    try {
      if (listening) await mic.stop();
      else await mic.start();
    } catch (error) {
      setNotice((error as Error).message);
    }
  };

  const send = () => {
    const text = typed.trim();
    if (!text) return;
    copilot.ask(text);
    setTyped('');
  };

  return (
    <SafeAreaView edges={['bottom']} style={styles.fill}>
      {notice ? (
        <Pressable onPress={() => setNotice(null)} style={[styles.notice, { backgroundColor: theme.panel, borderColor: theme.danger }]}>
          <Text style={{ color: theme.danger }}>{notice}</Text>
        </Pressable>
      ) : null}

      <FlatList
        ref={list}
        data={items}
        keyExtractor={(item) => item.key}
        renderItem={({ item }) => <TimelineRow item={item} />}
        contentContainerStyle={styles.timeline}
        onContentSizeChange={() => list.current?.scrollToEnd({ animated: true })}
        ListEmptyComponent={
          <Text style={[styles.empty, { color: theme.muted }]}>
            Tap the mic and put the phone near the conversation. Questions get answer cards; what you say while
            reading an answer is ignored.
          </Text>
        }
      />

      <View style={[styles.bar, { backgroundColor: theme.panel, borderColor: theme.border }]}>
        {items.length ? (
          <Pressable
            onPress={() => {
              copilot.clearConversation();
              clear();
            }}
            hitSlop={8}>
            <Text style={[styles.clear, { color: theme.muted }]}>Clear</Text>
          </Pressable>
        ) : null}
        <TextInput
          value={typed}
          onChangeText={setTyped}
          onSubmitEditing={send}
          placeholder="Type a question"
          placeholderTextColor={theme.muted}
          returnKeyType="send"
          style={[styles.input, { color: theme.text, borderColor: theme.border, backgroundColor: theme.background }]}
        />
        <Pressable
          onPress={toggle}
          disabled={mic.starting}
          accessibilityLabel={listening ? 'Stop listening' : 'Start listening'}
          style={[styles.mic, { backgroundColor: listening ? theme.live : theme.accent, opacity: mic.starting ? 0.5 : 1 }]}>
          {mic.starting ? <ActivityIndicator color="#fff" /> : <Text style={styles.micText}>{listening ? '■' : '🎙'}</Text>}
        </Pressable>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  center: { flex: 1, justifyContent: 'center', alignItems: 'center' },
  setup: { padding: 32, gap: 12 },
  setupTitle: { fontSize: 20, fontWeight: '700' },
  setupText: { fontSize: 15, textAlign: 'center', lineHeight: 21 },
  primary: { borderRadius: 10, paddingHorizontal: 20, paddingVertical: 12, marginTop: 8 },
  primaryText: { color: '#fff', fontSize: 16, fontWeight: '600' },
  notice: { margin: 12, marginBottom: 0, padding: 10, borderRadius: 8, borderWidth: 1 },
  timeline: { padding: 16, gap: 12, flexGrow: 1 },
  empty: { fontSize: 15, lineHeight: 22, textAlign: 'center', marginTop: 48, paddingHorizontal: 16 },
  bar: { flexDirection: 'row', alignItems: 'center', gap: 10, padding: 10, borderTopWidth: 1 },
  clear: { fontSize: 14 },
  input: { flex: 1, borderWidth: 1, borderRadius: 20, paddingHorizontal: 14, paddingVertical: 8, fontSize: 15 },
  mic: { width: 52, height: 52, borderRadius: 26, alignItems: 'center', justifyContent: 'center' },
  micText: { fontSize: 22, color: '#fff' },
});
