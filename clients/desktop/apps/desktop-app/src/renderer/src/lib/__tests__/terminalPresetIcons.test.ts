/** @jest-environment jsdom */

import {
  readTerminalPresetColorMode,
  resolveTerminalPresetImageDataUrl,
} from '../terminalPresetIcons';

describe('terminal preset themed images', () => {
  it('resolves the matching image when both modes are configured', () => {
    const icon = {
      kind: 'image' as const,
      lightDataUrl: 'light-image',
      darkDataUrl: 'dark-image',
    };

    expect(resolveTerminalPresetImageDataUrl(icon, 'light')).toBe(
      'light-image',
    );
    expect(resolveTerminalPresetImageDataUrl(icon, 'dark')).toBe('dark-image');
  });

  it.each([
    ['lightDataUrl', 'light-image'],
    ['darkDataUrl', 'dark-image'],
  ] as const)('reuses a lone %s in both modes', (field, dataUrl) => {
    const icon = { kind: 'image' as const, [field]: dataUrl };

    expect(resolveTerminalPresetImageDataUrl(icon, 'light')).toBe(dataUrl);
    expect(resolveTerminalPresetImageDataUrl(icon, 'dark')).toBe(dataUrl);
  });

  it('reads the currently resolved document mode', () => {
    document.documentElement.classList.remove('dark');
    expect(readTerminalPresetColorMode()).toBe('light');
    document.documentElement.classList.add('dark');
    expect(readTerminalPresetColorMode()).toBe('dark');
    document.documentElement.classList.remove('dark');
  });
});
