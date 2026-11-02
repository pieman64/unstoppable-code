/**
 * @jest-environment jsdom
 */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act, type ReactNode } from 'react';
import {
  MarketplaceDetailPageShell,
  type MarketplaceDetailPageHeader,
} from '@canopy/ui-app/capability';
import type { DetailMoreMenuItem } from '@canopy/ui-shared/components';
import { createRoot, type Root } from 'react-dom/client';
import type { SharedAgentSummary } from '@canopy/desktop-shared/types/agent-models';
import type { SharedPluginSummary } from '@canopy/protocol/plugins';

const mockInstallSharedPluginRef = jest.fn();
jest.mock('@/lib/publicSharePluginInstall', () => ({
  installSharedPluginRef: (ref: unknown): unknown =>
    mockInstallSharedPluginRef(ref),
}));

import { outermostReplayBlock } from '@/test-utils/replay';
import type { WorkspaceTemplateShareSummary } from '@canopy/protocol/workspace-templates';
import { useNavigationStore } from '@/stores/navigationStore';
import {
  SharedAgentMarketplaceDetail,
  SharedBlueprintMarketplaceDetail,
  SharedPluginMarketplaceDetail,
} from '../SharedResourceMarketplaceDetail';
import {
  sharedAgentDetailHeader,
  sharedBlueprintDetailHeader,
  sharedPluginDetailHeader,
} from '../sharedResourceDetailHeaders';

const PERSONAL_ORG_ID = '11111111-1111-4111-8111-111111111111';

const agent: SharedAgentSummary = {
  id: 'agent-1',
  name: 'Release notes writer',
  modelId: 'agent_model_release',
  baseModel: 'claude-sonnet-4-5',
  instructionsPreview: 'Draft release notes from merged pull requests.',
  contentHash: 'hash',
  shareScope: 'team',
  owner: {
    type: 'team',
    id: 'team-1',
    name: 'Growth',
    organization: { id: 'org-1', name: 'Acme' },
  },
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
  createdBy: { id: 'user-1', name: 'Aaron', email: null },
  canUpdate: false,
  canDelete: false,
};

const plugin: SharedPluginSummary = {
  owner: { type: 'organization', id: 'org-1', name: 'Acme' },
  shareScope: 'organization',
  createdBy: { id: 'user-1', name: 'Aaron' },
  externalId: 'plugin-share-1',
  refKey: 'plugin:github:acme/tools:deploy',
  ref: {
    type: 'plugin',
    marketplace: { type: 'github', repo: 'acme/tools' },
    plugin_name: 'deploy',
  },
  name: 'Deploy tools',
  description: 'Ship from chat.',
  marketplaceOrigin: 'acme/tools',
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
};

describe('shared resource Marketplace details', () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    mockInstallSharedPluginRef.mockReset();
    useNavigationStore.setState({
      pendingShareInstall: undefined,
      heldShareInstall: undefined,
      shareInstallBusy: false,
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function byTestId(id: string): HTMLElement | null {
    return document.querySelector(`[data-testid="${id}"]`);
  }

  async function click(id: string): Promise<void> {
    await act(async () => {
      byTestId(id)?.click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  }

  /** The host's page: the shell's item header around the body (CAN-4266). */
  function renderPage(
    title: string,
    header: MarketplaceDetailPageHeader,
    body: ReactNode,
    moreItems: readonly DetailMoreMenuItem[] = [],
  ): void {
    act(() => {
      root.render(
        <MarketplaceDetailPageShell
          title={title}
          header={header}
          moreItems={moreItems}
        >
          {body}
        </MarketplaceDetailPageShell>,
      );
    });
  }

  it.each(['agent', 'plugin'])(
    'labels a Personal-owned %s through the shared audience control',
    (kind) => {
      const owner = {
        type: 'organization' as const,
        id: PERSONAL_ORG_ID,
        name: 'Stored owner',
      };
      if (kind === 'agent') {
        const subject = {
          ...agent,
          shareScope: 'organization' as const,
          owner,
        };
        renderPage(
          subject.name,
          sharedAgentDetailHeader(subject, PERSONAL_ORG_ID),
          <SharedAgentMarketplaceDetail agent={subject} />,
        );
      } else {
        const subject = { ...plugin, owner };
        renderPage(
          subject.name,
          sharedPluginDetailHeader(subject, PERSONAL_ORG_ID),
          <SharedPluginMarketplaceDetail plugin={subject} />,
        );
      }
      expect(byTestId(`shared-${kind}-detail-audience`)?.textContent).toBe(
        'Personal',
      );
    },
  );

  /** The header's facts in document order, by test id suffix. */
  function provenanceFacts(kind: string): (string | null)[] {
    const prefix = `shared-${kind}-detail-audience`;
    return [`${prefix}-author`, `${prefix}-organization`, prefix].map(
      (id) => byTestId(id)?.textContent ?? null,
    );
  }

  it('names a team agent’s parent organization between author and audience', () => {
    renderPage(
      agent.name,
      sharedAgentDetailHeader(agent, null),
      <SharedAgentMarketplaceDetail agent={agent} />,
    );
    expect(provenanceFacts('agent')).toEqual([
      'By Aaron',
      'Acme',
      'Team: Growth',
    ]);
    const meta = byTestId('plugins-entry-detail-header-meta');
    const ids = Array.from(meta?.querySelectorAll('[data-testid]') ?? [])
      .map((node) => node.getAttribute('data-testid'))
      .filter((id) => id?.startsWith('shared-agent-detail-audience'));
    expect(ids).toEqual([
      'shared-agent-detail-audience-author',
      'shared-agent-detail-audience-organization',
      'shared-agent-detail-audience',
    ]);
  });

  it('names an organization plugin’s owner, not the navigation context', () => {
    const subject: SharedPluginSummary = {
      ...plugin,
      owner: { type: 'organization', id: 'org-2', name: 'Other Org' },
    };
    renderPage(
      subject.name,
      sharedPluginDetailHeader(subject, PERSONAL_ORG_ID),
      <SharedPluginMarketplaceDetail plugin={subject} />,
    );
    expect(provenanceFacts('plugin')).toEqual([
      'By Aaron',
      'Other Org',
      'Organization',
    ]);
  });

  it('names a team project template’s parent organization', () => {
    const blueprint: WorkspaceTemplateShareSummary = {
      externalId: 'blueprint-1',
      sharePath: '/portal/plugins/blueprints/shared/blueprint-1',
      name: 'Release train',
      description: 'A project for shipping.',
      audience: 'TEAM',
      pinnedContentHash: 'b'.repeat(64),
      owner: {
        type: 'team',
        id: 'team-1',
        name: 'Growth',
        organization: { id: 'org-1', name: 'Acme' },
      },
      createdBy: { id: 'user-1', name: 'Aaron' },
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
    };
    renderPage(
      blueprint.name,
      sharedBlueprintDetailHeader(blueprint, null),
      null,
    );
    expect(provenanceFacts('blueprint')).toEqual([
      'By Aaron',
      'Acme',
      'Team: Growth',
    ]);
  });

  it('omits the organization for a Personal owner without a dangling fact', () => {
    const subject: SharedPluginSummary = {
      ...plugin,
      owner: { type: 'organization', id: PERSONAL_ORG_ID, name: 'Acme' },
    };
    renderPage(
      subject.name,
      sharedPluginDetailHeader(subject, PERSONAL_ORG_ID),
      null,
    );
    expect(provenanceFacts('plugin')).toEqual(['By Aaron', null, 'Personal']);
  });

  describe('SharedAgentMarketplaceDetail', () => {
    function render(
      subject: SharedAgentSummary = agent,
      moreItems: readonly DetailMoreMenuItem[] = [],
    ): void {
      renderPage(
        subject.name,
        sharedAgentDetailHeader(subject, null),
        <SharedAgentMarketplaceDetail agent={subject} />,
        moreItems,
      );
    }

    it('says who shared the agent and with which team, as plain text', () => {
      render();
      expect(
        byTestId('plugins-entry-detail-header-description')?.textContent,
      ).toMatch(/^Agent using /);
      expect(
        byTestId('plugins-entry-detail-header-meta')?.textContent,
      ).toContain('By Aaron');
      const audience = byTestId('shared-agent-detail-audience');
      expect(audience?.textContent).toBe('Team: Growth');
      expect(audience?.className).not.toMatch(/\b(bg-|ring-|rounded|border)/);
      expect(container.textContent).toContain(
        'Draft release notes from merged pull requests.',
      );
      // Nothing opens or installs until the viewer asks for it.
      expect(useNavigationStore.getState().pendingShareInstall).toBeUndefined();
    });

    it("blocks the sharer's name from session replay, not the byline or audience", () => {
      render();
      const byline = Array.from(container.querySelectorAll('span')).find(
        (span) => span.textContent === 'By Aaron',
      );
      expect(byline).toBeDefined();
      expect(outermostReplayBlock(byline)).toBeNull();
      const name = Array.from(byline?.querySelectorAll('span') ?? []).find(
        (span) => span.textContent === 'Aaron',
      );
      expect(outermostReplayBlock(name)?.textContent).toBe('Aaron');
      expect(
        outermostReplayBlock(byTestId('shared-agent-detail-audience')),
      ).toBeNull();
    });

    it('names the detail action Install, as the install review does', () => {
      render();
      const install = byTestId('shared-agent-detail-add');
      expect(install?.textContent).toBe('Install');
      expect(install?.getAttribute('aria-label')).toBe(
        'Install Release notes writer',
      );
    });

    it('opens the install review for the team share on Install', async () => {
      render();
      await click('shared-agent-detail-add');
      expect(useNavigationStore.getState().pendingShareInstall).toEqual({
        link: {
          entity: 'agent',
          externalId: 'agent-1',
          intent: 'install',
          audience: 'TEAM',
        },
        origin: 'in-app',
      });
    });

    it('offers no Add for a private agent, which resolves for nobody else', () => {
      render({ ...agent, shareScope: 'private' });
      expect(byTestId('shared-agent-detail-add')).toBeNull();
    });

    const unshareItem: DetailMoreMenuItem = {
      id: 'unshare',
      label: 'Unshare',
      icon: null,
      testId: 'host-unshare',
      onSelect: () => undefined,
      destructive: true,
    };

    it('leads the header with the ⋯ menu holding Unshare, and ends with Install (CAN-4266)', () => {
      render(agent, [unshareItem]);
      const bars = container.querySelectorAll(
        '[data-testid="detail-action-bar"]',
      );
      expect(bars).toHaveLength(1);
      // The body's bar holds only Install; Unshare moved to the ⋯ menu.
      expect(
        Array.from(bars[0]?.querySelectorAll('button') ?? []).map(
          (button) => button.dataset.testid,
        ),
      ).toEqual(['shared-agent-detail-add']);
      const actions = byTestId('plugins-entry-detail-header-actions');
      expect(
        actions?.firstElementChild?.querySelector('button')?.dataset.testid,
      ).toBe('plugins-entry-detail-more');
      expect(byTestId('plugins-entry-detail-back')).toBeNull();
    });

    it('keeps Unshare in the ⋯ menu for a private agent with nothing to Install', () => {
      render({ ...agent, shareScope: 'private' }, [unshareItem]);
      expect(byTestId('plugins-entry-detail-more')).not.toBeNull();
      expect(byTestId('shared-agent-detail-add')).toBeNull();
    });
  });

  describe('SharedBlueprintMarketplaceDetail', () => {
    const blueprint: WorkspaceTemplateShareSummary = {
      externalId: 'blueprint-1',
      sharePath: '/portal/plugins/blueprints/shared/blueprint-1',
      name: 'Release train',
      description: 'A project for shipping.',
      audience: 'TEAM',
      pinnedContentHash: 'b'.repeat(64),
      owner: {
        type: 'team',
        id: 'team-1',
        name: 'Growth',
        organization: { id: 'org-1', name: 'Acme' },
      },
      createdBy: { id: 'user-1', name: 'Aaron' },
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
    };

    it('opens the pinned install review on Add and never installs on open', async () => {
      const createFromTemplate = jest.fn();
      Object.assign(window, { api: { chatProject: { createFromTemplate } } });
      act(() => {
        root.render(<SharedBlueprintMarketplaceDetail blueprint={blueprint} />);
      });
      expect(createFromTemplate).not.toHaveBeenCalled();
      await click('shared-blueprint-detail-add');
      expect(useNavigationStore.getState().pendingShareInstall).toEqual({
        link: {
          entity: 'workspace',
          externalId: 'blueprint-1',
          intent: 'install',
          audience: 'TEAM',
          expectedWorkspaceTemplateContentHash: 'b'.repeat(64),
        },
        origin: 'in-app',
      });
      expect(createFromTemplate).not.toHaveBeenCalled();
    });
  });

  describe('SharedPluginMarketplaceDetail', () => {
    function render(): void {
      renderPage(
        plugin.name,
        sharedPluginDetailHeader(plugin, null),
        <SharedPluginMarketplaceDetail plugin={plugin} />,
      );
    }

    it('names the source and the organization it is shared with', () => {
      render();
      expect(byTestId('shared-plugin-detail-audience')?.textContent).toBe(
        'Organization',
      );
      expect(container.textContent).toContain('acme/tools');
      expect(container.textContent).toContain(
        'Only a reference to this plugin is shared.',
      );
      // Nothing installs until the viewer asks for it.
      expect(mockInstallSharedPluginRef).not.toHaveBeenCalled();
    });

    it('opens the install review on Add instead of installing inline', async () => {
      render();
      await click('shared-plugin-detail-add');
      expect(mockInstallSharedPluginRef).not.toHaveBeenCalled();
      expect(useNavigationStore.getState().pendingShareInstall).toEqual({
        link: {
          entity: 'plugin',
          externalId: 'plugin-share-1',
          intent: 'install',
          audience: 'ORGANIZATION',
        },
        origin: 'in-app',
      });
    });
  });
});
