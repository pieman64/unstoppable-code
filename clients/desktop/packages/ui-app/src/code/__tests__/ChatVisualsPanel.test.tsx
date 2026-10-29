/** @jest-environment jsdom */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { CanopyCapabilities } from '@canopy/app-core';
import {
  REPLAY_BLOCK_CLASS,
  REPLAY_MASK_CLASS,
} from '@canopy/ui-shared/lib/replay-privacy';

let capabilities: CanopyCapabilities;
jest.mock('@canopy/app-state', () => ({
  useCapabilities: (): CanopyCapabilities => capabilities,
}));

import {
  CHAT_VISUAL_TEST_IDS,
  useChatVisualHost,
  type ChatVisualHost,
  type ChatVisualOwner,
} from '../chat-visual-host';

const seenHosts: Array<ChatVisualHost | null> = [];
jest.mock('../ChatVisualBlock', () => ({
  ChatVisualBlock: ({
    owner,
    variant,
  }: {
    owner: ChatVisualOwner;
    variant: string;
  }): JSX.Element => {
    seenHosts.push(useChatVisualHost());
    return (
      <div data-testid="block" data-variant={variant}>
        {owner.toolUseId}
      </div>
    );
  },
}));

import { ChatVisualsPanel } from '../ChatVisualsPanel';
import {
  publishChatVisuals,
  requestChatVisualReveal,
  resetChatVisualsSourcesForTests,
} from '../chat-visuals-source';

const baseCapabilities: CanopyCapabilities = {
  localExecution: false,
  terminalPty: false,
  fileSystemAccess: 'read',
  voice: false,
  settingsScope: 'api-keys-only',
  pipelines: 'read-only',
  routing: 'url',
  overviewNotifications: false,
};

function owner(toolUseId: string, title: string): ChatVisualOwner {
  return {
    messageId: `message-${toolUseId}`,
    toolUseId,
    reference: {
      version: 1,
      visualId: 'vis_00000000-0000-4000-8000-000000000001',
      artifactId: `sha256-v1-${'a'.repeat(64)}`,
      sha256: 'a'.repeat(64),
      byteLength: 1,
      mediaType: 'text/html',
      title,
      maxHeight: 400,
    },
  };
}

const host: ChatVisualHost = {
  read: () => Promise.resolve(new Uint8Array()),
  openLink: () => undefined,
  expand: () => true,
};

let container: HTMLDivElement;
let root: Root;
let scrolled: string[];
const originalScrollIntoView = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  'scrollIntoView',
);

beforeEach(() => {
  Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);
  capabilities = { ...baseCapabilities, chatVisuals: true };
  resetChatVisualsSourcesForTests();
  seenHosts.length = 0;
  scrolled = [];
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
    configurable: true,
    value(this: HTMLElement): void {
      scrolled.push(this.getAttribute('data-tool-use-id') ?? '');
    },
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  if (originalScrollIntoView)
    Object.defineProperty(
      HTMLElement.prototype,
      'scrollIntoView',
      originalScrollIntoView,
    );
  else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
});

function items(): HTMLElement[] {
  return Array.from(
    container.querySelectorAll<HTMLElement>(
      `[data-testid="${CHAT_VISUAL_TEST_IDS.panelItem}"]`,
    ),
  );
}

it('points at the chat until one has published its visuals', () => {
  act(() => root.render(<ChatVisualsPanel sourceKey="chat-a" />));
  expect(container.textContent).toBe('Open the chat to see its visuals');
  expect(items()).toEqual([]);
});

it('lists the chat visuals in order, each under its title, as panel entries', () => {
  act(() =>
    publishChatVisuals('chat-a', {
      owners: [owner('one', 'Usage'), owner('two', 'Revenue')],
      host,
    }),
  );
  act(() => root.render(<ChatVisualsPanel sourceKey="chat-a" />));
  expect(items().map((item) => item.querySelector('h3')?.textContent)).toEqual([
    'Usage',
    'Revenue',
  ]);
  expect(
    Array.from(container.querySelectorAll('[data-testid="block"]')).map(
      (block) => [block.textContent, block.getAttribute('data-variant')],
    ),
  ).toEqual([
    ['one', 'panel'],
    ['two', 'panel'],
  ]);
});

// The panel is a recorded surface: the frame is blocked by the recorder, and
// the title is the only other agent text in it.
it('masks each visual title in session replay and keeps the entry recorded', () => {
  act(() =>
    publishChatVisuals('chat-a', {
      owners: [owner('one', 'Usage'), owner('two', 'Revenue')],
      host,
    }),
  );
  act(() => root.render(<ChatVisualsPanel sourceKey="chat-a" />));
  expect(items()).toHaveLength(2);
  for (const item of items()) {
    expect(
      item.querySelector('h3')?.classList.contains(REPLAY_MASK_CLASS),
    ).toBe(true);
    expect(item.closest(`.${REPLAY_BLOCK_CLASS}`)).toBeNull();
  }
});

it('reads through the chat host itself, so nothing is read a second time', () => {
  act(() =>
    publishChatVisuals('chat-a', { owners: [owner('one', 'Usage')], host }),
  );
  act(() => root.render(<ChatVisualsPanel sourceKey="chat-a" />));
  // The document cache authorizes per host object.
  expect(seenHosts.at(-1)).toBe(host);
});

it('scrolls to the requested visual, again on a repeat, and to no other', () => {
  act(() =>
    publishChatVisuals('chat-a', {
      owners: [owner('one', 'Usage'), owner('two', 'Revenue')],
      host,
    }),
  );
  act(() => root.render(<ChatVisualsPanel sourceKey="chat-a" />));
  expect(scrolled).toEqual([]);
  act(() => requestChatVisualReveal('chat-a', 'two'));
  expect(scrolled).toEqual(['two']);
  act(() => requestChatVisualReveal('chat-a', 'two'));
  expect(scrolled).toEqual(['two', 'two']);
  act(() => requestChatVisualReveal('chat-b', 'one'));
  expect(scrolled).toEqual(['two', 'two']);
});

it('scrolls to a visual requested before the panel mounted', () => {
  act(() =>
    publishChatVisuals('chat-a', {
      owners: [owner('one', 'Usage'), owner('two', 'Revenue')],
      host,
    }),
  );
  act(() => requestChatVisualReveal('chat-a', 'two'));
  act(() => root.render(<ChatVisualsPanel sourceKey="chat-a" />));
  expect(scrolled).toEqual(['two']);
});

it('says where visuals come from when the chat has none', () => {
  act(() => publishChatVisuals('chat-a', { owners: [], host }));
  act(() => root.render(<ChatVisualsPanel sourceKey="chat-a" />));
  expect(container.textContent).toBe(
    'Visuals an agent shows in this chat appear here',
  );
});

it('shows no visuals without the capability', () => {
  capabilities = { ...baseCapabilities };
  act(() =>
    publishChatVisuals('chat-a', { owners: [owner('one', 'Usage')], host }),
  );
  act(() => root.render(<ChatVisualsPanel sourceKey="chat-a" />));
  expect(items()).toEqual([]);
});
