import { nativeTheme } from 'electron';
import { BRAND } from '@canopy/brand/current';
import { readPreferencesFile } from '../../lib/preferences-store';
import { AGENT_VISUAL_THEME_DEFAULTS } from '@canopy/ui-shared/lib/agent-visual-theme-defaults';
import { resolveVisualPreviewTheme } from '../visual-preview-theme';

jest.mock('electron', () => ({ nativeTheme: { shouldUseDarkColors: false } }));
jest.mock('../../lib/preferences-store', () => ({
  readPreferencesFile: jest.fn(),
}));
const preferences = jest.mocked(readPreferencesFile);

it('uses the selected built-in theme and requested appearance', async () => {
  preferences.mockResolvedValue({
    theme: 'ocean',
    colorMode: 'light',
  } as never);
  expect(await resolveVisualPreviewTheme('dark')).toEqual({
    appearance: 'dark',
    variables: AGENT_VISUAL_THEME_DEFAULTS[BRAND.id].ocean.dark,
  });
});

it('uses native appearance for system mode and defaults on unreadable preferences', async () => {
  preferences.mockResolvedValue({
    theme: 'forest',
    colorMode: 'system',
  } as never);
  Object.defineProperty(nativeTheme, 'shouldUseDarkColors', {
    value: true,
    configurable: true,
  });
  expect((await resolveVisualPreviewTheme()).appearance).toBe('dark');
  preferences.mockRejectedValue(new Error('unavailable'));
  expect((await resolveVisualPreviewTheme()).variables).toEqual(
    AGENT_VISUAL_THEME_DEFAULTS[BRAND.id].default.dark,
  );
});
