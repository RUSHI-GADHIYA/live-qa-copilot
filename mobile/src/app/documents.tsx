import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import { extractText as extractPdfText, isAvailable as pdfAvailable } from 'expo-pdf-text-extract';
import { useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native';

import { CONTEXT_LIMITS } from '@/core/config';
import { extractText } from '@/core/extract';
import { useCopilot } from '@/services/copilot';
import { useTheme } from '@/ui/theme';

const MIME_TYPES = [
  'text/plain',
  'text/markdown',
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/octet-stream', // some file managers report .md files this way
];

export default function DocumentsScreen() {
  const theme = useTheme();
  const copilot = useCopilot((s) => s.copilot);
  const [, refresh] = useState(0);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pasteName, setPasteName] = useState('');
  const [pasteText, setPasteText] = useState('');

  if (!copilot) {
    return <Text style={[styles.pad, { color: theme.muted }]}>Add your OpenAI API key in Settings first: documents are indexed with it.</Text>;
  }
  const summary = copilot.context.summary();

  const run = async (label: string, action: () => Promise<unknown>) => {
    setBusy(label);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
      refresh((n) => n + 1);
    }
  };

  const addFiles = async () => {
    const picked = await DocumentPicker.getDocumentAsync({ type: MIME_TYPES, multiple: true, copyToCacheDirectory: true });
    if (picked.canceled) return;
    for (const asset of picked.assets) {
      await run(`Indexing ${asset.name}…`, async () => {
        const bytes = await new File(asset.uri).bytes();
        const text = await extractText(asset.name, bytes, async () => {
          if (!pdfAvailable()) throw new Error('PDF reading needs the installed app build (not Expo Go).');
          return extractPdfText(asset.uri);
        });
        await copilot.context.add(text, asset.name);
      });
    }
  };

  const addPasted = () =>
    run('Indexing pasted text…', async () => {
      await copilot.context.add(pasteText, pasteName.trim() || 'pasted text');
      setPasteText('');
      setPasteName('');
    });

  const modeLine = !summary.documents.length
    ? 'No documents yet. Answers will come from general knowledge.'
    : summary.mode === 'full'
      ? `${summary.totalChars.toLocaleString()} chars: all of it is sent with each question.`
      : `${summary.totalChars.toLocaleString()} chars in ${summary.chunks} chunks: small documents plus the ${CONTEXT_LIMITS.retrievalTopK} most relevant chunks are sent with each question.`;

  return (
    <ScrollView contentContainerStyle={styles.pad} keyboardShouldPersistTaps="handled">
      <Text style={[styles.muted, { color: theme.muted }]}>{modeLine}</Text>

      {summary.documents.map((doc) => (
        <View key={doc.id} style={[styles.doc, { backgroundColor: theme.panel, borderColor: theme.border }]}>
          <View style={styles.docText}>
            <Text style={[styles.docName, { color: theme.text }]} numberOfLines={1}>
              {doc.name}
            </Text>
            <Text style={[styles.muted, { color: theme.muted }]} numberOfLines={2}>
              {doc.chars.toLocaleString()} chars · {doc.preview}
            </Text>
          </View>
          <Pressable onPress={() => run('Removing…', () => copilot.context.remove(doc.id))} hitSlop={10} accessibilityLabel={`Remove ${doc.name}`}>
            <Text style={[styles.remove, { color: theme.muted }]}>✕</Text>
          </Pressable>
        </View>
      ))}

      {busy ? (
        <View style={styles.row}>
          <ActivityIndicator color={theme.accent} />
          <Text style={{ color: theme.muted }}>{busy}</Text>
        </View>
      ) : null}
      {error ? <Text style={{ color: theme.danger }}>{error}</Text> : null}

      <Pressable onPress={addFiles} disabled={!!busy} style={[styles.button, { backgroundColor: theme.accent, opacity: busy ? 0.5 : 1 }]}>
        <Text style={styles.buttonText}>Add files (txt, md, pdf, docx)</Text>
      </Pressable>

      <Text style={[styles.section, { color: theme.text }]}>Paste text</Text>
      <TextInput
        value={pasteName}
        onChangeText={setPasteName}
        placeholder="Name (optional), e.g. job description"
        placeholderTextColor={theme.muted}
        style={[styles.input, { color: theme.text, borderColor: theme.border, backgroundColor: theme.panel }]}
      />
      <TextInput
        value={pasteText}
        onChangeText={setPasteText}
        placeholder="Notes, a job description, a policy…"
        placeholderTextColor={theme.muted}
        multiline
        style={[styles.input, styles.multiline, { color: theme.text, borderColor: theme.border, backgroundColor: theme.panel }]}
      />
      <Pressable
        onPress={addPasted}
        disabled={!!busy || !pasteText.trim()}
        style={[styles.button, { backgroundColor: theme.accent, opacity: busy || !pasteText.trim() ? 0.5 : 1 }]}>
        <Text style={styles.buttonText}>Add text</Text>
      </Pressable>

      {summary.documents.length ? (
        <Pressable onPress={() => run('Clearing…', () => copilot.context.clear())} style={styles.clearAll}>
          <Text style={{ color: theme.danger }}>Remove all documents</Text>
        </Pressable>
      ) : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  pad: { padding: 16, gap: 12 },
  muted: { fontSize: 13, lineHeight: 18 },
  doc: { flexDirection: 'row', alignItems: 'center', gap: 12, borderWidth: 1, borderRadius: 10, padding: 12 },
  docText: { flex: 1, gap: 2 },
  docName: { fontSize: 15, fontWeight: '600' },
  remove: { fontSize: 18, paddingHorizontal: 4 },
  row: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  button: { borderRadius: 10, paddingVertical: 12, alignItems: 'center' },
  buttonText: { color: '#fff', fontSize: 15, fontWeight: '600' },
  section: { fontSize: 16, fontWeight: '700', marginTop: 12 },
  input: { borderWidth: 1, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 10, fontSize: 15 },
  multiline: { minHeight: 140, textAlignVertical: 'top' },
  clearAll: { alignItems: 'center', paddingVertical: 12 },
});
