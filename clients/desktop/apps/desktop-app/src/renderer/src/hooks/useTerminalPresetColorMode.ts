import { useEffect, useState } from 'react';
import {
  readTerminalPresetColorMode,
  type TerminalPresetColorMode,
} from '@/lib/terminalPresetIcons';

export function useTerminalPresetColorMode(): TerminalPresetColorMode {
  const [colorMode, setColorMode] = useState<TerminalPresetColorMode>(() =>
    readTerminalPresetColorMode(),
  );

  useEffect(() => {
    const root = document.documentElement;
    const observer = new MutationObserver(() => {
      setColorMode(readTerminalPresetColorMode());
    });
    observer.observe(root, { attributes: true, attributeFilter: ['class'] });
    return (): void => observer.disconnect();
  }, []);

  return colorMode;
}
