/**
 * @jest-environment jsdom
 *
 * The chat surface's publication of a seeded project's template context to
 * the shared checklist runtime (CAN-3032): publish while active, withdraw
 * when inactive or unmounted, never clobber another tab's publication, and
 * stop holding the rows after the bounded wait.
 */
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

import { act, createElement, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  useOnboardingSuggestionSurfaces,
  type OnboardingChatBlueprintContext,
} from '@/stores/onboardingSuggestionSurfacesStore';
import {
  BLUEPRINT_PENDING_TIMEOUT_MS,
  useChatBlueprintPublication,
  type ChatBlueprintPublicationInput,
} from '../useChatBlueprintPublication';

const MARKETING: OnboardingChatBlueprintContext = {
  projectId: 'marketing-1',
  externalId: '11111111-1111-4111-8111-111111111111',
  name: 'Marketing',
  pluginRefs: [],
  starterPrompts: [{ id: 'ws-1', text: 'Draft a launch announcement' }],
  projectSelections: null,
};

let published: Record<string, boolean> = {};
function Publisher(input: ChatBlueprintPublicationInput): JSX.Element {
  published[input.chatTabId] = useChatBlueprintPublication(input);
  return createElement('div');
}

let container: HTMLDivElement;
let root: Root;

function store(): {
  chatBlueprint: OnboardingChatBlueprintContext | null;
  chatBlueprintPending: boolean;
  chatBlueprintOwner: string | null;
} {
  const state = useOnboardingSuggestionSurfaces.getState();
  return {
    chatBlueprint: state.chatBlueprint,
    chatBlueprintPending: state.chatBlueprintPending,
    chatBlueprintOwner: state.chatBlueprintOwner,
  };
}

async function render(
  ...inputs: ChatBlueprintPublicationInput[]
): Promise<void> {
  await act(async () => {
    root.render(
      createElement(
        'div',
        null,
        ...inputs.map((input) =>
          createElement(Publisher, { key: input.chatTabId, ...input }),
        ),
      ),
    );
    await Promise.resolve();
  });
}

beforeEach(() => {
  published = {};
  useOnboardingSuggestionSurfaces.setState({
    chatBlueprint: null,
    chatBlueprintPending: false,
    chatBlueprintOwner: null,
  });
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
  jest.useRealTimers();
});

describe('useChatBlueprintPublication', () => {
  it('publishes while active and withdraws when inactive or unmounted', async () => {
    const input = {
      chatTabId: 'tab-a',
      active: true,
      blueprint: MARKETING,
      pending: false,
    };
    await render(input);
    expect(store()).toEqual({
      chatBlueprint: MARKETING,
      chatBlueprintPending: false,
      chatBlueprintOwner: 'tab-a',
    });
    expect(published['tab-a']).toBe(true);

    await render({ ...input, active: false });
    expect(store()).toEqual({
      chatBlueprint: null,
      chatBlueprintPending: false,
      chatBlueprintOwner: null,
    });
    expect(published['tab-a']).toBe(false);

    await render(input);
    expect(store().chatBlueprintOwner).toBe('tab-a');
    await act(async () => {
      root.render(null);
      await Promise.resolve();
    });
    expect(store().chatBlueprintOwner).toBeNull();
  });

  it('lets a later tab take over and never lets a stale withdrawal clobber it', async () => {
    const a = {
      chatTabId: 'tab-a',
      active: true,
      blueprint: MARKETING,
      pending: false,
    };
    await render(a);
    // Tab B becomes the active empty chat; A goes inactive in the same pass.
    const b = { ...a, chatTabId: 'tab-b', blueprint: null, pending: true };
    await render({ ...a, active: false }, b);
    expect(store()).toEqual({
      chatBlueprint: null,
      chatBlueprintPending: true,
      chatBlueprintOwner: 'tab-b',
    });
    expect(published['tab-a']).toBe(false);
    expect(published['tab-b']).toBe(true);
    // A unmounting afterwards must not take B's publication down.
    await render(b);
    expect(store().chatBlueprintOwner).toBe('tab-b');
  });

  it('arms a fresh bounded wait when the context is republished while still pending', async () => {
    jest.useFakeTimers();
    const input = {
      chatTabId: 'tab-a',
      active: true,
      blueprint: null,
      pending: true,
    };
    await render(input);
    await act(async () => {
      jest.advanceTimersByTime(BLUEPRINT_PENDING_TIMEOUT_MS);
      await Promise.resolve();
    });
    expect(store().chatBlueprintPending).toBe(false);
    // Leaving and re-entering the chat republishes the pending context.
    await render({ ...input, active: false });
    await render(input);
    expect(store().chatBlueprintPending).toBe(true);
    await act(async () => {
      jest.advanceTimersByTime(BLUEPRINT_PENDING_TIMEOUT_MS);
      await Promise.resolve();
    });
    expect(store()).toEqual({
      chatBlueprint: null,
      chatBlueprintPending: false,
      chatBlueprintOwner: 'tab-a',
    });
  });

  it('stops holding the rows after the bounded wait, but not once the read settled', async () => {
    jest.useFakeTimers();
    const input = {
      chatTabId: 'tab-a',
      active: true,
      blueprint: null,
      pending: true,
    };
    await render(input);
    expect(store().chatBlueprintPending).toBe(true);
    await act(async () => {
      jest.advanceTimersByTime(BLUEPRINT_PENDING_TIMEOUT_MS);
      await Promise.resolve();
    });
    expect(store()).toEqual({
      chatBlueprint: null,
      chatBlueprintPending: false,
      chatBlueprintOwner: 'tab-a',
    });

    // Settled in time: the timer is cleared and nothing flips later.
    await render({ ...input, blueprint: MARKETING, pending: false });
    expect(store().chatBlueprint).toBe(MARKETING);
    await act(async () => {
      jest.advanceTimersByTime(BLUEPRINT_PENDING_TIMEOUT_MS * 2);
      await Promise.resolve();
    });
    expect(store()).toEqual({
      chatBlueprint: MARKETING,
      chatBlueprintPending: false,
      chatBlueprintOwner: 'tab-a',
    });
  });
});
