import { useColorScheme } from 'react-native';

const light = {
  background: '#f6f7f9',
  panel: '#ffffff',
  border: '#dde1e6',
  text: '#1d2330',
  muted: '#6b7380',
  accent: '#2563eb',
  danger: '#dc2626',
  warn: '#b45309',
  live: '#e11d48',
};

const dark: typeof light = {
  background: '#111418',
  panel: '#1a1f26',
  border: '#2d343e',
  text: '#e6e9ee',
  muted: '#8b93a0',
  accent: '#5b8cff',
  danger: '#f87171',
  warn: '#fbbf24',
  live: '#fb7185',
};

export type Theme = typeof light;

export function useTheme(): Theme {
  return useColorScheme() === 'dark' ? dark : light;
}
