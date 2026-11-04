/** @jest-environment jsdom */
// CAN-3119 (F2): the MCP server dialog shows header values, environment
// variables, and auth tokens. `DialogModal` records its card, so
// `KeyValueEditor` blocks its own root and `ConfigEditor` blocks its auth
// token field. This pins that each secret field renders in a blocked region of
// the recorded card.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  McpServerDataView,
  McpServerFileView,
  McpServersIndexFile,
} from '@canopy/desktop-shared/types/mcp-servers';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { McpServerDialog } from '../McpServersTab';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

jest.mock('@/hooks/useCurrentUiStateReporter', (): object => ({
  useCurrentUiStateReporter: jest.fn(),
}));
// Account connections off: the dialog stays a plain device server editor.
jest.mock('@/stores/featureFlagsStore', (): object => ({
  useFeatureFlagsStore: Object.assign((): boolean => false, {
    getState: (): { isEnabled: () => boolean } => ({
      isEnabled: (): boolean => false,
    }),
  }),
}));
jest.mock('../../../hooks/useCuratedMcpServers', (): object => ({
  useCuratedMcpServers: (): object => ({ entries: [] }),
}));

const HEADER_VALUE = 'Bearer header-secret-value';
const ENV_VALUE = 'env-secret-value';
const CONFIG_HEADER_VALUE = 'config-header-secret';
const AUTH_TOKEN = 'config-auth-token';

const server: McpServerDataView = {
  definition: {
    id: 'server',
    name: 'Private server',
    description: '',
    type: 'http',
    url: 'https://mcp.example.test',
    headers: { Authorization: HEADER_VALUE },
    createdAt: '',
    updatedAt: '',
  },
  configs: [
    {
      id: 'default',
      name: 'Default',
      description: '',
      enabled: true,
      envVars: { API_KEY: ENV_VALUE },
      extraArgs: [],
      extraHeaders: { 'X-Api-Key': CONFIG_HEADER_VALUE },
      authToken: AUTH_TOKEN,
      createdAt: '',
      updatedAt: '',
    },
  ],
};

/**
 * Asserts `content` sits in a recorded `DialogModal` card with no replay
 * block around it, and returns the card. Only `DialogModal`'s overlay carries
 * `data-canopy-overlay-root="modal"`, which pins the card to that component.
 * Session replay masks every input value itself, so secret values in these
 * editors need no block of their own.
 */
function expectRecordedInDialogCard(content: Element): HTMLElement {
  const card = content.closest<HTMLElement>('[role="dialog"]');
  if (card === null) throw new Error('Content is not inside a dialog card');
  expect(card.getAttribute('aria-modal')).toBe('true');
  expect(card.parentElement?.getAttribute('data-canopy-overlay-root')).toBe(
    'modal',
  );
  // `closest` is inclusive: the content and its ancestors carry no block.
  expect(content.tagName).toBe('INPUT');
  expect(content.closest(`.${POSTHOG_REPLAY_BLOCK_CLASS}`)).toBeNull();
  expect(card.querySelector(`.${POSTHOG_REPLAY_BLOCK_CLASS}`)).toBeNull();
  return card;
}

/** The single input in the document whose current value is `value`. */
function inputWithValue(value: string): HTMLInputElement {
  const matches = Array.from(
    document.querySelectorAll<HTMLInputElement>('input'),
  ).filter((input) => input.value === value);
  if (matches.length !== 1) {
    throw new Error(`Expected one input with value "${value}"`);
  }
  return matches[0];
}

async function update(action: () => void): Promise<void> {
  await act(async (): Promise<void> => {
    action();
    await Promise.resolve();
  });
}

describe('McpServerDialog session replay', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach((): void => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        loadPreferences: jest.fn().mockResolvedValue({}),
        loadCanopyCloudAccount: jest.fn().mockResolvedValue({}),
      },
    });
    const index: McpServersIndexFile = {
      version: 1,
      servers: [{ ...server.definition, configs: server.configs }],
    };
    const file: McpServerFileView = { version: 1, server };
    Object.defineProperty(window, 'mcpServers', {
      configurable: true,
      value: {
        loadServer: jest.fn().mockResolvedValue(file),
        loadIndex: jest.fn().mockResolvedValue(index),
        listAccountConnections: jest.fn().mockResolvedValue([]),
        onOAuthTokensChanged: (): (() => void) => (): void => undefined,
      },
    });
  });

  afterEach(async (): Promise<void> => {
    await update((): void => root.unmount());
    container.remove();
  });

  it('records header, env, and auth token inputs inside the DialogModal card (the recorder masks their values)', async (): Promise<void> => {
    await update((): void =>
      root.render(
        <McpServerDialog
          serverId="server"
          onClose={(): void => undefined}
          onSaved={(): Promise<void> => Promise.resolve()}
        />,
      ),
    );
    await update((): void => undefined);

    // Server-level `KeyValueEditor` (Headers).
    const headerValue = inputWithValue(HEADER_VALUE);
    expect(container.contains(headerValue)).toBe(false);
    const card = expectRecordedInDialogCard(headerValue);
    expect(card.getAttribute('aria-labelledby')).toBe(
      'mcp-server-dialog-title',
    );

    // `ConfigEditor` with its nested `KeyValueEditor`s.
    const expand = card.querySelector<HTMLButtonElement>(
      '[aria-label="Expand config"]',
    );
    if (expand === null) throw new Error('Config expand control not found');
    await update((): void => expand.click());

    for (const value of [ENV_VALUE, CONFIG_HEADER_VALUE, AUTH_TOKEN]) {
      expect(expectRecordedInDialogCard(inputWithValue(value))).toBe(card);
    }
  });
});
