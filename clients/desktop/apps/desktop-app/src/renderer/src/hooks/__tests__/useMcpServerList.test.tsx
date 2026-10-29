/**
 * @jest-environment jsdom
 */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  McpServerIndexEntry,
  McpServersIndexFile,
} from '@canopy/desktop-shared/types/mcp-servers';
import { useMcpServerList } from '../useMcpServerList';

let accountEnabled = false;
jest.mock('@/stores/featureFlagsStore', () => ({
  useFeatureFlagsStore: (
    selector: (state: { isEnabled: () => boolean }) => boolean,
  ): boolean => selector({ isEnabled: () => accountEnabled }),
}));

const loadIndex = jest.fn<Promise<McpServersIndexFile>, []>();

function entry(overrides: Partial<McpServerIndexEntry>): McpServerIndexEntry {
  return {
    id: 'device-github',
    name: 'GitHub',
    type: 'http',
    configs: [{ id: 'default', name: 'Default', enabled: true }],
    updatedAt: '2026-09-17T00:00:00.000Z',
    ...overrides,
  };
}

const device = entry({ id: 'device-github', curatedKey: 'github' });
const account = entry({
  id: 'account-github',
  name: 'GitHub (account)',
  curatedKey: 'github',
  scope: 'account',
  authHandler: 'account',
  deviceCopies: [device],
});

function Probe(): JSX.Element {
  const { servers, loading } = useMcpServerList();
  return (
    <output data-testid="servers">
      {loading ? 'loading' : servers.map((row) => row.id).join(',')}
    </output>
  );
}

let container: HTMLDivElement;
let root: Root;

beforeEach((): void => {
  jest.clearAllMocks();
  loadIndex.mockResolvedValue({ version: 1, servers: [account] });
  Object.defineProperty(window, 'mcpServers', {
    configurable: true,
    value: {
      loadIndex,
      onOAuthTokensChanged: (): (() => void) => (): void => undefined,
    },
  });
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach((): void => {
  act((): void => {
    root.unmount();
  });
  container.remove();
});

async function renderProbe(): Promise<string> {
  act((): void => {
    root.render(<Probe />);
  });
  await act(async (): Promise<void> => {
    await Promise.resolve();
  });
  return container.querySelector('output')?.textContent ?? '';
}

describe('useMcpServerList', () => {
  it('falls back to the nested device copies when the account flag is off', async (): Promise<void> => {
    accountEnabled = false;
    expect(await renderProbe()).toBe('device-github');
  });

  it('keeps account rows when the account flag is on', async (): Promise<void> => {
    accountEnabled = true;
    expect(await renderProbe()).toBe('account-github');
  });

  it('reloads the index when the account flag turns on', async (): Promise<void> => {
    accountEnabled = false;
    expect(await renderProbe()).toBe('device-github');
    expect(loadIndex).toHaveBeenCalledTimes(1);
    accountEnabled = true;
    expect(await renderProbe()).toBe('account-github');
    expect(loadIndex).toHaveBeenCalledTimes(2);
  });
});
