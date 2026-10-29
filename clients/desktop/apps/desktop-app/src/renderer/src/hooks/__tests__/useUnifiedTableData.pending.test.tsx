/**
 * @jest-environment jsdom
 *
 * The window where the catalog has resolved and the connector read has not.
 *
 * Its own file because `useProviderConnectors` shares one in-flight read
 * across instances through a module-scoped promise, and this test's read never
 * settles by design. Jest isolates module state per file, so keeping it here
 * stops that promise being reused by every test after it — which is exactly
 * what happened when they shared a file.
 */
import { GMAIL_CONNECTOR as GMAIL } from './connectorFixtures';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { useUnifiedTableData } from '../useUnifiedTableData';
import type { UnifiedTableRow } from '../useUnifiedTableData';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

jest.mock('../useSkillList', () => ({
  useSkillList: (): unknown => ({ skills: [], loading: false }),
}));
jest.mock('../useMarketplaceList', () => ({
  useMarketplaceList: (): unknown => ({ cache: null, loading: false }),
}));
jest.mock('../useCollectionList', () => ({
  useCollectionList: (): unknown => ({ collections: [], loading: false }),
}));
jest.mock('../useMcpServerList', () => ({
  useMcpServerList: (): unknown => ({ servers: [], loading: false }),
}));

let container: HTMLDivElement;
let root: Root;

function mount(): {
  rows: UnifiedTableRow[];
  sourceOptions: Array<{ value: string }>;
} {
  const captured: {
    rows: UnifiedTableRow[];
    sourceOptions: Array<{ value: string }>;
  } = { rows: [], sourceOptions: [] };
  function Probe(): null {
    const data = useUnifiedTableData({
      includeCollections: false,
      includeMcp: true,
      includeProviderConnectors: true,
    });
    captured.rows = data.rows;
    captured.sourceOptions = data.sourceOptions;
    return null;
  }
  act(() => {
    root.render(<Probe />);
  });
  return captured;
}

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  jest.restoreAllMocks();
});

describe('a connector read that has not settled', () => {
  it('says "checking" while the connector read is still outstanding', async () => {
    // The catalog resolves and the connector read does not, which is the
    // window the flash lived in. Asserting over "whatever rows exist at first
    // paint" would be vacuous — the catalog has not resolved then either, so
    // there is nothing to loop over and the test passes regardless.
    Object.defineProperty(window, 'mcpServers', {
      configurable: true,
      value: {
        listCurated: jest
          .fn()
          .mockResolvedValue({ version: 1, servers: [GMAIL] }),
        listProviderConnectors: jest.fn(
          () => new Promise<never>(() => undefined),
        ),
      },
    });
    const captured = mount();
    await flush();

    const gmail = captured.rows.find((row) => row.name === 'Gmail');
    // The row exists — otherwise the assertions below prove nothing.
    expect(gmail).toBeDefined();
    expect(gmail?.sourceSubtitle).toMatch(/checking/i);
    expect(gmail?.sourceSubtitle).not.toMatch(/link it there/i);
    expect(gmail?.toggleMode).toBe('disabled');
  });
});
