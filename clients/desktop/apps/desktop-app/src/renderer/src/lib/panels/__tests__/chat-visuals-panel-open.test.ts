/** @jest-environment jsdom */
import type { ChatVisualOwner } from '@canopy/ui-app';
import {
  makeAuxPanelLayoutKey,
  makeWorktreePanelKey,
  usePanelLayoutStore,
} from '@/stores/panelLayoutStore';

type MockOpenResult =
  | { status: 'placed' | 'revealed'; location: { layoutKey: string } }
  | { status: 'failed' | 'unavailable' };
const mockOpenContentPanel = jest.fn(
  (): Promise<MockOpenResult> =>
    Promise.resolve({ status: 'placed', location: { layoutKey: 'k' } }),
);
jest.mock('../chat-panel-sync', () => ({
  openContentPanel: (...args: unknown[]): unknown =>
    Reflect.apply(mockOpenContentPanel, undefined, args),
}));
const mockRequestReveal = jest.fn();
jest.mock('@canopy/ui-app', () => ({
  requestChatVisualReveal: (...args: unknown[]): unknown =>
    Reflect.apply(mockRequestReveal, undefined, args),
}));

import { expandDesktopChatVisual } from '../chat-visuals-panel-open';

const KEY = makeWorktreePanelKey('project-1', 'worktree-1');
const scope = {
  projectId: 'project-1',
  worktreeId: 'worktree-1',
  chatId: 'chat-a',
};
const owner: ChatVisualOwner = {
  messageId: 'message-1',
  toolUseId: 'tool-1',
  reference: {
    version: 1,
    visualId: 'vis_00000000-0000-0000-0000-000000000001',
    artifactId: `sha256-v1-${'a'.repeat(64)}`,
    sha256: 'a'.repeat(64),
    byteLength: 1,
    mediaType: 'text/html',
    title: 'Chart',
    maxHeight: 400,
  },
};

beforeEach(() => {
  mockOpenContentPanel.mockClear();
  mockRequestReveal.mockClear();
  usePanelLayoutStore.getState().initializeLayout(KEY, {
    orientation: 'horizontal',
    groups: [
      {
        kind: 'chat',
        groupId: 'group-chat',
        panelId: 'panel-chat-a',
        instance: { chatTabId: 'chat-a' },
      },
    ],
    containerSize: { width: 1200, height: 800 },
  });
});

afterEach(() => {
  usePanelLayoutStore.getState().disposeLayout(KEY);
});

it('opens the panel beside the chat and asks it to show the visual', async () => {
  await expect(expandDesktopChatVisual(scope, owner)).resolves.toBe(true);
  expect(mockOpenContentPanel).toHaveBeenCalledWith(
    KEY,
    {
      kind: 'chat-visuals',
      panelId: `panel-chat-visuals-${KEY}`,
      title: 'Chat visuals',
      instance: { chatId: 'chat-a' },
    },
    { origin: { chatTabId: 'chat-a' } },
  );
  expect(mockRequestReveal).toHaveBeenCalledWith(
    'project-1/worktree-1/chat-a',
    'tool-1',
  );
});

it('declines when the chat has no panel, so the caller shows a dialog', async () => {
  await expect(
    expandDesktopChatVisual({ ...scope, chatId: 'chat-archived' }, owner),
  ).resolves.toBe(false);
  expect(mockOpenContentPanel).not.toHaveBeenCalled();
  expect(mockRequestReveal).not.toHaveBeenCalled();
});

it.each(['failed', 'unavailable'] as const)(
  'declines when the panel is %s to place, so the caller shows a dialog',
  async (status) => {
    mockOpenContentPanel.mockResolvedValueOnce({ status });
    await expect(expandDesktopChatVisual(scope, owner)).resolves.toBe(false);
    expect(mockRequestReveal).not.toHaveBeenCalled();
  },
);

it('opens the panel in the main window for a chat in a popped-out window', async () => {
  // A visual renders only in the main window, so the panel must not follow
  // the chat into the auxiliary layout.
  const auxKey = makeAuxPanelLayoutKey(KEY, 'aux-1');
  usePanelLayoutStore.getState().initializeLayout(auxKey, {
    orientation: 'horizontal',
    groups: [
      {
        kind: 'chat',
        groupId: 'group-aux-chat',
        panelId: 'panel-chat-popped',
        instance: { chatTabId: 'chat-popped' },
      },
    ],
    containerSize: { width: 800, height: 600 },
  });
  try {
    await expect(
      expandDesktopChatVisual({ ...scope, chatId: 'chat-popped' }, owner),
    ).resolves.toBe(true);
    expect(mockOpenContentPanel).toHaveBeenCalledWith(
      KEY,
      expect.objectContaining({
        kind: 'chat-visuals',
        instance: { chatId: 'chat-popped' },
      }),
      {},
    );
  } finally {
    usePanelLayoutStore.getState().disposeLayout(auxKey);
  }
});

it('points an open panel at the expanding chat before revealing it', async () => {
  const store = usePanelLayoutStore.getState();
  store.addTab(KEY, 'group-chat', 'chat', {
    panelId: 'panel-chat-b',
    instance: { chatTabId: 'chat-b' },
  });
  const panelId = store.addTab(KEY, 'group-chat', 'chat-visuals', {
    title: 'Chat visuals',
    instance: { chatId: 'chat-b' },
  });
  expect(panelId).not.toBeNull();

  await expect(expandDesktopChatVisual(scope, owner)).resolves.toBe(true);

  const tab = usePanelLayoutStore
    .getState()
    .layouts[
      KEY
    ].groups['group-chat'].tabs.find((candidate) => candidate.panelId === panelId);
  expect(tab?.instance).toEqual({ chatId: 'chat-a' });
});
