/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  ResolveSkillSuggestionRequest,
  SkillSuggestion,
  SkillSuggestionChangedEvent,
} from '@canopy/desktop-shared/lib/skill-suggestions';
import { CLIENT_FEATURE_FLAGS } from '@canopy/protocol/feature-flags';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

jest.mock('@canopy/app-state', () => ({
  ...jest.requireActual<Record<string, unknown>>('@canopy/app-state'),
  useCapabilities: (): { skillSuggestions: boolean } => ({
    skillSuggestions: true,
  }),
}));
jest.mock('@/stores/standaloneChatStore', () => ({
  useStandaloneChatStore: {
    getState: (): {
      createStandaloneChatWithMessage: () => Promise<string>;
    } => ({
      createStandaloneChatWithMessage: (): Promise<string> =>
        Promise.resolve('chat-9'),
    }),
  },
}));
jest.mock('@/stores/chatStore', () => ({
  useChatStore: {
    getState: (): { saveTabDraft: jest.Mock } => ({ saveTabDraft: jest.fn() }),
  },
}));
jest.mock('@/stores/navigationStore', () => ({
  useNavigationStore: {
    getState: (): { navigate: jest.Mock; closeSettings: jest.Mock } => ({
      navigate: jest.fn(),
      closeSettings: jest.fn(),
    }),
  },
}));
jest.mock('@/stores/githubStore', () => ({
  useGitHubStore: {
    getState: (): { addToast: jest.Mock } => ({ addToast: jest.fn() }),
  },
}));

import { SkillSuggestionsSettingsSection } from '../SkillSuggestionsSettingsSection';
import { SkillSuggestionsModal } from '@/components/skills/SkillSuggestionsModal';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import {
  resetSkillSuggestionStoreForTests,
  useSkillSuggestionStore,
} from '@/stores/skillSuggestionStore';

function setFlag(value: boolean): void {
  const snapshot = useFeatureFlagsStore.getState().snapshot;
  useFeatureFlagsStore.setState({
    snapshot: {
      ...snapshot,
      values: {
        ...snapshot.values,
        [CLIENT_FEATURE_FLAGS.canopyDesktopSkillSuggestions.key]: value,
      },
      status: 'ready',
      initialized: true,
    },
  });
}

function suggestion(
  id: string,
  overrides: Partial<SkillSuggestion> = {},
): SkillSuggestion {
  return {
    id,
    kind: 'prompt',
    title: `Task ${id}`,
    occurrenceCount: 3,
    summary: 'Does the thing.',
    proposedSkillName: `task-${id}`,
    proposedDescription: 'Does the thing.',
    parameters: [],
    chainSkills: [],
    examples: ['raw example request'],
    owner: { kind: 'personal' },
    ownerLabel: 'Personal',
    isPrivate: false,
    lastSeenAt: Date.now(),
    state: 'confirmed',
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;
let listed: SkillSuggestion[];
let changed: ((event: SkillSuggestionChangedEvent) => void) | null;
const resolve = jest.fn<
  Promise<{ success: true; data: boolean }>,
  [ResolveSkillSuggestionRequest]
>();
const savePreferences = jest.fn();

/** Runs one synchronous UI step, then lets its effects settle. */
async function run(step: () => unknown): Promise<void> {
  await act(async () => {
    step();
    await Promise.resolve();
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    for (let i = 0; i < 4; i += 1) await Promise.resolve();
  });
}

async function render(): Promise<void> {
  await run(() => {
    root.render(
      <>
        <SkillSuggestionsSettingsSection />
        <SkillSuggestionsModal />
      </>,
    );
  });
  await flush();
}

function byTestId(id: string): HTMLElement | null {
  return document.body.querySelector<HTMLElement>(`[data-testid="${id}"]`);
}

function all(id: string): HTMLElement[] {
  return Array.from(
    document.body.querySelectorAll<HTMLElement>(`[data-testid="${id}"]`),
  );
}

beforeEach(() => {
  resetSkillSuggestionStoreForTests();
  setFlag(true);
  listed = [
    suggestion('a'),
    suggestion('b', { isPrivate: true, examples: [] }),
  ];
  changed = null;
  resolve.mockReset();
  resolve.mockResolvedValue({ success: true, data: true });
  savePreferences.mockReset();
  savePreferences.mockImplementation(
    (patch: object): Promise<object> =>
      Promise.resolve({ skillSuggestionsEnabled: true, ...patch }),
  );
  Object.defineProperty(window, 'skillSuggestions', {
    configurable: true,
    value: {
      getPending: jest.fn(() => Promise.resolve({ success: true, data: null })),
      list: jest.fn(() => Promise.resolve({ success: true, data: listed })),
      resolve,
      onChanged: (
        callback: (event: SkillSuggestionChangedEvent) => void,
      ): (() => void) => {
        changed = callback;
        return (): void => {
          changed = null;
        };
      },
    },
  });
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: {
      loadPreferences: (): Promise<object> =>
        Promise.resolve({ skillSuggestionsEnabled: true }),
      savePreferences,
      onPreferencesSynced: (): (() => void) => () => undefined,
    },
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  resetSkillSuggestionStoreForTests();
});

describe('Skill suggestions Settings section and modal (CAN-385)', () => {
  it('is hidden while the flag is off', async () => {
    setFlag(false);
    await render();
    expect(byTestId('settings-skill-suggestions')).toBeNull();
  });

  it('saves the preference from the switch', async () => {
    await render();
    await run(() => byTestId('skill-suggestions-settings-toggle')?.click());
    await flush();
    expect(savePreferences).toHaveBeenCalledWith({
      skillSuggestionsEnabled: false,
    });
  });

  it('badges the open count and refreshes it on change', async () => {
    await render();
    expect(byTestId('skill-suggestions-settings-badge')?.textContent).toBe('2');
    listed = [];
    await run(() => changed?.({}));
    await flush();
    expect(byTestId('skill-suggestions-settings-badge')).toBeNull();
  });

  it('opens the modal, hides private examples and dismisses from it', async () => {
    await render();
    await run(() => byTestId('skill-suggestions-settings-view')?.click());
    await flush();
    expect(byTestId('skill-suggestions-modal')).not.toBeNull();
    const rows = all('skill-suggestions-row');
    expect(rows).toHaveLength(2);
    expect(all('skill-suggestions-row-examples-toggle')).toHaveLength(1);

    await run(() =>
      rows[0]
        .querySelector<HTMLElement>(
          '[data-testid="skill-suggestions-row-dismiss"]',
        )
        ?.click(),
    );
    await flush();
    expect(resolve).toHaveBeenCalledWith({
      source: 'suggestions_modal',
      suggestionId: 'a',
      resolution: 'dismissed',
    });
    expect(all('skill-suggestions-row')).toHaveLength(1);
    expect(byTestId('skill-suggestions-settings-badge')?.textContent).toBe('1');
  });

  it('releases a modal decision once main no longer lists it', async () => {
    await render();
    await run(() => byTestId('skill-suggestions-settings-view')?.click());
    await flush();
    await run(() =>
      all('skill-suggestions-row')[0]
        .querySelector<HTMLElement>(
          '[data-testid="skill-suggestions-row-dismiss"]',
        )
        ?.click(),
    );
    await flush();
    expect(Object.keys(useSkillSuggestionStore.getState().resolutions)).toEqual(
      ['modal:a'],
    );
    listed = listed.filter((suggestion) => suggestion.id !== 'a');
    await run(() => changed?.({}));
    await flush();
    expect(useSkillSuggestionStore.getState().resolutions).toEqual({});
  });

  it('accepts from the modal once the chat opens and closes it', async () => {
    await render();
    await run(() => useSkillSuggestionStore.getState().setModalOpen(true));
    await flush();
    await run(() => all('skill-suggestions-row-create')[1]?.click());
    await flush();
    expect(resolve).toHaveBeenCalledWith({
      source: 'suggestions_modal',
      suggestionId: 'b',
      resolution: 'accepted',
    });
    expect(byTestId('skill-suggestions-modal')).toBeNull();
  });

  it('shows the empty state', async () => {
    listed = [];
    await render();
    await run(() => useSkillSuggestionStore.getState().setModalOpen(true));
    await flush();
    expect(byTestId('skill-suggestions-empty')).not.toBeNull();
  });
});
