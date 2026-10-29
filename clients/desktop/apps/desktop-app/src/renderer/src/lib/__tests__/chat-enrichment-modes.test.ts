/** @jest-environment jsdom */
import type { PreferencesData } from '@canopy/desktop-shared/types';
import { emitPreferencesUpdated } from '../preferences-events';

const mockPolicy = jest.fn();
jest.mock('@canopy/app-state', () => ({
  setReferenceEnrichmentModes: mockPolicy,
}));

let synced: (prefs: PreferencesData) => void;
let resolveLoad: (prefs: PreferencesData) => void;
beforeEach(() => {
  jest.resetModules();
  mockPolicy.mockReset();
  window.api = {
    loadPreferences: jest.fn(
      () =>
        new Promise((resolve) => {
          resolveLoad = resolve;
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
  const { disposeChatEnrichmentModes } =
    await import('../chat-enrichment-modes');
  disposeChatEnrichmentModes();
});

const preferences = (linear: unknown, github: unknown): PreferencesData =>
  ({
    showDiagnosticsPill: false,
    linearChatEnrichmentMode: linear,
    githubChatEnrichmentMode: github,
  }) as PreferencesData;

it('starts Off, initializes before render, and follows both preference broadcast paths', async () => {
  const { initializeChatEnrichmentModes, useChatEnrichmentModes } =
    await import('../chat-enrichment-modes');
  const pending = initializeChatEnrichmentModes();
  expect(mockPolicy).toHaveBeenLastCalledWith({ linear: 'off', github: 'off' });
  resolveLoad(preferences('hover', 'off'));
  await pending;
  expect(mockPolicy).toHaveBeenLastCalledWith({
    linear: 'hover',
    github: 'off',
  });
  synced(preferences('off', 'replace'));
  expect(mockPolicy).toHaveBeenLastCalledWith({
    linear: 'off',
    github: 'replace',
  });
  emitPreferencesUpdated(preferences('replace', 'hover'));
  expect(mockPolicy).toHaveBeenLastCalledWith({
    linear: 'replace',
    github: 'hover',
  });
  expect(typeof useChatEnrichmentModes).toBe('function');
});

it('never lets the initial read overwrite a newer synced preference', async () => {
  const { initializeChatEnrichmentModes } =
    await import('../chat-enrichment-modes');
  const pending = initializeChatEnrichmentModes();
  synced(preferences('off', 'hover'));
  resolveLoad(preferences('replace', 'replace'));
  await pending;
  expect(mockPolicy).toHaveBeenLastCalledWith({
    linear: 'off',
    github: 'hover',
  });
});

it('normalizes each provider independently and keeps Off after a failed load', async () => {
  window.api.loadPreferences = jest
    .fn()
    .mockRejectedValue(new Error('failed read'));
  const { initializeChatEnrichmentModes } =
    await import('../chat-enrichment-modes');
  await initializeChatEnrichmentModes();
  expect(mockPolicy).toHaveBeenLastCalledWith({ linear: 'off', github: 'off' });
  synced(preferences('hover', 'invalid'));
  expect(mockPolicy).toHaveBeenLastCalledWith({
    linear: 'hover',
    github: 'hover',
  });
  synced(preferences(undefined, 'off'));
  expect(mockPolicy).toHaveBeenLastCalledWith({
    linear: 'replace',
    github: 'off',
  });
});
