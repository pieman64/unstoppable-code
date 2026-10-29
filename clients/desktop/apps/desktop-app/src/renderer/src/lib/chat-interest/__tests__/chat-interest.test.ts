/** @jest-environment jsdom */

/**
 * Chat interest against the REAL navigation, chat, standalone, panel layout
 * and panel window stores: what the main window declares through
 * `window.api.chat.setInterest` as panels split, collapse and maximize, as
 * the selection and page change, and as a pulled-out window opens and
 * closes. Animation frames run on Jest's fake timers.
 */
import type {
  ChatInterestChatRef,
  ChatInterestDeclaration,
} from '@canopy/desktop-shared/types';
import { STANDALONE_CHAT_PROJECT_ID } from '@canopy/desktop-shared/types';
import { useChatStore } from '@/stores/chatStore';
import { useNavigationStore } from '@/stores/navigationStore';
import {
  makeAuxPanelLayoutKey,
  usePanelLayoutStore,
  type DefaultLayoutDescriptor,
} from '@/stores/panelLayoutStore';
import {
  usePanelWindowsStore,
  type PanelAuxWindowRecord,
} from '@/stores/panelWindowsStore';
import { useStandaloneChatStore } from '@/stores/standaloneChatStore';
import {
  getChatInterest,
  requestChatInterestRedeclare,
  startChatInterestTracking,
  subscribeChatInterest,
} from '..';

const KEY = 'proj/wt';
const OTHER_KEY = 'proj/other';
const ENTRY_KEY = `${STANDALONE_CHAT_PROJECT_ID}/entry-1`;

const setInterest = jest.fn<Promise<void>, [ChatInterestDeclaration]>();
let stopTracking: (() => void) | null = null;

function splitLayout(left: string, right: string): DefaultLayoutDescriptor {
  return {
    orientation: 'horizontal',
    groups: [
      {
        kind: 'chat',
        groupId: 'group-left',
        panelId: `panel-chat-${left}`,
        instance: { chatTabId: left },
      },
      {
        kind: 'chat',
        groupId: 'group-right',
        panelId: `panel-chat-${right}`,
        instance: { chatTabId: right },
      },
    ],
    containerSize: { width: 1200, height: 800 },
  };
}

function singleLayout(chatId: string): DefaultLayoutDescriptor {
  return {
    orientation: 'horizontal',
    groups: [
      {
        kind: 'chat',
        groupId: `group-${chatId}`,
        panelId: `panel-chat-${chatId}`,
        instance: { chatTabId: chatId },
      },
    ],
    containerSize: { width: 800, height: 600 },
  };
}

function auxRecord(auxWindowId: string): PanelAuxWindowRecord {
  return {
    auxWindowId,
    worktreeKey: KEY,
    layoutKey: makeAuxPanelLayoutKey(KEY, auxWindowId),
    sourceGroupId: 'group-left',
    childWindow: window,
    status: 'open',
    focusOnOpen: false,
  };
}

function declared(): { focused: string[]; warm: string[] } {
  const declaration = setInterest.mock.calls.at(-1)?.[0];
  const key = (ref: ChatInterestChatRef): string =>
    `${ref.projectId}/${ref.worktreeId}/${ref.chatId}`;
  return {
    focused: (declaration?.focused ?? []).map(key),
    warm: (declaration?.warm ?? []).map(key),
  };
}

function nextFrame(): void {
  jest.advanceTimersToNextFrame();
}

beforeEach(() => {
  jest.useFakeTimers();
  setInterest.mockReset();
  setInterest.mockResolvedValue(undefined);
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { chat: { setInterest } },
  });
  usePanelLayoutStore.setState({ layouts: {} });
  usePanelWindowsStore.setState({ auxWindows: {} });
  useNavigationStore.setState({ activePage: 'main', settingsOpen: false });
  useChatStore.setState({
    selectedWorktree: { projectId: 'proj', worktreeId: 'wt' },
  });
  useStandaloneChatStore.setState({
    activeChatProjectId: STANDALONE_CHAT_PROJECT_ID,
    activeWorkEntryId: null,
  });
  usePanelLayoutStore.getState().initializeLayout(KEY, splitLayout('a', 'b'));
  usePanelLayoutStore.getState().initializeLayout(OTHER_KEY, singleLayout('c'));
});

afterEach(() => {
  stopTracking?.();
  stopTracking = null;
  jest.useRealTimers();
});

function start(): void {
  stopTracking = startChatInterestTracking('main');
}

test('declares the split on page load, on the next frame', () => {
  start();
  expect(setInterest).not.toHaveBeenCalled();
  nextFrame();
  expect(setInterest).toHaveBeenCalledTimes(1);
  expect(declared()).toEqual({ focused: ['proj/wt/a', 'proj/wt/b'], warm: [] });
});

test('honors collapsed and maximized groups', () => {
  start();
  nextFrame();
  usePanelLayoutStore.getState().collapseGroup(KEY, 'group-right');
  nextFrame();
  expect(declared()).toEqual({ focused: ['proj/wt/a'], warm: ['proj/wt/b'] });

  usePanelLayoutStore.getState().expandGroup(KEY, 'group-right');
  usePanelLayoutStore.getState().maximizeGroup(KEY, 'group-right', true);
  nextFrame();
  expect(declared()).toEqual({ focused: ['proj/wt/b'], warm: ['proj/wt/a'] });
});

test('follows worktree and page switches, keeping earlier chats warm', () => {
  start();
  nextFrame();
  useChatStore.setState({
    selectedWorktree: { projectId: 'proj', worktreeId: 'other' },
  });
  nextFrame();
  expect(declared()).toEqual({
    focused: ['proj/other/c'],
    warm: ['proj/wt/a', 'proj/wt/b'],
  });

  useNavigationStore.setState({ activePage: 'overview' });
  nextFrame();
  expect(declared()).toEqual({
    focused: [],
    warm: ['proj/other/c', 'proj/wt/a', 'proj/wt/b'],
  });

  useNavigationStore.setState({ activePage: 'main', settingsOpen: true });
  nextFrame();
  expect(declared().focused).toEqual([]);
});

test('declares the Cowork entry on the Cowork page', () => {
  usePanelLayoutStore.getState().initializeLayout(ENTRY_KEY, singleLayout('w'));
  start();
  nextFrame();
  useNavigationStore.setState({ activePage: 'chat' });
  useStandaloneChatStore.setState({ activeWorkEntryId: 'entry-1' });
  nextFrame();
  expect(declared().focused).toEqual([`${ENTRY_KEY}/w`]);
});

test('keeps a pulled-out chat focused anywhere, and warm once closed', () => {
  usePanelLayoutStore
    .getState()
    .initializeLayout(makeAuxPanelLayoutKey(KEY, 'w1'), singleLayout('x'));
  start();
  nextFrame();
  usePanelWindowsStore.setState({ auxWindows: { w1: auxRecord('w1') } });
  nextFrame();
  expect(declared().focused).toEqual(['proj/wt/a', 'proj/wt/b', 'proj/wt/x']);

  useChatStore.setState({
    selectedWorktree: { projectId: 'proj', worktreeId: 'other' },
  });
  useNavigationStore.setState({ activePage: 'overview' });
  nextFrame();
  expect(declared().focused).toEqual(['proj/wt/x']);

  usePanelWindowsStore.setState({ auxWindows: {} });
  nextFrame();
  expect(declared()).toEqual({
    focused: [],
    warm: ['proj/wt/x', 'proj/wt/a', 'proj/wt/b'],
  });
});

test('coalesces changes into one call per frame and skips unchanged', () => {
  start();
  nextFrame();
  expect(setInterest).toHaveBeenCalledTimes(1);

  usePanelLayoutStore.getState().collapseGroup(KEY, 'group-right');
  usePanelLayoutStore.getState().expandGroup(KEY, 'group-right');
  useNavigationStore.setState({ activePage: 'overview' });
  useNavigationStore.setState({ activePage: 'main' });
  nextFrame();
  expect(setInterest).toHaveBeenCalledTimes(1);

  useNavigationStore.setState({ activePage: 'overview' });
  useNavigationStore.setState({ activePage: 'kanban' });
  useChatStore.setState({
    selectedWorktree: { projectId: 'proj', worktreeId: 'other' },
  });
  nextFrame();
  expect(setInterest).toHaveBeenCalledTimes(2);
});

test('re-declares an unchanged interest after a scope hydration', () => {
  start();
  nextFrame();
  requestChatInterestRedeclare();
  requestChatInterestRedeclare();
  nextFrame();
  expect(setInterest).toHaveBeenCalledTimes(2);
  expect(setInterest.mock.calls[1]?.[0]).toEqual(
    setInterest.mock.calls[0]?.[0],
  );
});

test('logs a failed declaration once without retrying', async () => {
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  setInterest.mockRejectedValueOnce(new Error('rejected'));
  start();
  nextFrame();
  await Promise.resolve();
  await Promise.resolve();
  expect(warn).toHaveBeenCalledTimes(1);
  jest.advanceTimersByTime(1000);
  expect(setInterest).toHaveBeenCalledTimes(1);
  warn.mockRestore();
});

test('exposes the current interest and its changes', () => {
  const listener = jest.fn();
  const unsubscribe = subscribeChatInterest(listener);
  expect(getChatInterest()).toBeNull();
  start();
  expect(getChatInterest()?.focused.map((ref) => ref.chatId)).toEqual([
    'a',
    'b',
  ]);
  expect(listener).toHaveBeenCalledTimes(1);
  unsubscribe();
});

test('declares nothing when the preload has no setInterest', () => {
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { chat: {} },
  });
  start();
  nextFrame();
  expect(setInterest).not.toHaveBeenCalled();
});
