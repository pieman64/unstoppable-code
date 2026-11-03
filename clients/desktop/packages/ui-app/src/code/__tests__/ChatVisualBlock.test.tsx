/** @jest-environment jsdom */
/* eslint-disable no-restricted-imports, @typescript-eslint/require-await, @typescript-eslint/explicit-function-return-type */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { webcrypto, createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';
import type { CanopyCapabilities } from '@canopy/app-core';
import type { ChatVisualHost, ChatVisualOwner } from '../chat-visual-host';
import {
  CHAT_VISUAL_TEST_IDS,
  ChatVisualHostProvider,
} from '../chat-visual-host';
import { ChatVisualBlock } from '../ChatVisualBlock';
import { ChatVisualSourceButton } from '../ChatVisualSourceButton';
import type * as UiSharedComponents from '@canopy/ui-shared/components';

Object.defineProperty(globalThis, 'crypto', {
  configurable: true,
  value: webcrypto,
});
Object.defineProperty(globalThis, 'TextDecoder', {
  configurable: true,
  value: TextDecoder,
});
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});
let capabilities: CanopyCapabilities;
jest.mock('@canopy/app-state', () => ({
  useCapabilities: (): CanopyCapabilities => capabilities,
}));
jest.mock('@canopy/ui-shared/components', () => ({
  Button: jest.requireActual<typeof UiSharedComponents>(
    '@canopy/ui-shared/components',
  ).Button,
  ErrorBanner: jest.requireActual<typeof UiSharedComponents>(
    '@canopy/ui-shared/components',
  ).ErrorBanner,
  SegmentedControl: jest.requireActual<typeof UiSharedComponents>(
    '@canopy/ui-shared/components',
  ).SegmentedControl,
  DialogModal: ({
    children,
    topRightActions,
  }: {
    children: React.ReactNode;
    topRightActions?: React.ReactNode;
  }) => (
    <div data-testid="chat-visual-dialog">
      {topRightActions}
      {children}
    </div>
  ),
  useAgentVisualHostTheme: () => ({ appearance: 'light', variables: {} }),
  AgentVisualFrame: ({
    onExpand,
    onSave,
    prioritized,
    frameUrl,
  }: {
    onExpand?: () => void;
    onSave?: () => void;
    prioritized?: boolean;
    frameUrl?: string;
  }) => (
    <>
      <button
        type="button"
        data-testid="chat-visual-frame"
        data-expandable={onExpand ? 'true' : 'false'}
        data-prioritized={prioritized === true ? 'true' : 'false'}
        data-frame-url={frameUrl}
        onClick={onExpand}
      >
        Frame
      </button>
      {onSave ? (
        <button type="button" data-testid="inline-save" onClick={onSave}>
          Save
        </button>
      ) : null}
    </>
  ),
}));

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
function ownerFor(bytes: Uint8Array): ChatVisualOwner {
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  return {
    messageId: 'message-1',
    toolUseId: 'tool-1',
    reference: {
      version: 1,
      visualId: 'vis_00000000-0000-0000-0000-000000000001',
      artifactId: `sha256-v1-${sha256}`,
      sha256,
      byteLength: bytes.length,
      mediaType: 'text/html',
      title: 'Chart',
      maxHeight: 400,
    },
  };
}
function mount(node: React.ReactNode): {
  container: HTMLDivElement;
  root: Root;
} {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  act(() => root.render(node));
  return { container, root };
}
async function flush(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
}
function click(element: Element | null): void {
  if (!(element instanceof HTMLElement)) throw new Error('Missing button');
  act(() => element.click());
}
afterEach(() => {
  document.body.innerHTML = '';
});
beforeEach(() => {
  capabilities = { ...baseCapabilities, chatVisuals: true };
});

it.each([
  [400, '350px'],
  [900, '180px'],
])(
  'reserves the nearest measured placeholder height at %i px',
  (width, expected) => {
    const original = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      'clientWidth',
    );
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
      configurable: true,
      get: (): number => width,
    });
    try {
      const owner = ownerFor(Buffer.from('<p>chart</p>'));
      owner.reference.heights = [
        [360, 350],
        [520, 300],
        [720, 240],
        [960, 180],
      ];
      const host: ChatVisualHost = {
        read: jest.fn(() => new Promise(() => undefined)),
        openLink: jest.fn(),
      };
      const { container, root } = mount(
        <ChatVisualHostProvider value={host}>
          <ChatVisualBlock owner={owner} variant="inline" />
        </ChatVisualHostProvider>,
      );
      expect(
        container.querySelector<HTMLElement>('[style*="height"]')?.style.height,
      ).toBe(expected);
      act(() => root.unmount());
    } finally {
      if (original)
        Object.defineProperty(HTMLElement.prototype, 'clientWidth', original);
      else Reflect.deleteProperty(HTMLElement.prototype, 'clientWidth');
    }
  },
);

it('renders nothing and never reads without capability or host', () => {
  const bytes = Buffer.from('<p>chart</p>');
  const owner = ownerFor(bytes);
  const read = jest.fn(async () => bytes);
  const host: ChatVisualHost = { read, openLink: jest.fn() };
  capabilities = { ...baseCapabilities, chatVisuals: false };
  const { container, root } = mount(
    <ChatVisualHostProvider value={host}>
      <ChatVisualBlock owner={owner} variant="inline" />
    </ChatVisualHostProvider>,
  );
  expect(container.textContent).toBe('');
  capabilities = { ...baseCapabilities, chatVisuals: true };
  act(() =>
    root.render(
      <ChatVisualHostProvider value={null}>
        <ChatVisualBlock owner={owner} variant="inline" />
      </ChatVisualHostProvider>,
    ),
  );
  expect(container.textContent).toBe('');
  expect(read).not.toHaveBeenCalled();
  act(() => root.unmount());
});

it('rejects a digest mismatch and invalid UTF-8 without mounting the frame', async () => {
  const bytes = Buffer.from('<p>chart</p>');
  const owner = ownerFor(bytes);
  const wrong: ChatVisualHost = {
    read: async () => Buffer.from('<p>other</p>'),
    openLink: jest.fn(),
  };
  const { container, root } = mount(
    <ChatVisualHostProvider value={wrong}>
      <ChatVisualBlock owner={owner} variant="inline" />
    </ChatVisualHostProvider>,
  );
  await flush();
  expect(
    container.querySelector(
      `[data-testid="${CHAT_VISUAL_TEST_IDS.errorState}"]`,
    ),
  ).not.toBeNull();
  expect(
    container.querySelector(`[data-testid="${CHAT_VISUAL_TEST_IDS.frame}"]`),
  ).toBeNull();
  const invalid = Buffer.from([0xff]);
  const invalidHost: ChatVisualHost = {
    read: async () => invalid,
    openLink: jest.fn(),
  };
  act(() =>
    root.render(
      <ChatVisualHostProvider value={invalidHost}>
        <ChatVisualBlock owner={ownerFor(invalid)} variant="inline" />
      </ChatVisualHostProvider>,
    ),
  );
  await flush();
  expect(
    container.querySelector(
      `[data-testid="${CHAT_VISUAL_TEST_IDS.errorState}"]`,
    ),
  ).not.toBeNull();
  expect(
    container.querySelector(`[data-testid="${CHAT_VISUAL_TEST_IDS.frame}"]`),
  ).toBeNull();
  act(() => root.unmount());
});

it('expands, shows source, saves a sandboxed export and reuses the cached document', async () => {
  const bytes = Buffer.from('<h1>Chart</h1>');
  const owner = ownerFor(bytes);
  const read = jest.fn(async () => bytes);
  const host: ChatVisualHost = { read, openLink: jest.fn() };
  const create = jest.fn((blob: Blob) => {
    void blob;
    return 'blob:visual';
  });
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: create,
  });
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    value: jest.fn(),
  });
  const anchorClick = jest
    .spyOn(HTMLAnchorElement.prototype, 'click')
    .mockImplementation(() => undefined);
  const { container, root } = mount(
    <ChatVisualHostProvider value={host}>
      <ChatVisualBlock owner={owner} variant="visual-only" />
    </ChatVisualHostProvider>,
  );
  await flush();
  expect(container.innerHTML).toContain(
    `data-testid="${CHAT_VISUAL_TEST_IDS.frame}"`,
  );
  click(
    container.querySelector(`[data-testid="${CHAT_VISUAL_TEST_IDS.frame}"]`),
  );
  expect(
    container.querySelector(`[data-testid="${CHAT_VISUAL_TEST_IDS.dialog}"]`),
  ).not.toBeNull();
  click(
    Array.from(container.querySelectorAll('button')).find(
      (button) => button.textContent === 'Source',
    ) ?? null,
  );
  expect(
    container.querySelector(
      `[data-testid="${CHAT_VISUAL_TEST_IDS.sourceView}"]`,
    )?.textContent,
  ).toContain('<h1>Chart</h1>');
  click(
    container.querySelector(
      `[data-testid="${CHAT_VISUAL_TEST_IDS.saveButton}"]`,
    ),
  );
  expect(anchorClick).toHaveBeenCalled();
  expect(create).toHaveBeenCalled();
  act(() => root.unmount());
  const remount = mount(
    <ChatVisualHostProvider value={host}>
      <ChatVisualBlock owner={owner} variant="inline" />
    </ChatVisualHostProvider>,
  );
  await flush();
  expect(
    remount.container.querySelector(
      `[data-testid="${CHAT_VISUAL_TEST_IDS.frame}"]`,
    ),
  ).not.toBeNull();
  expect(read).toHaveBeenCalledTimes(1);
  act(() => remount.root.unmount());
  anchorClick.mockRestore();
});

it('keeps the document and an open dialog when the host re-creates an equal owner', async () => {
  // Web hosts parse the reference from the part on every render, so an
  // equal owner arrives as a new object; that must not reload the visual.
  const bytes = Buffer.from('<h1>Equal owner</h1>');
  const read = jest.fn(async () => bytes);
  const host: ChatVisualHost = { read, openLink: jest.fn() };
  const render = () => (
    <ChatVisualHostProvider value={host}>
      <ChatVisualBlock owner={ownerFor(bytes)} variant="inline" />
    </ChatVisualHostProvider>
  );
  const { container, root } = mount(render());
  await flush();
  click(
    container.querySelector(`[data-testid="${CHAT_VISUAL_TEST_IDS.frame}"]`),
  );
  const dialog = () =>
    container.querySelector(`[data-testid="${CHAT_VISUAL_TEST_IDS.dialog}"]`);
  expect(dialog()).not.toBeNull();
  act(() => root.render(render()));
  expect(container.querySelector('[role="status"]')).toBeNull();
  expect(dialog()).not.toBeNull();
  await flush();
  expect(dialog()).not.toBeNull();
  expect(read).toHaveBeenCalledTimes(1);
  act(() => root.unmount());
});

it('source button does not read until opened', async () => {
  const bytes = Buffer.from('<p>source</p>');
  const owner = ownerFor(bytes);
  const read = jest.fn(async () => bytes);
  const host: ChatVisualHost = { read, openLink: jest.fn() };
  const { container, root } = mount(
    <ChatVisualHostProvider value={host}>
      <ChatVisualSourceButton owner={owner} />
    </ChatVisualHostProvider>,
  );
  expect(read).not.toHaveBeenCalled();
  click(
    container.querySelector(
      `[data-testid="${CHAT_VISUAL_TEST_IDS.sourceButton}"]`,
    ),
  );
  await flush();
  expect(container.innerHTML).toContain(
    `data-testid="${CHAT_VISUAL_TEST_IDS.sourceView}"`,
  );
  act(() => root.unmount());
});

it('defers each read until its block nears the viewport, holding its height', async () => {
  type Observed = { element: Element; callback: IntersectionObserverCallback };
  const observed: Observed[] = [];
  Reflect.set(
    window,
    'IntersectionObserver',
    jest.fn((callback: IntersectionObserverCallback) => ({
      observe: (element: Element): void => {
        observed.push({ element, callback });
      },
      unobserve: jest.fn(),
      disconnect: jest.fn(),
    })),
  );
  try {
    const owners = ['a', 'b', 'c'].map((name, index) => {
      const owner = ownerFor(Buffer.from(`<p>${name}</p>`));
      return { ...owner, messageId: `message-${index}` };
    });
    const read = jest.fn(async (owner: ChatVisualOwner) =>
      Buffer.from(
        `<p>${['a', 'b', 'c'][Number(owner.messageId.slice(-1))]}</p>`,
      ),
    );
    const host: ChatVisualHost = { read, openLink: jest.fn() };
    const { container, root } = mount(
      <ChatVisualHostProvider value={host}>
        {owners.map((owner) => (
          <ChatVisualBlock
            key={owner.messageId}
            owner={owner}
            variant="inline"
          />
        ))}
      </ChatVisualHostProvider>,
    );
    await flush();
    // Off-screen blocks read nothing, but keep their place in the transcript.
    expect(read).not.toHaveBeenCalled();
    const blocks = container.querySelectorAll<HTMLElement>(
      `[data-testid="${CHAT_VISUAL_TEST_IDS.block}"]`,
    );
    expect(blocks).toHaveLength(3);
    expect(
      blocks[1]?.querySelector<HTMLElement>('[style*="height"]')?.style.height,
    ).toBe('400px');
    const second = observed.find((entry) => entry.element === blocks[1]);
    if (!second) throw new Error('Block was not observed');
    const target = blocks.item(1);
    const bounds = DOMRect.fromRect({ x: 0, y: 0, width: 0, height: 0 });
    const entry: IntersectionObserverEntry = {
      boundingClientRect: bounds,
      intersectionRatio: 1,
      intersectionRect: bounds,
      isIntersecting: true,
      rootBounds: null,
      target,
      time: 0,
    };
    const observer: IntersectionObserver = {
      root: null,
      rootMargin: '',
      scrollMargin: '',
      thresholds: [],
      disconnect: (): void => {},
      observe: (): void => {},
      takeRecords: (): IntersectionObserverEntry[] => [],
      unobserve: (): void => {},
    };
    act(() => second.callback([entry], observer));
    await flush();
    expect(read).toHaveBeenCalled();
    expect(
      read.mock.calls.every(([owner]) => owner.messageId === 'message-1'),
    ).toBe(true);
    act(() => root.unmount());
  } finally {
    Reflect.deleteProperty(window, 'IntersectionObserver');
  }
});

describe('expanding and saving from the transcript', () => {
  const bytes = Buffer.from('<h1>Chart</h1>');

  async function mountBlock(
    host: ChatVisualHost,
    variant: 'inline' | 'visual-only' | 'panel' = 'inline',
  ): Promise<{ container: HTMLDivElement; owner: ChatVisualOwner }> {
    const owner = ownerFor(bytes);
    const { container } = mount(
      <ChatVisualHostProvider value={host}>
        <ChatVisualBlock owner={owner} variant={variant} />
      </ChatVisualHostProvider>,
    );
    await flush();
    return { container, owner };
  }
  const frame = (container: HTMLElement): HTMLElement | null =>
    container.querySelector(`[data-testid="${CHAT_VISUAL_TEST_IDS.frame}"]`);
  const dialog = (container: HTMLElement): HTMLElement | null =>
    container.querySelector(`[data-testid="${CHAT_VISUAL_TEST_IDS.dialog}"]`);

  it('frames the visual from the document its host serves, when it serves one', async () => {
    const served = await mountBlock({
      read: async () => bytes,
      openLink: jest.fn(),
      frameUrl: '/api/v1/chat-visual-frame',
    });
    expect(frame(served.container)?.getAttribute('data-frame-url')).toBe(
      '/api/v1/chat-visual-frame',
    );
    const inline = await mountBlock({
      read: async () => bytes,
      openLink: jest.fn(),
    });
    expect(frame(inline.container)?.hasAttribute('data-frame-url')).toBe(false);
  });

  it('hands the visual to the host panel and opens no dialog', async () => {
    const expand = jest.fn(() => true);
    const { container, owner } = await mountBlock({
      read: async () => bytes,
      openLink: jest.fn(),
      expand,
    });
    click(frame(container));
    expect(expand).toHaveBeenCalledWith(owner);
    expect(dialog(container)).toBeNull();
    expect(frame(container)?.getAttribute('data-prioritized')).toBe('false');
  });

  it('waits for a host that places its panel later, and opens no dialog', async () => {
    const expand = jest.fn(() => Promise.resolve(true));
    const { container } = await mountBlock({
      read: async () => bytes,
      openLink: jest.fn(),
      expand,
    });
    click(frame(container));
    await flush();
    expect(expand).toHaveBeenCalledTimes(1);
    expect(dialog(container)).toBeNull();
  });

  it.each([
    ['cannot place its panel', (): Promise<boolean> => Promise.resolve(false)],
    [
      'fails to place its panel',
      (): Promise<boolean> => Promise.reject(new Error('no group')),
    ],
  ])('opens the dialog when the host %s after all', async (_label, expand) => {
    const { container } = await mountBlock({
      read: async () => bytes,
      openLink: jest.fn(),
      expand,
    });
    click(frame(container));
    await flush();
    expect(dialog(container)).not.toBeNull();
  });

  it.each([
    ['declines', (): boolean => false],
    ['has no panel', undefined],
  ])('opens the dialog when the host %s', async (_label, expand) => {
    const { container } = await mountBlock({
      read: async () => bytes,
      openLink: jest.fn(),
      ...(expand ? { expand } : {}),
    });
    click(frame(container));
    expect(dialog(container)).not.toBeNull();
  });

  it('saves the visual as a sandboxed HTML file named after its title', async () => {
    const blobs: Blob[] = [];
    Object.defineProperty(URL, 'createObjectURL', {
      configurable: true,
      value: (blob: Blob): string => {
        blobs.push(blob);
        return 'blob:visual';
      },
    });
    Object.defineProperty(URL, 'revokeObjectURL', {
      configurable: true,
      value: jest.fn(),
    });
    const downloads: string[] = [];
    const anchorClick = jest
      .spyOn(HTMLAnchorElement.prototype, 'click')
      .mockImplementation(function (this: HTMLAnchorElement) {
        downloads.push(this.download);
      });
    try {
      const { container } = await mountBlock({
        read: async () => bytes,
        openLink: jest.fn(),
      });
      click(container.querySelector('[data-testid="inline-save"]'));
      expect(downloads).toEqual(['Chart.html']);
      expect(blobs).toHaveLength(1);
      expect(blobs[0]?.type).toBe('text/html;charset=utf-8');
      expect(dialog(container)).toBeNull();
    } finally {
      anchorClick.mockRestore();
    }
  });

  it('gives a panel entry save but nothing to expand to', async () => {
    const expand = jest.fn(() => true);
    const { container } = await mountBlock(
      { read: async () => bytes, openLink: jest.fn(), expand },
      'panel',
    );
    expect(frame(container)?.getAttribute('data-expandable')).toBe('false');
    // The panel is where the user asked to see it, so it gets a frame first.
    expect(frame(container)?.getAttribute('data-prioritized')).toBe('true');
    expect(
      container.querySelector('[data-testid="inline-save"]'),
    ).not.toBeNull();
    click(frame(container));
    expect(expand).not.toHaveBeenCalled();
    expect(dialog(container)).toBeNull();
    expect(
      container
        .querySelector(`[data-testid="${CHAT_VISUAL_TEST_IDS.block}"]`)
        ?.getAttribute('data-variant'),
    ).toBe('panel');
  });
});
