import { useEffect, useState } from 'react';
import { Animated, StyleSheet, Text, View } from 'react-native';

import { useTheme } from './theme';

/** The small "app is listening" symbol: a pulsing dot while the mic is live, a grey one otherwise. */
export function ListeningIndicator({ active }: { active: boolean }) {
  const theme = useTheme();
  const [opacity] = useState(() => new Animated.Value(1));

  useEffect(() => {
    if (!active) {
      opacity.setValue(1);
      return;
    }
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, { toValue: 0.25, duration: 700, useNativeDriver: true }),
        Animated.timing(opacity, { toValue: 1, duration: 700, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [active, opacity]);

  return (
    <View style={styles.row} accessibilityRole="text" accessibilityLabel={active ? 'Listening' : 'Not listening'}>
      <Animated.View style={[styles.dot, { backgroundColor: active ? theme.live : theme.muted, opacity }]} />
      <Text style={[styles.label, { color: active ? theme.live : theme.muted }]}>{active ? 'Listening' : 'Paused'}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  dot: { width: 8, height: 8, borderRadius: 4 },
  label: { fontSize: 12, fontWeight: '600' },
});
