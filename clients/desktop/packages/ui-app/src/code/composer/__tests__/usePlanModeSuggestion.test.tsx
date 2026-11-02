/** @jest-environment jsdom */

import {
  createPlanModeHintStore,
  isPlanModeHintRetired,
  type PlanModeHintStore,
} from '@canopy/app-state';
import { mergePlanModeHintRecords } from '@canopy/protocol/onboarding';
import type { PlanModeHintRecord } from '@canopy/protocol/onboarding';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  usePlanModeSuggestion,
  type PlanModeSuggestion,
  type UsePlanModeSuggestionOptions,
} from '../usePlanModeSuggestion';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const QUALIFYING = [
  'Please do the following:',
  '- add the migration for the new column',
  '- update the API handler to read the column',
  '- write tests for the handler and the migration',
  'Keep the changes small and make sure the existing tests keep passing.',
].join('\n');
const SHORT = 'Fix the typo in the header.';

function makeStore(
  initial: PlanModeHintRecord = { version: 1, generation: 0 },
): { store: PlanModeHintStore; saved: () => PlanModeHintRecord } {
  let stored = initial;
  const store = createPlanModeHintStore({
    load: () => Promise.resolve({ record: stored, persisted: true }),
    save: (record): Promise<PlanModeHintRecord> => {
      stored = mergePlanModeHintRecords(stored, record);
      return Promise.resolve(stored);
    },
  });
  return { store, saved: () => stored };
}

describe('usePlanModeSuggestion', () => {
  let container: HTMLDivElement;
  let root: Root;
  let result: PlanModeSuggestion;
  let store: PlanModeHintStore;
  let saved: () => PlanModeHintRecord;
  let options: UsePlanModeSuggestionOptions;

  function Probe(props: UsePlanModeSuggestionOptions): null {
    result = usePlanModeSuggestion(props);
    return null;
  }

  function render(patch: Partial<UsePlanModeSuggestionOptions> = {}): void {
    options = { ...options, ...patch };
    act(() => root.render(<Probe {...options} />));
  }

  function advance(ms: number): void {
    act(() => {
      jest.advanceTimersByTime(ms);
    });
  }

  async function flush(): Promise<void> {
    await act(async () => {
      await Promise.resolve();
    });
  }

  beforeEach(async () => {
    jest.useFakeTimers();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    ({ store, saved } = makeStore());
    await store.getState().hydrate();
    options = {
      text: '',
      draftKey: 'home',
      planMode: false,
      planAvailable: true,
      planReadOnly: false,
      pipelineMode: false,
      active: true,
      composing: false,
      store,
      onEnablePlanMode: jest.fn(() => true),
      onShown: jest.fn(),
      onAccepted: jest.fn(),
      onDismissed: jest.fn(),
      focusComposer: jest.fn(),
    };
    render();
  });

  afterEach(() => {
    act(() => root.unmount());
    document.body.replaceChildren();
    jest.useRealTimers();
  });

  it('shows a qualifying draft after 600 ms without changes, once', async () => {
    render({ text: QUALIFYING });
    advance(599);
    expect(result.visible).toBe(false);
    advance(1);
    expect(result.visible).toBe(true);
    expect(options.onShown).toHaveBeenCalledTimes(1);
    await flush();
    expect(saved().shownAt).toBeDefined();

    render({ text: `${QUALIFYING} More detail.` });
    advance(600);
    expect(result.visible).toBe(true);
    expect(options.onShown).toHaveBeenCalledTimes(1);
  });

  it('restarts the debounce on rapid edits', () => {
    render({ text: QUALIFYING });
    advance(500);
    render({ text: `${QUALIFYING} a` });
    advance(500);
    expect(result.visible).toBe(false);
    advance(100);
    expect(result.visible).toBe(true);
  });

  it('does not show short drafts', () => {
    render({ text: SHORT });
    advance(1_000);
    expect(result.visible).toBe(false);
  });

  it('does not evaluate during IME composition', () => {
    render({ text: QUALIFYING, composing: true });
    advance(1_000);
    expect(result.visible).toBe(false);
    render({ composing: false });
    advance(600);
    expect(result.visible).toBe(true);
  });

  it('cancels pending evaluation on unmount', () => {
    render({ text: QUALIFYING });
    act(() => root.unmount());
    root = createRoot(container);
    advance(1_000);
    expect(options.onShown).not.toHaveBeenCalled();
  });

  it('hides immediately on ineligible text and does not reappear in the session', () => {
    render({ text: QUALIFYING });
    advance(600);
    render({ text: SHORT });
    expect(result.visible).toBe(false);
    render({ text: QUALIFYING });
    advance(1_000);
    expect(result.visible).toBe(false);
  });

  it('shows again for a later draft after being ignored', () => {
    render({ text: QUALIFYING });
    advance(600);
    render({ text: '' });
    expect(result.visible).toBe(false);
    render({ text: QUALIFYING });
    advance(600);
    expect(result.visible).toBe(true);
    expect(options.onShown).toHaveBeenCalledTimes(2);
  });

  it('starts a new session when the draft is replaced', () => {
    render({ text: QUALIFYING });
    advance(600);
    render({ draftKey: 'chat-2' });
    expect(result.visible).toBe(false);
    advance(600);
    expect(result.visible).toBe(true);
  });

  it.each([
    ['plan mode is on', { planMode: true }],
    ['Plan is unavailable', { planAvailable: false }],
    ['Plan is read only', { planReadOnly: true }],
    ['pipeline or terminal mode', { pipelineMode: true }],
    ['the composer is inactive', { active: false }],
    ['no store is available', { store: null }],
  ] satisfies Array<[string, Partial<UsePlanModeSuggestionOptions>]>)(
    'hides while %s',
    (_name, gate) => {
      render({ ...gate, text: QUALIFYING });
      advance(1_000);
      expect(result.visible).toBe(false);
    },
  );

  it('hides while hydration is unresolved or failed', async () => {
    const failed = createPlanModeHintStore({
      load: () => Promise.reject(new Error('corrupt')),
      save: (record) => Promise.resolve(record),
    });
    render({ store: failed, text: QUALIFYING });
    advance(1_000);
    expect(result.visible).toBe(false);
    await act(async () => {
      await failed.getState().hydrate();
    });
    advance(1_000);
    expect(result.visible).toBe(false);
  });

  it('hides immediately when a gate closes after showing', () => {
    render({ text: QUALIFYING });
    advance(600);
    render({ active: false });
    expect(result.visible).toBe(false);
    render({ active: true });
    advance(1_000);
    expect(result.visible).toBe(false);
  });

  it('hides when another composer retires the lesson', async () => {
    render({ text: QUALIFYING });
    advance(600);
    await act(async () => {
      await store.getState().markTried();
    });
    expect(result.visible).toBe(false);
  });

  it('accepts by enabling plan mode, then retires and restores focus', async () => {
    render({ text: QUALIFYING });
    advance(600);
    await act(async () => {
      await result.accept();
    });
    expect(options.onEnablePlanMode).toHaveBeenCalledTimes(1);
    expect(result.visible).toBe(false);
    expect(options.onAccepted).toHaveBeenCalledTimes(1);
    expect(options.focusComposer).toHaveBeenCalledTimes(1);
    expect(isPlanModeHintRetired(store.getState())).toBe(true);
    await flush();
    expect(saved().triedAt).toBeDefined();
  });

  it('keeps the suggestion and does not retire when enabling fails', async () => {
    render({
      text: QUALIFYING,
      onEnablePlanMode: jest.fn(() => Promise.reject(new Error('nope'))),
    });
    advance(600);
    await act(async () => {
      await result.accept();
    });
    expect(result.visible).toBe(true);
    expect(result.pending).toBe(false);
    expect(options.onAccepted).not.toHaveBeenCalled();
    expect(isPlanModeHintRetired(store.getState())).toBe(false);

    render({ onEnablePlanMode: jest.fn(() => false) });
    await act(async () => {
      await result.accept();
    });
    expect(isPlanModeHintRetired(store.getState())).toBe(false);
  });

  it('disables a second activation while pending', async () => {
    let resolve!: (enabled: boolean) => void;
    const enable = jest.fn(
      () => new Promise<boolean>((done) => (resolve = done)),
    );
    render({ text: QUALIFYING, onEnablePlanMode: enable });
    advance(600);
    let first!: Promise<void>;
    act(() => {
      first = result.accept();
    });
    expect(result.pending).toBe(true);
    await act(async () => {
      await result.accept();
    });
    expect(enable).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolve(true);
      await first;
    });
    expect(isPlanModeHintRetired(store.getState())).toBe(true);
  });

  it('does not retire for a stale target', async () => {
    let resolve!: (enabled: boolean) => void;
    render({
      text: QUALIFYING,
      onEnablePlanMode: () => new Promise<boolean>((done) => (resolve = done)),
    });
    advance(600);
    let accepted!: Promise<void>;
    act(() => {
      accepted = result.accept();
    });
    render({ draftKey: 'other' });
    await act(async () => {
      resolve(true);
      await accepted;
    });
    expect(isPlanModeHintRetired(store.getState())).toBe(false);
    expect(options.onAccepted).not.toHaveBeenCalled();
  });

  it('dismisses durably and restores focus', async () => {
    render({ text: QUALIFYING });
    advance(600);
    act(() => result.dismiss());
    expect(result.visible).toBe(false);
    expect(options.onDismissed).toHaveBeenCalledTimes(1);
    expect(options.focusComposer).toHaveBeenCalledTimes(1);
    await flush();
    expect(saved().dismissedAt).toBeDefined();

    render({ draftKey: 'next' });
    advance(1_000);
    expect(result.visible).toBe(false);
  });
  it('blocks duplicate activation in the same event turn', async () => {
    let resolve!: (enabled: boolean) => void;
    const enable = jest.fn(
      () =>
        new Promise<boolean>((done) => {
          resolve = done;
        }),
    );
    render({ text: QUALIFYING, onEnablePlanMode: enable });
    advance(600);
    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => {
      first = result.accept();
      second = result.accept();
    });
    expect(enable).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolve(true);
      await Promise.all([first, second]);
    });
  });

  it('does not retire the old account after a store switch during activation', async () => {
    let resolve!: (enabled: boolean) => void;
    render({
      text: QUALIFYING,
      onEnablePlanMode: () =>
        new Promise<boolean>((done) => {
          resolve = done;
        }),
    });
    advance(600);
    let accepted!: Promise<void>;
    act(() => {
      accepted = result.accept();
    });
    const other = makeStore().store;
    await other.getState().hydrate();
    render({ store: other });
    await act(async () => {
      resolve(true);
      await accepted;
    });
    expect(isPlanModeHintRetired(store.getState())).toBe(false);
    expect(isPlanModeHintRetired(other.getState())).toBe(false);
  });

  it('does not retire after the provider capability closes during activation', async () => {
    let resolve!: (enabled: boolean) => void;
    render({
      text: QUALIFYING,
      onEnablePlanMode: () =>
        new Promise<boolean>((done) => {
          resolve = done;
        }),
    });
    advance(600);
    let accepted!: Promise<void>;
    act(() => {
      accepted = result.accept();
    });
    render({ planReadOnly: true });
    await act(async () => {
      resolve(true);
      await accepted;
    });
    expect(isPlanModeHintRetired(store.getState())).toBe(false);
  });

  it('hides an existing hint during IME composition', () => {
    render({ text: QUALIFYING });
    advance(600);
    render({ composing: true });
    expect(result.visible).toBe(false);
  });
  it('does not retire a replacement draft after clear while activation was pending', async () => {
    let resolve!: (enabled: boolean) => void;
    render({
      text: QUALIFYING,
      onEnablePlanMode: () =>
        new Promise<boolean>((done) => {
          resolve = done;
        }),
    });
    advance(600);
    let accepted!: Promise<void>;
    act(() => {
      accepted = result.accept();
    });
    render({ text: '' });
    render({ text: QUALIFYING });
    await act(async () => {
      resolve(true);
      await accepted;
    });
    expect(isPlanModeHintRetired(store.getState())).toBe(false);
  });
  it('evaluates a different draft even when the previous hint was already hidden', () => {
    render({ text: QUALIFYING });
    advance(600);
    render({ text: SHORT });
    render({ text: QUALIFYING, draftKey: 'next-target' });
    advance(600);
    expect(result.visible).toBe(true);
  });

  it('does not retire after switching between supported providers during activation', async () => {
    let resolve!: (enabled: boolean) => void;
    render({
      text: QUALIFYING,
      activationKey: 'claude',
      onEnablePlanMode: () =>
        new Promise<boolean>((done) => {
          resolve = done;
        }),
    });
    advance(600);
    let accepted!: Promise<void>;
    act(() => {
      accepted = result.accept();
    });
    render({ activationKey: 'codex' });
    await act(async () => {
      resolve(true);
      await accepted;
    });
    expect(isPlanModeHintRetired(store.getState())).toBe(false);
    expect(result.pending).toBe(false);
  });
  it('keeps the hint when an optimistic Plan activation is rolled back', async () => {
    let resolve!: (enabled: boolean) => void;
    render({
      text: QUALIFYING,
      onEnablePlanMode: () =>
        new Promise<boolean>((done) => {
          resolve = done;
        }),
    });
    advance(600);
    let accepted!: Promise<void>;
    act(() => {
      accepted = result.accept();
    });
    render({ planMode: true });
    render({ planMode: false });
    await act(async () => {
      resolve(false);
      await accepted;
    });
    expect(result.visible).toBe(true);
    expect(isPlanModeHintRetired(store.getState())).toBe(false);
  });

  it('does not retire a reset lesson for an activation from the previous generation', async () => {
    let resolve!: (enabled: boolean) => void;
    render({
      text: QUALIFYING,
      onEnablePlanMode: () =>
        new Promise<boolean>((done) => {
          resolve = done;
        }),
    });
    advance(600);
    let accepted!: Promise<void>;
    act(() => {
      accepted = result.accept();
    });
    await act(async () => {
      await store.getState().reset();
    });
    await act(async () => {
      resolve(true);
      await accepted;
    });
    expect(isPlanModeHintRetired(store.getState())).toBe(false);
  });
});
