/** @jest-environment jsdom */

import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { InstalledSkillInfo } from '@canopy/protocol/skills';
import type { CollectionIndexEntry } from '@canopy/protocol/collections';
import type { McpServerIndexEntry } from '@canopy/protocol/mcp-servers';
import {
  buildUnifiedPluginEntries,
  type UnifiedPluginEntry,
} from '../unifiedPluginEntries';
import {
  useOpenCreatedCustomItem,
  type CreatedCustomItem,
} from '../useOpenCreatedCustomItem';

const CUSTOM_SKILL: InstalledSkillInfo = {
  name: 'release-notes',
  sourceId: 'custom:app',
  description: 'Drafts release notes',
  source: 'local',
  installedAt: '2026-10-23T00:00:00.000Z',
  updatedAt: '2026-10-23T00:00:00.000Z',
  updateAvailable: false,
};

const COLLECTION: CollectionIndexEntry = {
  id: 'collection-1',
  name: 'release-kit',
  description: 'Release tools',
  updatedAt: '2026-10-23T00:00:00.000Z',
  skillCount: 1,
  pluginCount: 0,
  mcpServerCount: 0,
};

const ACCOUNT_SERVER: McpServerIndexEntry = {
  id: 'custom:abc123',
  name: 'Tracker',
  description: 'Issue tracker',
  type: 'http',
  configs: [{ id: 'default', name: 'Default', enabled: true }],
  scope: 'account',
  updatedAt: '2026-10-23T00:00:00.000Z',
};

const WORK_CONFIG = { id: 'work', name: 'Work', enabled: true };

function entriesWith(
  inputs: {
    installedSkills?: InstalledSkillInfo[];
    localCollections?: CollectionIndexEntry[];
    mcpServers?: McpServerIndexEntry[];
  } = {},
): UnifiedPluginEntry[] {
  return buildUnifiedPluginEntries({
    curatedPlugins: [],
    marketplaces: [],
    installedSkills: inputs.installedSkills ?? [],
    mcpServers: inputs.mcpServers ?? [],
    mcpStatuses: [],
    curatedMcpServers: [],
    providerConnectors: [],
    ...(inputs.localCollections
      ? { localCollections: inputs.localCollections }
      : {}),
  });
}

describe('useOpenCreatedCustomItem', () => {
  let container: HTMLDivElement;
  let root: Root;
  let openCreated: ((item: CreatedCustomItem) => void) | null;
  const openEntry = jest.fn<void, [UnifiedPluginEntry]>();

  function Probe({
    entries,
  }: {
    entries: readonly UnifiedPluginEntry[];
  }): JSX.Element | null {
    openCreated = useOpenCreatedCustomItem(entries, openEntry);
    return null;
  }

  function render(entries: readonly UnifiedPluginEntry[]): void {
    act(() => {
      root.render(<Probe entries={entries} />);
    });
  }

  function create(item: CreatedCustomItem): void {
    act(() => {
      openCreated?.(item);
    });
  }

  beforeEach(() => {
    jest.useFakeTimers();
    openEntry.mockReset();
    openCreated = null;
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    jest.useRealTimers();
  });

  it('creating a custom skill opens its detail page', () => {
    render(entriesWith());
    create({ kind: 'skill', sourceId: 'custom:app', name: 'release-notes' });
    // The list refresh has not landed yet: nothing to open.
    expect(openEntry).not.toHaveBeenCalled();

    render(entriesWith({ installedSkills: [CUSTOM_SKILL] }));

    expect(openEntry).toHaveBeenCalledTimes(1);
    expect(openEntry.mock.calls[0]?.[0]).toMatchObject({
      id: 'skill:custom:app:release-notes',
      kind: 'skill',
    });
    // Opened once: later list updates leave the detail alone.
    render(entriesWith({ installedSkills: [CUSTOM_SKILL] }));
    expect(openEntry).toHaveBeenCalledTimes(1);
  });

  it('creating a collection opens its detail page at once when already listed', () => {
    render(entriesWith({ localCollections: [COLLECTION] }));
    create({ kind: 'collection', collectionId: 'collection-1' });

    expect(openEntry).toHaveBeenCalledTimes(1);
    expect(openEntry.mock.calls[0]?.[0]).toMatchObject({
      id: 'collection:local:collection-1',
    });
  });

  it('creating a custom MCP server opens the row for its configuration', () => {
    render(entriesWith());
    create({
      kind: 'mcp-server',
      serverId: 'custom:abc123',
      configId: 'default',
    });
    render(
      entriesWith({
        mcpServers: [
          ACCOUNT_SERVER,
          { ...ACCOUNT_SERVER, configs: [{ ...WORK_CONFIG }] },
        ],
      }),
    );

    expect(openEntry).toHaveBeenCalledTimes(1);
    expect(openEntry.mock.calls[0]?.[0]?.ref).toEqual({
      type: 'local-mcp',
      serverId: 'custom:abc123',
      configId: 'default',
    });
  });

  it('creating an agent opens its detail by id before the agent list loads', () => {
    render(entriesWith());
    create({ kind: 'agent', agentId: 'agent_model_release' });

    expect(openEntry).toHaveBeenCalledTimes(1);
    expect(openEntry.mock.calls[0]?.[0]).toMatchObject({
      id: 'agent:local:agent_model_release',
      ref: { type: 'local-agent', agentId: 'agent_model_release' },
    });
  });

  it('does not navigate later when the created item never lists in time', () => {
    render(entriesWith());
    create({ kind: 'skill', sourceId: 'custom:app', name: 'release-notes' });
    act(() => {
      jest.advanceTimersByTime(60_000);
    });

    render(entriesWith({ installedSkills: [CUSTOM_SKILL] }));

    expect(openEntry).not.toHaveBeenCalled();
  });
});
