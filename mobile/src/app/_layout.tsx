import { DarkTheme, DefaultTheme, Link, Stack, ThemeProvider } from 'expo-router';
import { useEffect } from 'react';
import { Pressable, StyleSheet, Text, useColorScheme, View } from 'react-native';

import { useCopilot } from '@/services/copilot';
import { useConversation } from '@/store';
import { ListeningIndicator } from '@/ui/ListeningIndicator';
import { useTheme } from '@/ui/theme';

function ConversationTitle() {
  const theme = useTheme();
  const listening = useConversation((s) => s.listening);
  return (
    <View style={styles.title}>
      <Text style={[styles.titleText, { color: theme.text }]}>Conversation</Text>
      <ListeningIndicator active={listening} />
    </View>
  );
}

function HeaderLinks() {
  const theme = useTheme();
  return (
    <View style={styles.links}>
      {(['documents', 'settings'] as const).map((route) => (
        <Link key={route} href={`/${route}`} asChild>
          <Pressable hitSlop={8}>
            <Text style={[styles.link, { color: theme.accent }]}>{route === 'documents' ? 'Docs' : 'Settings'}</Text>
          </Pressable>
        </Link>
      ))}
    </View>
  );
}

export default function RootLayout() {
  const scheme = useColorScheme();
  const theme = useTheme();
  const init = useCopilot((s) => s.init);

  useEffect(() => {
    void init();
  }, [init]);

  return (
    <ThemeProvider value={scheme === 'dark' ? DarkTheme : DefaultTheme}>
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: theme.panel },
          headerTintColor: theme.text,
          contentStyle: { backgroundColor: theme.background },
        }}>
        <Stack.Screen name="index" options={{ headerTitle: () => <ConversationTitle />, headerRight: () => <HeaderLinks /> }} />
        <Stack.Screen name="documents" options={{ title: 'Documents' }} />
        <Stack.Screen name="settings" options={{ title: 'Settings' }} />
      </Stack>
    </ThemeProvider>
  );
}

const styles = StyleSheet.create({
  title: { gap: 2 },
  titleText: { fontSize: 18, fontWeight: '700' },
  links: { flexDirection: 'row', gap: 18 },
  link: { fontSize: 15, fontWeight: '600' },
});
