/** @jest-environment jsdom */
import type { PreferencesData } from '@canopy/desktop-shared/types';
import { emitPreferencesUpdated } from '../preferences-events';

const mockSetEnabled = jest.fn();
jest.mock('@canopy/ui-shared/components/Markdown', () => ({
  setSingleDollarMathEnabled: mockSetEnabled,
}));

let synced: (prefs: PreferencesData) => void;
let resolveLoad: (prefs: PreferencesData) => void;
let rejectLoad: (error: Error) => void;
beforeEach(() => {
  jest.resetModules();
  mockSetEnabled.mockReset();
  window.api = {
    loadPreferences: jest.fn(
      () =>
        new Promise((resolve, reject) => {
          resolveLoad = resolve;
          rejectLoad = reject;
        }),
    ),
    onPreferencesSynced: jest.fn(
      (callback: (prefs: PreferencesData) => void): (() => void) => {
        synced = callback;
        return (): void => undefined;
      },
    ),
  } as unknown as typeof window.api;
});
afterEach(async () => {
  const { disposeMarkdownMathPreference } =
    await import('../markdown-math-preference');
  disposeMarkdownMathPreference();
});

const preferences = (singleDollarMath: unknown): PreferencesData =>
  ({ showDiagnosticsPill: false, singleDollarMath }) as PreferencesData;

it('applies the saved choice before render and follows both broadcast paths', async () => {
  const { initializeMarkdownMathPreference } =
    await import('../markdown-math-preference');
  const pending = initializeMarkdownMathPreference();
  resolveLoad(preferences(false));
  await pending;
  expect(mockSetEnabled).toHaveBeenLastCalledWith(false);
  synced(preferences(true));
  expect(mockSetEnabled).toHaveBeenLastCalledWith(true);
  emitPreferencesUpdated(preferences(false));
  expect(mockSetEnabled).toHaveBeenLastCalledWith(false);
});

it('treats a missing value as on and never lets the load overwrite a newer broadcast', async () => {
  const { initializeMarkdownMathPreference } =
    await import('../markdown-math-preference');
  const pending = initializeMarkdownMathPreference();
  synced(preferences(undefined));
  expect(mockSetEnabled).toHaveBeenLastCalledWith(true);
  synced(preferences(false));
  resolveLoad(preferences(true));
  await pending;
  expect(mockSetEnabled).toHaveBeenLastCalledWith(false);
});

it('keeps the default after a failed load', async () => {
  const { initializeMarkdownMathPreference } =
    await import('../markdown-math-preference');
  const pending = initializeMarkdownMathPreference();
  rejectLoad(new Error('unreadable'));
  await pending;
  expect(mockSetEnabled).not.toHaveBeenCalled();
});
