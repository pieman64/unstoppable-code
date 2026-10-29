/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  PendingSkillSuggestion,
  ResolveSkillSuggestionRequest,
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

const mockOpenChat = jest.fn<Promise<string>, [unknown]>();
jest.mock('@/stores/standaloneChatStore', () => ({
  useStandaloneChatStore: {
    getState: (): {
      createStandaloneChatWithMessage: (request: unknown) => Promise<string>;
    } => ({
      createStandaloneChatWithMessage: (request: unknown): Promise<string> =>
        mockOpenChat(request),
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

import { SkillSuggestionBannerHost } from '../SkillSuggestionBannerHost';
import { useFeatureFlagsStore } from '@/stores/featureFlagsStore';
import { resetSkillSuggestionStoreForTests } from '@/stores/skillSuggestionStore';

const ORIGIN = { projectId: 'project', worktreeId: 'worktree', chatId: 'chat' };

const PENDING: PendingSkillSuggestion = {
  id: 'pending-1',
  state: 'pending',
  suggestion: {
    id: 'sug-1',
    kind: 'prompt',
    title: 'Summarize review comments',
    occurrenceCount: 4,
    summary: 'Drafts replies.',
    proposedSkillName: 'review-replies',
    proposedDescription: 'Draft replies.',
    parameters: [],
    chainSkills: [],
    examples: [],
    owner: { kind: 'personal' },
    ownerLabel: 'Personal',
    isPrivate: false,
    lastSeenAt: 1,
    state: 'confirmed',
  },
};

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

let container: HTMLDivElement;
let root: Root;
let pending: PendingSkillSuggestion | null;
let changed: ((event: SkillSuggestionChangedEvent) => void) | null;
const resolve = jest.fn<
  Promise<{ success: true; data: boolean }>,
  [ResolveSkillSuggestionRequest]
>();

/** Runs one synchronous UI step, then lets its effects settle. */
async function run(step: () => unknown): Promise<void> {
  await act(async () => {
    step();
    await Promise.resolve();
  });
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function render(
  props: Partial<{ streaming: boolean; visible: boolean }> = {},
): Promise<void> {
  await run(() => {
    root.render(
      <SkillSuggestionBannerHost
        {...ORIGIN}
        streaming={props.streaming ?? false}
        isComposerVisible={(): boolean => props.visible ?? true}
      />,
    );
  });
  await flush();
}

function byTestId(id: string): HTMLButtonElement | null {
  return container.querySelector<HTMLButtonElement>(`[data-testid="${id}"]`);
}

beforeEach(() => {
  resetSkillSuggestionStoreForTests();
  setFlag(true);
  pending = PENDING;
  changed = null;
  resolve.mockReset();
  resolve.mockResolvedValue({ success: true, data: true });
  mockOpenChat.mockReset();
  Object.defineProperty(window, 'skillSuggestions', {
    configurable: true,
    value: {
      getPending: jest.fn(() =>
        Promise.resolve({ success: true, data: pending }),
      ),
      list: jest.fn(() => Promise.resolve({ success: true, data: [] })),
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
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  resetSkillSuggestionStoreForTests();
});

describe('SkillSuggestionBannerHost (CAN-385)', () => {
  it('shows the pending suggestion and reports it shown once', async () => {
    await render();
    expect(byTestId('skill-suggestion-banner')?.textContent).toContain(
      "You've asked for this 4 times",
    );
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolve).toHaveBeenCalledWith({
      source: 'banner',
      ...ORIGIN,
      pendingId: 'pending-1',
      suggestionId: 'sug-1',
      resolution: 'shown',
    });
  });

  it('stays hidden and unreported while streaming', async () => {
    await render({ streaming: true });
    expect(byTestId('skill-suggestion-banner')).toBeNull();
    expect(resolve).not.toHaveBeenCalled();
  });

  it('does not spend a show for a background composer', async () => {
    await render({ visible: false });
    expect(resolve).not.toHaveBeenCalled();
  });

  it('hides at once and reports a dismissal', async () => {
    await render();
    await run(() => byTestId('skill-suggestion-banner-dismiss')?.click());
    await flush();
    expect(byTestId('skill-suggestion-banner')).toBeNull();
    expect(resolve).toHaveBeenLastCalledWith(
      expect.objectContaining({
        resolution: 'dismissed',
        pendingId: 'pending-1',
      }),
    );
  });

  it('does not resend a resolution main rejected', async () => {
    await render();
    jest.useFakeTimers();
    try {
      resolve.mockRejectedValueOnce(new Error('Invalid skill suggestion id'));
      await run(() => byTestId('skill-suggestion-banner-dismiss')?.click());
      await flush();
      await act(async () => {
        jest.advanceTimersByTime(120_000);
        await Promise.resolve();
      });
      const dismissals = resolve.mock.calls.filter(
        ([request]) => request.resolution === 'dismissed',
      );
      expect(dismissals).toHaveLength(1);
      expect(byTestId('skill-suggestion-banner')).toBeNull();
    } finally {
      jest.useRealTimers();
    }
  });

  it('resolves accepted only after the drafting chat opens', async () => {
    let finish: (chatId: string) => void = () => undefined;
    mockOpenChat.mockReturnValue(
      new Promise<string>((done) => {
        finish = done;
      }),
    );
    await render();
    await run(() => byTestId('skill-suggestion-banner-create')?.click());
    expect(byTestId('skill-suggestion-banner-create')?.disabled).toBe(true);
    expect(resolve).not.toHaveBeenCalledWith(
      expect.objectContaining({ resolution: 'accepted' }),
    );
    await run(() => finish('chat-9'));
    await flush();
    expect(resolve).toHaveBeenLastCalledWith(
      expect.objectContaining({ resolution: 'accepted' }),
    );
  });

  it('leaves the suggestion unresolved when the chat cannot open', async () => {
    mockOpenChat.mockRejectedValue(new Error('unavailable'));
    await render();
    await run(() => byTestId('skill-suggestion-banner-create')?.click());
    await flush();
    expect(resolve).not.toHaveBeenCalledWith(
      expect.objectContaining({ resolution: 'accepted' }),
    );
    expect(byTestId('skill-suggestion-banner')).not.toBeNull();
  });

  it('re-reads on an origin-less change and hides on a flag flip', async () => {
    pending = null;
    await render();
    expect(byTestId('skill-suggestion-banner')).toBeNull();
    pending = PENDING;
    await run(() => changed?.({}));
    await flush();
    expect(byTestId('skill-suggestion-banner')).not.toBeNull();
    await run(() => setFlag(false));
    await flush();
    expect(byTestId('skill-suggestion-banner')).toBeNull();
  });
});
