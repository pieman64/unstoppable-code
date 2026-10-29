/**
 * @jest-environment jsdom
 */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { ChatTabPluginSelections } from '@canopy/desktop-shared/types';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import type { UseUnifiedTableDataReturn } from '../../../hooks/useUnifiedTableData';

// The workspace, project, and chat project settings modals all edit their
// default plugins through this picker, so it renders the real PluginSelector
// over a deterministic row set.
jest.mock('@/hooks/useUnifiedTableData', (): Record<string, unknown> => {
  const actual: Record<string, unknown> = jest.requireActual(
    '@/hooks/useUnifiedTableData',
  );
  return {
    ...actual,
    useUnifiedTableData: jest.fn(),
  };
});
jest.mock('@/hooks/useCollectionList', () => ({
  useCollectionList: (): {
    collections: never[];
    loading: boolean;
    error: null;
    refresh: () => Promise<void>;
  } => ({
    collections: [],
    loading: false,
    error: null,
    refresh: jest.fn(() => Promise.resolve()),
  }),
}));
jest.mock('../../pages/CollectionsTab', () => ({
  CollectionModal: (): null => null,
}));
jest.mock('../../pages/UnifiedTableDetailOverlays', () => ({
  UnifiedTableDetailOverlays: (): null => null,
}));
jest.mock('../../pages/unifiedTableDetailView', () => ({
  useUnifiedTableDetailView: (): {
    openRowDetails: jest.Mock;
    closeDetails: jest.Mock;
    viewingSkill: null;
    viewingPlugin: null;
    viewingMcpServerId: null;
  } => ({
    openRowDetails: jest.fn(),
    closeDetails: jest.fn(),
    viewingSkill: null,
    viewingPlugin: null,
    viewingMcpServerId: null,
  }),
}));

import { SettingsPluginPicker } from '../SettingsPluginPicker';
import { buildMcpRows, useUnifiedTableData } from '@/hooks/useUnifiedTableData';

const mockUseUnifiedTableData =
  useUnifiedTableData as unknown as jest.MockedFunction<
    () => UseUnifiedTableDataReturn
  >;

const ACCOUNT_SERVER_ID = 'custom:11111111-2222-4333-8444-555555555555';

function emptySelections(): ChatTabPluginSelections {
  return { collectionIds: [], skillRefs: [], pluginRefs: [] };
}

describe('SettingsPluginPicker MCP surface badges (REG-3011)', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    mockUseUnifiedTableData.mockReturnValue({
      rows: buildMcpRows([
        {
          id: ACCOUNT_SERVER_ID,
          scope: 'account',
          authHandler: 'account',
          accountConnectionId: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
          name: 'Team tracker',
          description: '',
          type: 'http',
          configs: [{ id: 'default', name: 'Default', enabled: true }],
          updatedAt: '',
        },
        {
          id: 'local-files',
          name: 'Local files',
          description: '',
          type: 'command',
          configs: [{ id: 'default', name: 'Default', enabled: true }],
          updatedAt: '',
        },
      ]),
      sourceOptions: [],
      loading: false,
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    jest.clearAllMocks();
  });

  function rowFor(key: string): HTMLTableRowElement | null {
    return (
      document.body
        .querySelector(`input[data-row-key="${key}"]`)
        ?.closest('tr') ?? null
    );
  }

  it('records its portaled dialog card and blocks the plugin rows', (): void => {
    act((): void =>
      root.render(
        <SettingsPluginPicker
          label="Default plugins"
          description="New chats start with these."
          selections={emptySelections()}
          onChange={jest.fn()}
        />,
      ),
    );
    act((): void =>
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Plugins"]')
        ?.click(),
    );

    const card = document.body.querySelector(':scope > div > [role="dialog"]');
    expect(card?.textContent).toContain('Team tracker');
    expect(card?.classList.contains(POSTHOG_REPLAY_BLOCK_CLASS)).toBe(false);
    expect(
      Array.from(
        card?.querySelectorAll(`.${POSTHOG_REPLAY_BLOCK_CLASS}`) ?? [],
      ).some((node) => node.textContent?.includes('Team tracker')),
    ).toBe(true);
  });

  it('badges MCP rows with where they run and saves an account server as a default', (): void => {
    const onChange = jest.fn();
    act((): void =>
      root.render(
        <SettingsPluginPicker
          label="Default plugins"
          description="New chats start with these."
          selections={emptySelections()}
          onChange={onChange}
        />,
      ),
    );
    act((): void =>
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Plugins"]')
        ?.click(),
    );

    expect(rowFor(`${ACCOUNT_SERVER_ID}/default`)?.textContent).toContain(
      'Cloud + desktop',
    );
    expect(rowFor('local-files/default')?.textContent).toContain(
      'Desktop only',
    );

    act((): void =>
      document.body
        .querySelector<HTMLInputElement>(
          `input[data-row-key="${ACCOUNT_SERVER_ID}/default"]`,
        )
        ?.click(),
    );
    act((): void =>
      Array.from(document.body.querySelectorAll('button'))
        .find((button): boolean => button.textContent === 'Save')
        ?.click(),
    );
    expect(onChange).toHaveBeenCalledWith(
      expect.objectContaining({
        mcpServerRefs: [{ serverId: ACCOUNT_SERVER_ID, configId: 'default' }],
      }),
    );
  });
});
