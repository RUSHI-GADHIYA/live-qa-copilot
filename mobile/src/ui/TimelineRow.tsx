import { useEffect, useState } from 'react';
import { Animated, Pressable, StyleSheet, Text, View } from 'react-native';

import { grounding, type TimelineItem } from '@/store';

import { useTheme } from './theme';

const SUPERSCRIPT = '⁰¹²³⁴⁵⁶⁷⁸⁹';
const superscript = (digits: string) => [...digits].map((d) => SUPERSCRIPT[Number(d)]).join('');

/** "[2]" citation markers shown as small superscript numbers. */
function withCitations(answer: string): string {
  return answer.replace(/\s*\[(\d+)\]/g, (_, n: string) => superscript(n));
}

type Card = Extract<TimelineItem, { kind: 'card' }>;
type Utterance = Extract<TimelineItem, { kind: 'utterance' }>;

export function TimelineRow({ item }: { item: TimelineItem }) {
  return item.kind === 'card' ? <AnswerCard card={item} /> : <UtteranceLine line={item} />;
}

/** Something said that did not become a card, greyed out with the reason. */
function UtteranceLine({ line }: { line: Utterance }) {
  const theme = useTheme();
  const quiet = line.partial || !!line.ignored;
  return (
    <View style={styles.line}>
      <Text style={[styles.lineText, { color: quiet ? theme.muted : theme.text }, line.partial && styles.italic]}>
        {line.text}
      </Text>
      {line.ignored ? (
        <Text style={[styles.tag, { color: theme.muted, borderColor: theme.border }]}>{line.ignored}</Text>
      ) : null}
    </View>
  );
}

function AnswerCard({ card }: { card: Card }) {
  const theme = useTheme();
  const [openSource, setOpenSource] = useState<string | null>(null);
  const [flash] = useState(() => new Animated.Value(0));

  useEffect(() => {
    if (!card.pulse) return;
    flash.setValue(1);
    Animated.timing(flash, { toValue: 0, duration: 1200, useNativeDriver: false }).start();
  }, [card.pulse, flash]);

  const done = card.state === 'done';
  const { cited, label } = grounding(card);
  const docs = [...new Set(cited.map((s) => s.doc))];
  const borderColor = flash.interpolate({ inputRange: [0, 1], outputRange: [card.state === 'error' ? theme.danger : theme.border, theme.accent] });

  return (
    <Animated.View style={[styles.card, { backgroundColor: theme.panel, borderColor }]}>
      <Text style={[styles.question, { color: theme.text }]}>{card.question}</Text>
      {card.state === 'thinking' ? (
        <Text style={[styles.answer, { color: theme.muted }]}>thinking…</Text>
      ) : (
        <Text style={[styles.answer, { color: theme.text }]} selectable>
          {withCitations(card.answer)}
          {card.state === 'streaming' ? <Text style={{ color: theme.accent }}> ▍</Text> : null}
        </Text>
      )}
      {card.error ? <Text style={[styles.error, { color: theme.danger }]}>{card.error}</Text> : null}
      {done && (docs.length || label) ? (
        <View style={styles.chips}>
          {docs.map((doc) => (
            <Pressable key={doc} onPress={() => setOpenSource(openSource === doc ? null : doc)}>
              <Text style={[styles.chip, { color: theme.accent, borderColor: theme.accent }]}>{doc}</Text>
            </Pressable>
          ))}
          {label === 'general' ? <Text style={[styles.chip, { color: theme.muted, borderColor: theme.border }]}>General knowledge</Text> : null}
          {label === 'missing' ? <Text style={[styles.chip, { color: theme.warn, borderColor: theme.warn }]}>Not in your notes</Text> : null}
        </View>
      ) : null}
      {openSource
        ? cited
            .filter((s) => s.doc === openSource)
            .map((s) => (
              <Text key={s.n} style={[styles.snippet, { color: theme.muted, borderColor: theme.border }]}>
                {superscript(String(s.n))} {s.snippet}
              </Text>
            ))
        : null}
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  line: { flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: 6, paddingHorizontal: 4 },
  lineText: { fontSize: 15, lineHeight: 21 },
  italic: { fontStyle: 'italic' },
  tag: { fontSize: 11, borderWidth: 1, borderRadius: 10, paddingHorizontal: 7, paddingVertical: 1 },
  card: { borderWidth: 1.5, borderRadius: 12, padding: 14, gap: 6 },
  question: { fontSize: 15, fontWeight: '700' },
  answer: { fontSize: 17, lineHeight: 25 },
  error: { fontSize: 13 },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 4 },
  chip: { fontSize: 12, borderWidth: 1, borderRadius: 10, paddingHorizontal: 8, paddingVertical: 2 },
  snippet: { fontSize: 13, lineHeight: 18, borderLeftWidth: 2, paddingLeft: 8 },
});
