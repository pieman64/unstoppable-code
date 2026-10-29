/** @jest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { CanopyCloudAccountPublicState } from '@canopy/desktop-shared/types';
import { useWorkspaceContextStore } from '@/stores/workspaceContextStore';
import {
  SHARED_PLUGINS_CHANGED_EVENT,
  useSharedMarketplaceShares,
  type SharedMarketplaceShares,
  type SharedMarketplaceSharesOptions,
} from '../useSharedMarketplaceShares';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

function account(capabilities: string[]): CanopyCloudAccountPublicState {
  return {
    hasApiKey: true,
    storageAvailable: true,
    capabilities,
    account: {
      id: 'account-1',
      name: 'Alice',
      email: 'alice@example.com',
      role: 'ADMIN',
    },
  };
}

const fullAccount = account(['agents-crud-v1', 'plugins-crud-v1']);

describe('useSharedMarketplaceShares', () => {
  let container: HTMLElement;
  let root: Root;
  let latest: SharedMarketplaceShares;
  const listSharedAgents = jest.fn();
  const listSharedPlugins = jest.fn();

  function Probe(props: SharedMarketplaceSharesOptions): null {
    latest = useSharedMarketplaceShares(props);
    return null;
  }

  async function render(props: SharedMarketplaceSharesOptions): Promise<void> {
    await act(async () => {
      root.render(<Probe {...props} />);
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  beforeEach(() => {
    listSharedAgents.mockReset();
    listSharedAgents.mockResolvedValue({
      agents: [{ id: 'agent-1', name: 'Writer' }],
    });
    listSharedPlugins.mockReset();
    listSharedPlugins.mockResolvedValue({
      success: true,
      data: { serverId: 'cloud', data: [{ externalId: 'plugin-1' }] },
    });
    Object.assign(window, {
      agents: { listShared: listSharedAgents },
      plugins: { listShared: listSharedPlugins },
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('retires in-flight inventory when a refresh removes the Personal ID', async () => {
    let finishOld: ((value: unknown) => void) | undefined;
    listSharedAgents.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishOld = resolve;
        }),
    );
    const personalAccount = {
      ...fullAccount,
      personalOrganizationId: '11111111-1111-4111-8111-111111111111',
    };
    await render({ account: personalAccount, agents: true, plugins: true });
    await render({ account: fullAccount, agents: true, plugins: true });
    expect(listSharedAgents).toHaveBeenCalledTimes(2);
    expect(listSharedPlugins).toHaveBeenCalledTimes(2);
    await act(async () => {
      finishOld?.({ agents: [{ id: 'stale' }] });
      await Promise.resolve();
    });
    expect(latest.sharedAgents).toEqual([{ id: 'agent-1', name: 'Writer' }]);
  });

  it('loads the first page of each enabled kind once', async () => {
    await render({ account: fullAccount, agents: true, plugins: true });

    expect(listSharedAgents).toHaveBeenCalledTimes(1);
    expect(listSharedAgents).toHaveBeenCalledWith({ limit: 25 });
    expect(listSharedPlugins).toHaveBeenCalledTimes(1);
    expect(latest.sharedAgents).toEqual([{ id: 'agent-1', name: 'Writer' }]);
    expect(latest.sharedPlugins).toEqual([{ externalId: 'plugin-1' }]);
    expect(latest.loading).toBe(false);
  });

  it('reloads shared agents on request, so a new share dedupes (CAN-4266)', async () => {
    await render({ account: fullAccount, agents: true, plugins: true });
    listSharedAgents.mockResolvedValueOnce({
      agents: [{ id: 'agent-2', name: 'Reviewer' }],
    });

    await act(async () => {
      latest.refreshAgents();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(listSharedAgents).toHaveBeenCalledTimes(2);
    expect(listSharedPlugins).toHaveBeenCalledTimes(1);
    expect(latest.sharedAgents).toEqual([{ id: 'agent-2', name: 'Reviewer' }]);
  });

  it('lists every owned agent page with the same author and search', async () => {
    listSharedAgents
      .mockResolvedValueOnce({
        agents: [{ id: 'agent-1', name: 'Writer' }],
        nextCursor: 'owned-next',
      })
      .mockResolvedValueOnce({
        agents: [{ id: 'agent-2', name: 'Writer two' }],
        nextCursor: null,
      });
    await render({
      account: fullAccount,
      agents: true,
      plugins: false,
      createdBy: 'me',
      query: 'writer',
    });
    expect(listSharedAgents).toHaveBeenLastCalledWith({
      limit: 25,
      cursor: 'owned-next',
      createdBy: 'me',
      query: 'writer',
    });
    expect(latest.sharedAgents.map((row) => row.id)).toEqual([
      'agent-1',
      'agent-2',
    ]);
  });

  it('lists every shared agent page, so local copies cannot hide later ones', async () => {
    // Folding shares into their local copies could otherwise empty the tab
    // while uninstalled agents sit on a later page.
    listSharedAgents
      .mockResolvedValueOnce({
        agents: [{ id: 'agent-1', name: 'Writer' }],
        nextCursor: 'page-2',
      })
      .mockResolvedValueOnce({
        agents: [{ id: 'agent-2', name: 'Reviewer' }],
        nextCursor: null,
      });
    await render({ account: fullAccount, agents: true, plugins: false });
    expect(listSharedAgents).toHaveBeenCalledTimes(2);
    expect(listSharedAgents).toHaveBeenLastCalledWith({
      limit: 25,
      cursor: 'page-2',
    });
    expect(latest.sharedAgents.map((row) => row.id)).toEqual([
      'agent-1',
      'agent-2',
    ]);
  });

  it('stops reading shared agents at the page cap; search reaches the rest', async () => {
    let page = 0;
    listSharedAgents.mockImplementation(() => {
      page += 1;
      return Promise.resolve({
        agents: [{ id: `agent-${page}`, name: `Agent ${page}` }],
        nextCursor: `page-${page + 1}`,
      });
    });
    await act(async () => {
      root.render(
        <Probe account={fullAccount} agents={true} plugins={false} />,
      );
      for (let tick = 0; tick < 60; tick += 1) await Promise.resolve();
    });
    expect(listSharedAgents).toHaveBeenCalledTimes(20);
    expect(latest.sharedAgents).toHaveLength(20);
    expect(latest.agentsError).toBeNull();
  });

  it('makes no call for a kind its tab does not show', async () => {
    await render({ account: fullAccount, agents: false, plugins: false });

    expect(listSharedAgents).not.toHaveBeenCalled();
    expect(listSharedPlugins).not.toHaveBeenCalled();
    expect(latest.sharedAgents).toEqual([]);
    expect(latest.sharedPlugins).toEqual([]);
  });

  it('makes no call while the account is missing or lacks the capability', async () => {
    await render({ account: null, agents: true, plugins: true });
    await render({
      account: account(['skills-crud-v1']),
      agents: true,
      plugins: true,
    });

    expect(listSharedAgents).not.toHaveBeenCalled();
    expect(listSharedPlugins).not.toHaveBeenCalled();
  });

  it('drops a kind that was listed once its tab stops showing it', async () => {
    await render({ account: fullAccount, agents: true, plugins: true });
    await render({ account: fullAccount, agents: false, plugins: true });

    expect(latest.sharedAgents).toEqual([]);
    expect(latest.sharedPlugins).toEqual([{ externalId: 'plugin-1' }]);
    // Plugins did not reload just because the agents list was dropped.
    expect(listSharedPlugins).toHaveBeenCalledTimes(1);
  });

  it('narrows agents by the search on the server', async () => {
    await render({
      account: fullAccount,
      agents: true,
      plugins: false,
      query: '  writer ',
    });

    expect(listSharedAgents).toHaveBeenCalledWith({
      limit: 25,
      query: 'writer',
    });
  });

  it('reloads when the sidebar context changes', async () => {
    await render({ account: fullAccount, agents: true, plugins: true });
    await act(async () => {
      useWorkspaceContextStore.setState((state) => ({
        appliedGeneration: state.appliedGeneration + 1,
      }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(listSharedAgents).toHaveBeenCalledTimes(2);
    expect(listSharedPlugins).toHaveBeenCalledTimes(2);
  });

  it('reloads plugins, and only plugins, when a plugin share changes', async () => {
    await render({ account: fullAccount, agents: true, plugins: true });
    listSharedPlugins.mockResolvedValue({
      success: true,
      data: {
        serverId: 'cloud',
        data: [{ externalId: 'plugin-1' }, { externalId: 'plugin-2' }],
      },
    });

    await act(async () => {
      window.dispatchEvent(new Event(SHARED_PLUGINS_CHANGED_EVENT));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(listSharedPlugins).toHaveBeenCalledTimes(2);
    expect(listSharedAgents).toHaveBeenCalledTimes(1);
    expect(latest.sharedPlugins).toEqual([
      { externalId: 'plugin-1' },
      { externalId: 'plugin-2' },
    ]);
  });

  it('keeps one kind listed when the other fails', async () => {
    listSharedAgents.mockRejectedValue(new Error('Agents are down.'));
    await render({ account: fullAccount, agents: true, plugins: true });

    expect(latest.sharedAgents).toEqual([]);
    expect(latest.agentsError).toBeTruthy();
    expect(latest.sharedPlugins).toEqual([{ externalId: 'plugin-1' }]);
    expect(latest.pluginsError).toBeNull();
  });

  it('reports a failed plugin read instead of listing nothing silently', async () => {
    listSharedPlugins.mockResolvedValue({
      success: false,
      error: 'Not allowed.',
    });
    await render({ account: fullAccount, agents: false, plugins: true });

    expect(latest.sharedPlugins).toEqual([]);
    expect(latest.pluginsError).toBe('Not allowed.');
  });
});
