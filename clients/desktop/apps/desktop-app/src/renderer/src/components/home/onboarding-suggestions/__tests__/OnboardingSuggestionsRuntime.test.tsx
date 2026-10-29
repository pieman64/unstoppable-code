/**
 * @jest-environment jsdom
 *
 * The single mounted owner of the onboarding suggestions module: it starts
 * the module for every install, and only the E2E harness can keep it away
 * (so unrelated automation sees the settled Home and sidebar).
 */
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

import { act, createElement, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { PreferencesData } from '@canopy/desktop-shared/types';
import { OnboardingSuggestionsRuntime } from '../OnboardingSuggestionsRuntime';
import { useOnboardingSuggestionSurfaces } from '@/stores/onboardingSuggestionSurfacesStore';

jest.mock('@/stores/navigationStore', () => ({
  useNavigationStore: {
    getState: (): { requestHomeComposerText: () => void } => ({
      requestHomeComposerText: (): void => undefined,
    }),
  },
}));
jest.mock('../HomeOnboardingSuggestions', () => ({
  HomeOnboardingSuggestions: (): JSX.Element =>
    createElement('div', { 'data-testid': 'suggestions-stub' }),
}));

const mockLoadPreferences = jest.fn<Promise<Partial<PreferencesData>>, []>();
const mockSavePreferences = jest.fn<
  Promise<void>,
  [Partial<PreferencesData>]
>();

let container: HTMLDivElement;
let root: Root;

function setDevInfo(value: Record<string, unknown>): void {
  Object.defineProperty(window, 'devInfo', { configurable: true, value });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockLoadPreferences.mockResolvedValue({ onboardingCompleted: ['v1'] });
  mockSavePreferences.mockResolvedValue(undefined);
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      loadPreferences: (): Promise<Partial<PreferencesData>> =>
        mockLoadPreferences(),
      savePreferences: (partial: Partial<PreferencesData>): Promise<void> =>
        mockSavePreferences(partial),
      onPreferencesSynced: (): (() => void) => () => undefined,
    },
  });
  setDevInfo({ isDev: false, branch: null });
  useOnboardingSuggestionSurfaces.setState({ visible: false });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => {
    root.unmount();
    await Promise.resolve();
  });
  container.remove();
});

async function render(): Promise<void> {
  await act(async () => {
    root.render(createElement(OnboardingSuggestionsRuntime));
    for (let hop = 0; hop < 5; hop += 1) await Promise.resolve();
  });
  // The module is a lazy chunk; let the mocked import settle.
  await act(async () => {
    for (let hop = 0; hop < 5; hop += 1) await Promise.resolve();
  });
}

function query(testId: string): HTMLElement | null {
  return document.body.querySelector(`[data-testid="${testId}"]`);
}

describe('OnboardingSuggestionsRuntime', () => {
  it('starts the module on an ordinary launch', async () => {
    await render();
    expect(useOnboardingSuggestionSurfaces.getState().visible).toBe(true);
    expect(mockSavePreferences).toHaveBeenCalledTimes(1);
    expect(query('suggestions-stub')).not.toBeNull();
  });

  it('stays inert when the E2E harness hides the module', async () => {
    setDevInfo({ isDev: false, branch: null, hideOnboardingSuggestions: true });
    await render();
    expect(useOnboardingSuggestionSurfaces.getState().visible).toBe(false);
    expect(mockLoadPreferences).not.toHaveBeenCalled();
    expect(mockSavePreferences).not.toHaveBeenCalled();
    expect(query('suggestions-stub')).toBeNull();
  });
});
