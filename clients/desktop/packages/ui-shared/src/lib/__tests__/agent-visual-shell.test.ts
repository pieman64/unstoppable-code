/** @jest-environment jsdom */
import {
  AGENT_VISUAL_CSP,
  AGENT_VISUAL_FRAME_ALLOW,
  AGENT_VISUAL_FRAME_SANDBOX,
  AGENT_VISUAL_LOAD_MAX_CHARS,
  AGENT_VISUAL_LOAD_METHOD,
  AGENT_VISUAL_PING_METHOD,
  AGENT_VISUAL_RELAY_SCRIPT,
  AGENT_VISUAL_STATUS_METHOD,
  buildAgentVisualLoadMessage,
  buildAgentVisualShellDocument,
  buildAgentVisualShellHeaders,
  parseAgentVisualFrameMessage,
} from '../agent-visual-html';

type EventHandler = (event: unknown) => void;
type Posted = { data: unknown; targetOrigin: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function methodsOf(messages: Posted[]): unknown[] {
  return messages.map(({ data }) => (isRecord(data) ? data.method : undefined));
}

let nextRunnerId = 0;

/** Run the relay as an inline script, with fakes for the frame's globals. */
function runRelay(window: unknown, document: unknown): void {
  const runnerName = `agentVisualShellRunner${nextRunnerId++}`;
  const element = globalThis.document.createElement('script');
  element.textContent =
    `window[${JSON.stringify(runnerName)}] = function(window, document, ` +
    'setInterval, clearInterval, navigator, setTimeout, clearTimeout, URL){' +
    `${AGENT_VISUAL_RELAY_SCRIPT}\n};`;
  globalThis.document.head.append(element);
  element.remove();
  const runner: unknown = Reflect.get(globalThis, runnerName);
  if (typeof runner !== 'function')
    throw new Error('The relay did not compile');
  Reflect.apply(runner, undefined, [
    window,
    document,
    setInterval,
    clearInterval,
    { userActivation: { isActive: false } },
    setTimeout,
    clearTimeout,
    URL,
  ]);
}

interface FakeFrame {
  attributes: Array<[string, string]>;
  contentWindow: { postMessage(data: unknown, targetOrigin: string): void };
  setAttribute(name: string, value: string): void;
  addEventListener(type: string, listener: EventHandler): void;
}

function createShellHarness(options: { topLevel?: boolean } = {}): {
  parentMessages: Posted[];
  agentMessages: Posted[];
  appended: FakeFrame[];
  /** Attributes each frame carried at the moment it was attached. */
  attachedWith: Array<Array<[string, string]>>;
  colorScheme(): string;
  fromParent(data: unknown): void;
  fromAgent(data: unknown): void;
  from(source: unknown, data: unknown): void;
  listenerCount(): number;
} {
  const parentMessages: Posted[] = [];
  const agentMessages: Posted[] = [];
  const appended: FakeFrame[] = [];
  const attachedWith: Array<Array<[string, string]>> = [];
  const listeners: EventHandler[] = [];
  const parent = {
    postMessage(data: unknown, targetOrigin: string): void {
      parentMessages.push({ data, targetOrigin });
    },
  };
  const agentWindow = {
    postMessage(data: unknown, targetOrigin: string): void {
      agentMessages.push({ data, targetOrigin });
    },
  };
  const style = { colorScheme: '' };
  const window: Record<string, unknown> = {
    addEventListener(type: string, listener: EventHandler): void {
      if (type === 'message') listeners.push(listener);
    },
  };
  window.parent = options.topLevel ? window : parent;
  const document = {
    documentElement: { style },
    querySelector: (): null => null,
    createElement(): FakeFrame {
      const attributes: Array<[string, string]> = [];
      return {
        attributes,
        contentWindow: agentWindow,
        setAttribute(name, value): void {
          attributes.push([name, value]);
        },
        addEventListener(): void {},
      };
    },
    body: {
      appendChild(frame: FakeFrame): void {
        attachedWith.push([...frame.attributes]);
        appended.push(frame);
      },
    },
  };
  runRelay(window, document);
  const from = (source: unknown, data: unknown): void => {
    for (const listener of listeners) listener({ source, data });
  };
  return {
    parentMessages,
    agentMessages,
    appended,
    attachedWith,
    colorScheme: (): string => style.colorScheme,
    fromParent: (data): void => from(parent, data),
    fromAgent: (data): void => from(agentWindow, data),
    from,
    listenerCount: (): number => listeners.length,
  };
}

const AGENT_DOCUMENT = '<!doctype html><p>visual</p>';
const load = (overrides: Record<string, unknown> = {}): unknown => ({
  jsonrpc: '2.0',
  method: AGENT_VISUAL_LOAD_METHOD,
  params: {
    srcdoc: AGENT_DOCUMENT,
    title: 'Revenue by region',
    appearance: 'dark',
    ...overrides,
  },
});

beforeEach(() => jest.useFakeTimers());
afterEach(() => jest.useRealTimers());

describe('the relay in a shell document', () => {
  it('asks its host for the document and holds no frame until one arrives', () => {
    const shell = createShellHarness();
    expect(shell.parentMessages).toEqual([
      {
        data: {
          jsonrpc: '2.0',
          method: AGENT_VISUAL_STATUS_METHOD,
          params: { state: 'awaiting-document' },
        },
        targetOrigin: '*',
      },
    ]);
    expect(shell.appended).toEqual([]);
    // No frame, so no heartbeat yet.
    jest.advanceTimersByTime(60_000);
    expect(shell.agentMessages).toEqual([]);
  });

  it('builds the sandboxed agent frame from the host document, then relays as usual', () => {
    const shell = createShellHarness();
    shell.fromParent(load());
    expect(shell.appended).toHaveLength(1);
    // The sandbox is in place before the document, and both before attaching.
    expect(shell.attachedWith[0]).toEqual([
      ['sandbox', AGENT_VISUAL_FRAME_SANDBOX],
      ['referrerpolicy', 'no-referrer'],
      ['allow', AGENT_VISUAL_FRAME_ALLOW],
      ['title', 'Revenue by region'],
      ['srcdoc', AGENT_DOCUMENT],
    ]);
    expect(shell.colorScheme()).toBe('dark');
    expect(methodsOf(shell.agentMessages)).toEqual([AGENT_VISUAL_PING_METHOD]);
  });

  it('takes one document only', () => {
    const shell = createShellHarness();
    shell.fromParent(load());
    shell.fromParent(load({ srcdoc: '<p>second</p>' }));
    expect(shell.appended).toHaveLength(1);
  });

  it('takes the document from its parent only', () => {
    const shell = createShellHarness();
    shell.from({}, load());
    expect(shell.appended).toEqual([]);
    shell.fromParent(load());
    // The agent it now holds cannot replace itself either.
    shell.fromAgent(load({ srcdoc: '<p>from the agent</p>' }));
    expect(shell.appended).toHaveLength(1);
    expect(shell.attachedWith[0]).toContainEqual(['srcdoc', AGENT_DOCUMENT]);
  });

  it.each<[string, Record<string, unknown>]>([
    ['a document that is not text', { srcdoc: 7 }],
    ['an empty document', { srcdoc: '' }],
    [
      'a document over the size limit',
      { srcdoc: 'x'.repeat(AGENT_VISUAL_LOAD_MAX_CHARS + 1) },
    ],
    ['a title that is not text', { title: null }],
    ['an over-long title', { title: 't'.repeat(513) }],
    ['an unknown appearance', { appearance: 'sepia' }],
  ])('refuses %s', (_name, overrides) => {
    const shell = createShellHarness();
    shell.fromParent(load(overrides));
    expect(shell.appended).toEqual([]);
    // A valid document is still accepted afterwards.
    shell.fromParent(load());
    expect(shell.appended).toHaveLength(1);
  });

  it('does nothing when it was not opened in a frame', () => {
    const shell = createShellHarness({ topLevel: true });
    expect(shell.parentMessages).toEqual([]);
    expect(shell.listenerCount()).toBe(0);
  });
});

describe('the shell document and its response headers', () => {
  it('holds the policy and the relay, and no frame or agent content', () => {
    const shell = buildAgentVisualShellDocument();
    expect(shell.startsWith('<!doctype html>')).toBe(true);
    expect(shell).toContain(
      `<meta http-equiv="Content-Security-Policy" content="${AGENT_VISUAL_CSP}">`,
    );
    expect(shell).toContain(`<script>${AGENT_VISUAL_RELAY_SCRIPT}</script>`);
    expect(shell).not.toContain('<iframe');
    expect(shell).not.toContain('srcdoc=');
    const parsed = new DOMParser().parseFromString(shell, 'text/html');
    expect(parsed.querySelectorAll('script')).toHaveLength(1);
    expect(parsed.querySelector('iframe')).toBeNull();
  });

  it('sandboxes the document wherever it is opened and lets only its own origin frame it', () => {
    const headers = buildAgentVisualShellHeaders();
    expect(headers['Content-Security-Policy']).toBe(
      `${AGENT_VISUAL_CSP}; sandbox ${AGENT_VISUAL_FRAME_SANDBOX}; frame-ancestors 'self'`,
    );
    expect(headers['Content-Type']).toBe('text/html; charset=utf-8');
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
    expect(headers['Referrer-Policy']).toBe('no-referrer');
    expect(headers['Cache-Control']).toBe('no-store');
    expect(headers['Cross-Origin-Resource-Policy']).toBe('same-origin');
  });
});

describe('the shell messages', () => {
  it('reads the request for a document as a frame status', () => {
    expect(
      parseAgentVisualFrameMessage({
        jsonrpc: '2.0',
        method: AGENT_VISUAL_STATUS_METHOD,
        params: { state: 'awaiting-document' },
      }),
    ).toEqual({ kind: 'status', state: 'awaiting-document' });
  });

  it('builds the message that hands the document over', () => {
    expect(
      buildAgentVisualLoadMessage({
        srcdoc: AGENT_DOCUMENT,
        title: 'Revenue by region',
        appearance: 'light',
      }),
    ).toEqual({
      jsonrpc: '2.0',
      method: AGENT_VISUAL_LOAD_METHOD,
      params: {
        srcdoc: AGENT_DOCUMENT,
        title: 'Revenue by region',
        appearance: 'light',
      },
    });
  });
});
