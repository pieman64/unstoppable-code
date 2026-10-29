import type { TerminalPresetIcon } from '@canopy/desktop-shared/types';

export type TerminalPresetColorMode = 'light' | 'dark';

export function readTerminalPresetColorMode(
  documentRoot: Document = document,
): TerminalPresetColorMode {
  return documentRoot.documentElement.classList.contains('dark')
    ? 'dark'
    : 'light';
}

export function resolveTerminalPresetImageDataUrl(
  icon: TerminalPresetIcon | undefined,
  colorMode: TerminalPresetColorMode,
): string | undefined {
  if (icon?.kind !== 'image') return undefined;
  return colorMode === 'dark'
    ? (icon.darkDataUrl ?? icon.lightDataUrl)
    : (icon.lightDataUrl ?? icon.darkDataUrl);
}
