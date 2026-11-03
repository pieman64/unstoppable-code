/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  CustomizeInstalledRow,
  customizeRowDomId,
} from '../CustomizeInstalledRow';
import { CustomizeInstalledList } from '../CustomizeInstalledList';
import { CustomizeInstalledUnavailable } from '../CustomizeInstalledUnavailable';
import { CustomizeRowMenu } from '../CustomizeRowMenu';
import { CustomizeSection } from '../CustomizeSection';
import { PluginsDiscoveryList } from '../PluginsDiscoveryList';
import {
  displayVersion,
  updateActionLabel,
  updateMarkerLabel,
} from '../UpdateMarker';
import type { UnifiedPluginEntry } from '../../lib/unified-plugin-entry';
import {
  REPLAY_BLOCK_CLASS,
  REPLAY_MASK_CLASS,
} from '../../lib/replay-privacy';
import { CUSTOMIZE_ROW_GRID_CLASS } from '../../lib/customize-grid';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

function makeEntry(
  overrides: Partial<UnifiedPluginEntry> = {},
): UnifiedPluginEntry {
  return {
    id: 'skill:github:repo/alpha',
    kind: 'skill',
    origin: 'installed-standalone',
    name: 'Alpha',
    description: 'An alpha skill.',
    categories: [],
    components: { skills: 1, mcpServers: 0, commands: 0, agents: 0 },
    providerSupport: { claude: true, codex: true },
    state: 'installed',
    recommended: false,
    ref: { type: 'skill', sourceId: 'github:repo', skillName: 'alpha' },
    ...overrides,
  };
}

describe('Customize section primitives', () => {
  let container: HTMLElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function q(testId: string): HTMLElement | null {
    return document.querySelector<HTMLElement>(`[data-testid="${testId}"]`);
  }

  it.each(['installed', 'updates', 'shared-by-me', 'browse', 'search'])(
    'CAN-4847 keeps compact source/version metadata and aligned controls in %s',
    (sectionId) => {
      const item = makeEntry({
        origin: 'marketplace',
        sourceLabel: 'Anthropic',
        version: '0.12.0',
        typeLabel: 'Skill',
      });
      act(() =>
        root.render(
          <ul>
            <CustomizeInstalledRow
              entry={item}
              sectionId={sectionId}
              showEntryType
              onSelect={() => {}}
              status={<button>Status</button>}
              actions={<button>Update</button>}
              menuItems={[
                { id: 'share', label: 'Share…', onSelect: (): void => {} },
              ]}
            />
          </ul>,
        ),
      );
      const subtitle = q(`customize-row-subtitle-${item.id}`);
      expect(subtitle?.textContent?.replace(/·/g, ' · ')).toBe(
        'Anthropic · v0.12.0',
      );
      expect(subtitle?.textContent).not.toContain('Skill');
      const row = q(`customize-${sectionId}-row-${item.id}`);
      const controls = Array.from(row?.querySelectorAll('button') ?? []).map(
        (node) => node.textContent,
      );
      expect(controls.slice(1, 3)).toEqual(['Status', 'Update']);
      expect(q(`customize-row-share-${item.id}`)).toBeNull();
      act(() => q(`customize-row-menu-${item.id}`)?.click());
      expect(q(`customize-row-menu-${item.id}-share`)?.textContent).toBe(
        'Share…',
      );
    },
  );

  it('CAN-4847 reserves the Update slot even when no update is available', () => {
    const item = makeEntry();
    const show = (actions?: React.ReactNode): void => {
      act(() =>
        root.render(
          <ul>
            <CustomizeInstalledRow
              entry={item}
              sectionId="installed"
              onSelect={() => {}}
              status={<button>Status</button>}
              actions={actions}
              menuItems={[
                { id: 'view', label: 'Open details', onSelect: (): void => {} },
              ]}
            />
          </ul>,
        ),
      );
    };
    show(<button>Update</button>);
    const slot = q(
      `customize-installed-row-${item.id}`,
    )?.lastElementChild?.children.item(1);
    expect(slot?.textContent).toBe('Update');
    show();
    expect(
      q(`customize-installed-row-${item.id}`)?.lastElementChild?.children.item(
        1,
      ),
    ).toBe(slot);
    expect(slot?.textContent).toBe('');
    expect(slot?.classList.contains('w-7')).toBe(true);
  });

  it.each([
    'skill',
    'plugin',
    'app',
    'agent',
    'pipeline',
    'collection',
  ] as const)(
    'CAN-4847 shows content counts only for collections, kind %s',
    (kind) => {
      const item = makeEntry({
        kind,
        origin: 'shared',
        authorName: 'Priya Shah',
        components: {
          skills: 2,
          plugins: 1,
          mcpServers: 0,
          commands: 0,
          agents: 0,
        },
      });
      act(() =>
        root.render(
          <ul>
            <CustomizeInstalledRow
              entry={item}
              sectionId="installed"
              onSelect={() => {}}
            />
          </ul>,
        ),
      );
      const subtitle = q(`customize-row-subtitle-${item.id}`);
      expect(subtitle?.textContent).toBe(
        kind === 'collection' ? 'Priya Shah·11 plugin22 skills' : 'Priya Shah',
      );
      expect(subtitle?.querySelectorAll('svg').length).toBe(
        kind === 'collection' ? 2 : 0,
      );
    },
  );

  it.each([
    {
      custom: true,
      expected: 'You',
      tooltip: 'Created by you · shared to Design',
    },
    {
      custom: false,
      expected: 'Priya Shah',
      tooltip: 'Created by Priya Shah · shared to Design',
    },
  ])(
    'CAN-4847 shows creator and scope on hover: $expected',
    ({ custom, expected, tooltip }) => {
      const item = makeEntry({
        custom,
        authorName: 'Priya Shah',
        sharedWith: { audience: 'team', name: 'Design' },
      });
      act(() =>
        root.render(
          <ul>
            <CustomizeInstalledRow
              entry={item}
              sectionId="installed"
              onSelect={() => {}}
            />
          </ul>,
        ),
      );
      const subtitle = q(`customize-row-subtitle-${item.id}`);
      expect(subtitle?.textContent).toBe(expected);
      void act(() =>
        subtitle
          ?.querySelector('span')
          ?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })),
      );
      expect(document.querySelector('[role="tooltip"]')?.textContent).toBe(
        tooltip,
      );
      expect(
        document
          .querySelector('[role="tooltip"]')
          ?.querySelector(`.${REPLAY_BLOCK_CLASS}`),
      ).not.toBeNull();
      expect(
        q(`customize-row-${item.id}`)?.querySelector('[tabindex="0"]'),
      ).toBeNull();
      expect(
        q(`customize-row-${item.id}`)?.getAttribute('aria-describedby'),
      ).toBeTruthy();
      expect(q(`customize-row-custom-${item.id}`) !== null).toBe(custom);
      expect(subtitle?.textContent).not.toContain('Created by you');
    },
  );

  it.each(['2026-10-10T12:00:00.000Z', 'invalid'])(
    'CAN-4847 formats valid edited dates and omits invalid dates: %s',
    (editedAt) => {
      const item = makeEntry({
        custom: true,
        editedAt,
        collectionProvenanceUnknown: true,
      });
      act(() =>
        root.render(
          <ul>
            <CustomizeInstalledRow
              entry={item}
              sectionId="installed"
              onSelect={() => {}}
            />
          </ul>,
        ),
      );
      const source = q(`customize-row-source-${item.id}`);
      void act(() =>
        source?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })),
      );
      const tooltip = document.querySelector('[role="tooltip"]');
      expect(tooltip?.textContent).not.toContain(editedAt);
      if (editedAt !== 'invalid')
        expect(tooltip?.textContent).toContain('Edited Oct 10, 2026');
      else expect(tooltip?.textContent).not.toContain('Edited');
      expect(
        q(`customize-row-subtitle-${item.id}`)?.classList.contains(
          REPLAY_BLOCK_CLASS,
        ),
      ).toBe(true);
    },
  );

  it('normalizes versions and never fabricates a latest version', () => {
    expect(displayVersion('1.2.0')).toBe('v1.2.0');
    expect(displayVersion('v1.2.0')).toBe('v1.2.0');
    expect(displayVersion('  ')).toBeNull();
    expect(displayVersion(undefined)).toBeNull();
    expect(updateMarkerLabel('V1.3.0')).toBe('Update available: v1.3.0');
    expect(updateMarkerLabel()).toBe('Update available');
    expect(updateActionLabel('2.1.0')).toBe('Update to v2.1.0');
    expect(updateActionLabel('v2.1.0')).toBe('Update to v2.1.0');
    expect(updateActionLabel()).toBe('Update');
  });

  it('renders a headed section with a count and a stable id', () => {
    act(() =>
      root.render(
        <CustomizeSection
          domId="customize-section-installed"
          title="Installed"
          count={3}
        >
          <p>rows</p>
        </CustomizeSection>,
      ),
    );
    const section = q('customize-section-installed');
    expect(section?.id).toBe('customize-section-installed');
    expect(section?.getAttribute('aria-labelledby')).toBe(
      'customize-section-installed-heading',
    );
    expect(q('customize-section-installed-count')?.textContent).toBe('3');
  });

  it('reads Created by you on a local agent and blocks only shared lines from replay', () => {
    // CAN-4840: the second line names the source, never the instructions,
    // so only a sharer's name is blocked from session replay.
    const agent = makeEntry({
      id: 'agent:local:private',
      kind: 'agent',
      name: 'Private agent',
      description: 'Private instructions for this agent.',
      ref: { type: 'local-agent', agentId: 'private' },
    });
    const shared = makeEntry({
      id: 'skill:shared:s1',
      origin: 'shared',
      authorName: 'Dana Smith',
      ref: { type: 'shared-skill', skillId: 's1' },
    });
    act(() =>
      root.render(
        <ul>
          <CustomizeInstalledRow
            entry={agent}
            sectionId="installed"
            onSelect={() => {}}
          />
          <CustomizeInstalledRow
            entry={shared}
            sectionId="installed"
            onSelect={() => {}}
          />
        </ul>,
      ),
    );
    const subtitle = q(`customize-row-subtitle-${agent.id}`);
    expect(subtitle?.textContent).toBe('You');
    expect(subtitle?.classList.contains(REPLAY_BLOCK_CLASS)).toBe(false);
    expect(container.textContent).not.toContain('Private instructions');
    const sharedLine = q(`customize-row-subtitle-${shared.id}`);
    expect(sharedLine?.textContent).toBe('Dana Smith');
    expect(sharedLine?.classList.contains(REPLAY_BLOCK_CLASS)).toBe(true);
    expect(
      sharedLine?.parentElement?.closest(`.${REPLAY_BLOCK_CLASS}`),
    ).toBeNull();
  });

  it('blocks the sharer on a receipted copy from replay (CAN-5223)', () => {
    const copy = makeEntry({
      id: 'skill:custom:app:review-helper',
      custom: true,
      editedAt: '2026-10-10T12:00:00.000Z',
      installedFrom: {
        sharedByName: 'Ada',
        ownerName: 'Northwind',
        teamName: 'Design',
      },
      ref: {
        type: 'skill',
        sourceId: 'custom:app',
        skillName: 'review-helper',
      },
    });
    act(() =>
      root.render(
        <ul>
          <CustomizeInstalledRow
            entry={copy}
            sectionId="installed"
            onSelect={() => {}}
          />
        </ul>,
      ),
    );
    const line = q(`customize-row-subtitle-${copy.id}`);
    expect(line?.textContent).toBe('Ada');
    expect(q(`customize-row-custom-${copy.id}`)).toBeNull();
    expect(line?.classList.contains(REPLAY_BLOCK_CLASS)).toBe(true);
    const description = document.getElementById(
      q(`customize-row-${copy.id}`)?.getAttribute('aria-describedby') ?? '',
    );
    expect(description?.textContent).toContain('Northwind');
    expect(description?.textContent).toContain('Design');
    expect(description?.classList.contains(REPLAY_BLOCK_CLASS)).toBe(true);
  });

  it('names the source on the second line, or the description without one', () => {
    const plugin = makeEntry({
      id: 'mkt:claude/slack',
      kind: 'plugin',
      origin: 'marketplace',
      name: 'Slack',
      description: 'Long description of the Slack plugin.',
      sourceLabel: 'Claude · slackapi',
      ref: {
        type: 'marketplace-plugin',
        marketplaceId: 'claude',
        pluginName: 'slack',
      },
    });
    const custom = makeEntry({
      id: 'skill:custom:app:review',
      custom: true,
      ref: { type: 'skill', sourceId: 'custom:app', skillName: 'review' },
    });
    act(() =>
      root.render(
        <ul>
          <CustomizeInstalledRow
            entry={plugin}
            sectionId="installed"
            onSelect={() => {}}
          />
          <CustomizeInstalledRow
            entry={custom}
            sectionId="installed"
            onSelect={() => {}}
          />
        </ul>,
      ),
    );
    // CAN-5050: the catalog appears once, on metadata instead of competing
    // with the name. The copy helper supplies the same source on both hosts.
    expect(q(`customize-row-source-${plugin.id}`)?.textContent).toBe(
      'Claude · slackapi',
    );
    expect(
      q(`customize-row-${plugin.id}`)?.textContent?.split('Claude · slackapi')
        .length,
    ).toBe(2);
    expect(q(`customize-row-subtitle-${plugin.id}`)?.textContent).toBe(
      'Claude · slackapi',
    );
    expect(
      q(`customize-row-subtitle-${plugin.id}`)?.contains(
        q(`customize-row-source-${plugin.id}`),
      ),
    ).toBe(true);
    expect(q(`customize-row-name-line-${plugin.id}`)?.textContent).toBe(
      'Slack',
    );
    expect(q(`customize-row-subtitle-${custom.id}`)?.textContent).toBe('You');
  });

  it.each([
    'Demo Plugin',
    'A very long plugin name that must truncate naturally',
  ])('keeps catalog metadata out of the inline name and type: %s', (name) => {
    const entry = makeEntry({
      kind: 'plugin',
      origin: 'marketplace',
      name,
      typeLabel: 'Plugin',
      sourceLabel: 'Claude · Demo Market',
      surface: 'desktop',
      ref: {
        type: 'marketplace-plugin',
        marketplaceId: 'demo',
        pluginName: 'demo',
      },
    });
    act(() =>
      root.render(
        <ul>
          <CustomizeInstalledRow
            entry={entry}
            sectionId="installed"
            showEntryType
            onSelect={() => {}}
          />
        </ul>,
      ),
    );
    const title = q(`customize-row-name-line-${entry.id}`);
    expect(title?.textContent).toBe(`${name}PluginDesktop only`);
    expect(title?.firstElementChild?.textContent).toBe(name);
    expect(title?.firstElementChild?.classList.contains('truncate')).toBe(true);
    expect(title?.firstElementChild?.classList.contains('min-w-0')).toBe(true);
    expect(title?.classList.contains('flex-wrap')).toBe(false);
    expect(
      q(`customize-row-type-${entry.id}`)?.classList.contains('fg-tertiary'),
    ).toBe(true);
    expect(q(`customize-row-subtitle-${entry.id}`)?.textContent).toBe(
      'Claude · Demo Market',
    );
  });

  it('reads the share audience and date on a Shared by me row', () => {
    const entry = makeEntry({
      id: 'skill:shared:s1',
      origin: 'shared',
      authorName: 'Dana Smith',
      sharedWith: { audience: 'organization', name: 'Northwind' },
      sharedSince: '2026-10-12T00:00:00Z',
      ref: { type: 'shared-skill', skillId: 's1' },
    });
    act(() =>
      root.render(
        <ul>
          <CustomizeInstalledRow
            entry={entry}
            sectionId="shared-by-me"
            onSelect={() => {}}
          />
        </ul>,
      ),
    );
    const line = q(`customize-row-subtitle-${entry.id}`);
    expect(line?.textContent).toBe('Dana Smith');
    expect(line?.textContent).not.toContain('Organization');
    expect(line?.textContent).not.toContain('Shared by');
    expect(line?.classList.contains(REPLAY_BLOCK_CLASS)).toBe(true);
    expect(q(`customize-row-public-link-${entry.id}`)).toBeNull();
  });

  it('CAN-4847 keeps scope and public-link facts in the creator tooltip and updates them on refresh', () => {
    const item = makeEntry({
      origin: 'shared',
      authorName: 'Priya Shah',
      sharedWith: { audience: 'organization', name: 'Northwind' },
      publicShare: {},
    });
    const show = (entry: UnifiedPluginEntry): void => {
      act(() =>
        root.render(
          <ul>
            <CustomizeInstalledRow
              entry={entry}
              sectionId="shared-by-me"
              onSelect={() => {}}
            />
          </ul>,
        ),
      );
    };
    show(item);
    expect(q(`customize-row-subtitle-${item.id}`)?.textContent).toBe(
      'Priya Shah',
    );
    const source = q(`customize-row-source-${item.id}`);
    void act(() =>
      source?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })),
    );
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe(
      'Created by Priya Shah · shared to Northwind · Public link',
    );
    void act(() =>
      source?.dispatchEvent(new MouseEvent('mouseout', { bubbles: true })),
    );
    show({ ...item, publicShare: undefined });
    void act(() =>
      source?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })),
    );
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe(
      'Created by Priya Shah · shared to Northwind',
    );
    expect(q(`customize-row-public-link-${item.id}`)).toBeNull();
  });

  it('shows pending sign-ins as a sibling chip that connects', () => {
    const onSelect = jest.fn();
    const onConnect = jest.fn();
    const entry = makeEntry({
      id: 'mcp-local:github',
      kind: 'app',
      name: 'GitHub',
      state: 'needs-auth',
      pendingSignIns: 2,
      ref: { type: 'local-mcp', serverId: 'github' },
    });
    act(() =>
      root.render(
        <ul>
          <CustomizeInstalledRow
            entry={entry}
            sectionId="installed"
            onSelect={onSelect}
            onConnect={onConnect}
          />
        </ul>,
      ),
    );
    const chip = q(`customize-row-sign-in-${entry.id}`);
    expect(chip?.tagName).toBe('BUTTON');
    expect(chip?.textContent).toBe('2 sign-ins pending');
    expect(chip?.getAttribute('aria-label')).toBe(
      '2 sign-ins pending. Connect GitHub',
    );
    expect(q(`customize-row-${entry.id}`)?.contains(chip ?? null)).toBe(false);
    expect(container.textContent).not.toContain('Needs attention');
    act(() => chip?.click());
    expect(onConnect).toHaveBeenCalledWith(entry);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('shows a plain chip without onConnect', () => {
    const entry = makeEntry({
      id: 'mcp-local:github',
      kind: 'app',
      state: 'needs-auth',
      pendingSignIns: 1,
      ref: { type: 'local-mcp', serverId: 'github' },
    });
    act(() =>
      root.render(
        <ul>
          <CustomizeInstalledRow
            entry={entry}
            sectionId="installed"
            onSelect={() => {}}
          />
        </ul>,
      ),
    );
    const chip = q(`customize-row-sign-in-${entry.id}`);
    expect(chip?.tagName).toBe('SPAN');
    expect(chip?.textContent).toBe('1 sign-in pending');
  });

  it('keeps Needs attention for a problem that is not a pending sign-in', () => {
    // An auth error, or a plugin with nothing to run against, needs-auth
    // without a sign-in to wait for; it never reads "sign-in pending".
    const onConnect = jest.fn();
    const entry = makeEntry({
      id: 'mcp-local:broken',
      kind: 'app',
      name: 'Broken',
      state: 'needs-auth',
      ref: { type: 'local-mcp', serverId: 'broken' },
    });
    act(() =>
      root.render(
        <ul>
          <CustomizeInstalledRow
            entry={entry}
            sectionId="installed"
            onSelect={() => {}}
            onConnect={onConnect}
          />
        </ul>,
      ),
    );
    const chip = q(`customize-row-sign-in-${entry.id}`);
    expect(chip?.textContent).toBe('Needs attention');
    expect(chip?.getAttribute('aria-label')).toBe(
      'Needs attention. Connect Broken',
    );
    expect(container.textContent).not.toContain('sign-in pending');
    act(() => chip?.click());
    expect(onConnect).toHaveBeenCalledWith(entry);
  });

  it.each([
    ['with', true],
    ['without', false],
  ])(
    'draws attention as one marker-sized warning badge %s a connect action, and drops the duplicate Auth required badge',
    (_label, connectable) => {
      const entry = makeEntry({
        id: 'mcp-local:notion',
        kind: 'app',
        name: 'Notion',
        state: 'needs-auth',
        connection: { status: 'auth_required' },
        ref: { type: 'local-mcp', serverId: 'notion' },
      });
      act(() =>
        root.render(
          <ul>
            <CustomizeInstalledRow
              entry={entry}
              sectionId="installed"
              onSelect={() => {}}
              onConnect={connectable ? jest.fn() : undefined}
            />
          </ul>,
        ),
      );
      const markers = container.querySelectorAll('[data-badge-tone="warning"]');
      expect(markers).toHaveLength(1);
      expect(markers[0]?.textContent).toBe('Needs attention');
      // A marker, never the 28px warning button capsule.
      const chip = q(`customize-row-sign-in-${entry.id}`);
      expect(chip?.className).not.toMatch(/\bh-7\b/);
      // The attention marker already says it; no second status beside it.
      expect(q(`plugins-connection-status-${entry.id}`)).toBeNull();
      expect(container.textContent).not.toContain('Auth required');
      // The name column keeps room before the trailing markers take it.
      expect(q(`customize-row-${entry.id}`)?.className).toContain('min-w-32');
    },
  );

  it('shows a plugin’s bundled sign-ins as a chip that connects through the host', () => {
    const onConnect = jest.fn();
    const entry = makeEntry({
      id: 'mkt:community/slack',
      state: 'installed',
      pendingSignIns: 2,
      ref: {
        type: 'marketplace-plugin',
        marketplaceId: 'community',
        pluginName: 'slack',
      },
    });
    act(() =>
      root.render(
        <ul>
          <CustomizeInstalledRow
            entry={entry}
            sectionId="installed"
            onSelect={() => {}}
            onConnect={onConnect}
          />
        </ul>,
      ),
    );
    const chip = q(`customize-row-sign-in-${entry.id}`);
    // The host resolves which bundled server the chip signs in to.
    expect(chip?.tagName).toBe('BUTTON');
    expect(chip?.textContent).toBe('2 sign-ins pending');
    act(() => chip?.click());
    expect(onConnect).toHaveBeenCalledWith(entry);
  });

  it('never shows an update dot on capability rows, with or without version metadata', () => {
    act(() =>
      root.render(
        <ul>
          <CustomizeInstalledRow
            entry={makeEntry({ id: 'a', updateAvailable: true })}
            sectionId="updates"
            onSelect={() => {}}
          />
          <CustomizeInstalledRow
            entry={makeEntry({
              id: 'b',
              updateAvailable: true,
              latestVersion: '1.3.0',
            })}
            sectionId="updates"
            onSelect={() => {}}
          />
        </ul>,
      ),
    );
    expect(q('customize-row-update-marker-a')).toBeNull();
    expect(q('customize-row-update-marker-b')).toBeNull();
  });

  describe('CAN-4847 compact workflow metadata', () => {
    function renderWorkflow(workflow: UnifiedPluginEntry['workflow']): void {
      const item = makeEntry({
        kind: 'pipeline',
        origin: 'curated',
        ref: { type: 'pipeline', pipelineId: 'flow', source: 'user' },
        workflow,
      });
      act(() =>
        root.render(
          <ul>
            <CustomizeInstalledRow
              entry={item}
              sectionId="installed"
              onSelect={() => {}}
            />
          </ul>,
        ),
      );
    }
    it.each(['Manual', 'Plan approval', 'Task ready'])(
      'shows the %s trigger without repeating its type',
      (label) => {
        renderWorkflow({
          triggers: [{ kind: 'manual', label, explainer: 'Runs on demand' }],
        });
        expect(
          q('customize-row-subtitle-skill:github:repo/alpha')?.textContent,
        ).toBe(label);
        expect(
          q('customize-row-subtitle-skill:github:repo/alpha')?.querySelector(
            'svg',
          ),
        ).toBeNull();
      },
    );
    it('summarizes multiple triggers and exposes details to assistive technology without nested tab stops', () => {
      renderWorkflow({
        sourceText: 'Shared by Platform',
        triggers: [
          { kind: 'manual', label: 'Manual', explainer: 'Runs on demand' },
          {
            kind: 'plan-approved',
            label: 'Plan approval',
            explainer: 'Runs after approval',
          },
        ],
        stepCount: 4,
        lastRun: { state: 'failure', at: 1, errorMessage: 'Tests failed' },
      });
      expect(
        q('customize-row-subtitle-skill:github:repo/alpha')?.textContent,
      ).toBe('Platform·2 triggers');
      const trigger = q('customize-row-trigger-skill:github:repo/alpha');
      act(() => {
        document.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }),
        );
        q('customize-row-skill:github:repo/alpha')?.focus();
      });
      const primary = q('customize-row-skill:github:repo/alpha');
      expect(primary?.querySelector('[tabindex="0"]')).toBeNull();
      const tooltip = document.getElementById(
        primary?.getAttribute('aria-describedby') ?? '',
      );
      expect(tooltip?.textContent).toContain('Manual: Runs on demand');
      expect(tooltip?.textContent).toContain(
        'Plan approval: Runs after approval',
      );
      expect(tooltip?.textContent).toContain('4 steps');
      expect(tooltip?.textContent).toContain('Last run: failure: Tests failed');
      void act(() =>
        trigger?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })),
      );
      expect(
        document
          .querySelector('[role="tooltip"]')
          ?.querySelector(`.${REPLAY_BLOCK_CLASS}`),
      ).not.toBeNull();
    });
    it('shows the schedule and explains it in its tooltip', () => {
      renderWorkflow({
        schedule: {
          label: 'Weekdays · 09:00',
          tooltip: 'Every weekday at 09:00',
        },
      });
      const trigger = q('customize-row-trigger-skill:github:repo/alpha');
      expect(trigger?.textContent).toBe('Weekdays · 09:00');
      void act(() =>
        trigger?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })),
      );
      expect(document.querySelector('[role="tooltip"]')?.textContent).toBe(
        'Every weekday at 09:00',
      );
    });
    it('protects a person named in the workflow source from replay', () => {
      renderWorkflow({
        sourceText: 'Shared by Ada',
        sourceIsPerson: true,
        triggerText: 'Manual',
      });
      const subtitle = q('customize-row-subtitle-skill:github:repo/alpha');
      expect(subtitle?.textContent).toBe('Ada·Manual');
      expect(subtitle?.classList.contains(REPLAY_MASK_CLASS)).toBe(true);
    });
    it('omits descriptive prose and absent last-run facts from the row', () => {
      renderWorkflow(undefined);
      expect(
        q('customize-row-subtitle-skill:github:repo/alpha')?.textContent,
      ).toBe('');
      expect(container.textContent).not.toContain('An alpha skill.');
      expect(
        container.querySelector('[data-testid^="customize-row-last-run-"]'),
      ).toBeNull();
    });
  });

  it('shows only real installation harnesses and version', () => {
    act(() =>
      root.render(
        <ul>
          <CustomizeInstalledRow
            entry={makeEntry({
              version: '1.2.0',
              updateAvailable: true,
              latestVersion: '1.3.0',
              installedHarnesses: { claude: true, codex: false },
            })}
            sectionId="installed"
            onSelect={() => {}}
          />
        </ul>,
      ),
    );
    const id = 'skill:github:repo/alpha';
    expect(q(`customize-row-version-${id}`)?.textContent).toContain('v1.2.0');
    expect(q(`customize-row-update-marker-${id}`)).toBeNull();
    const harnesses = q(`customize-row-harnesses-${id}`);
    expect(
      harnesses?.querySelector('[aria-label="Installed for Claude"]'),
    ).not.toBeNull();
    expect(
      harnesses?.querySelector('[aria-label="Installed for Codex"]'),
    ).toBeNull();
  });

  it('preserves cached MCP connection health in an Installed row', () => {
    act(() =>
      root.render(
        <ul>
          <CustomizeInstalledRow
            entry={makeEntry({
              id: 'mcp-local:fixture',
              kind: 'app',
              ref: { type: 'local-mcp', serverId: 'fixture' },
              components: { skills: 0, mcpServers: 1, commands: 0, agents: 0 },
              connection: { status: 'unreachable' },
            })}
            sectionId="installed"
            onSelect={() => {}}
          />
        </ul>,
      ),
    );
    expect(q('plugins-connection-status-mcp-local:fixture')?.textContent).toBe(
      'Unreachable',
    );
  });

  it('dims a Disabled row content and version while its controls keep full ink (CAN-4838)', () => {
    const entry = makeEntry({
      version: '1.0.0',
      updateAvailable: true,
      latestVersion: '1.1.0',
    });
    const id = entry.id;
    act(() =>
      root.render(
        <ul>
          <CustomizeInstalledRow
            entry={entry}
            sectionId="installed"
            onSelect={() => {}}
            dimmed
          />
        </ul>,
      ),
    );
    expect(
      q(`customize-installed-row-${id}`)?.getAttribute('data-dimmed'),
    ).toBe('true');
    expect(q(`customize-row-content-${id}`)?.className).toContain('opacity-60');
    expect(
      q(`customize-row-version-${id}`)?.closest(
        '[data-testid^="customize-row-content-"]',
      )?.className,
    ).toContain('opacity-60');
    // Controls keep full ink; the row has no separate update marker.
    expect(q(`customize-row-version-${id}`)?.className).not.toContain(
      'opacity-60',
    );
    expect(
      q(`customize-row-update-marker-${id}`)?.className ?? '',
    ).not.toContain('opacity-60');
    // The focus ring lives on the control, so the control stays full ink.
    expect(q(`customize-row-${id}`)?.className).not.toContain('opacity-60');
    expect(q(`customize-row-menu-${id}`)?.className ?? '').not.toContain(
      'opacity-60',
    );
    act(() =>
      root.render(
        <ul>
          <CustomizeInstalledRow
            entry={entry}
            sectionId="installed"
            onSelect={() => {}}
          />
        </ul>,
      ),
    );
    expect(
      q(`customize-installed-row-${id}`)?.hasAttribute('data-dimmed'),
    ).toBe(false);
    expect(q(`customize-row-content-${id}`)?.className).not.toContain(
      'opacity-60',
    );
  });

  it('omits the harness and version columns when the data is absent', () => {
    act(() =>
      root.render(
        <ul>
          <CustomizeInstalledRow
            entry={makeEntry()}
            sectionId="installed"
            onSelect={() => {}}
          />
        </ul>,
      ),
    );
    expect(q('customize-row-harnesses-skill:github:repo/alpha')).toBeNull();
    expect(q('customize-row-version-skill:github:repo/alpha')).toBeNull();
  });

  it('shows an installed plugin row its source as plain text', () => {
    const plugin = makeEntry({
      id: 'mkt:openai-curated/slack',
      kind: 'plugin',
      origin: 'marketplace',
      name: 'Slack',
      typeLabel: 'Plugin',
      sourceLabel: 'Codex official',
      ref: {
        type: 'marketplace-plugin',
        marketplaceId: 'openai-curated',
        pluginName: 'slack',
      },
    });
    const server = makeEntry({
      id: 'mcp-local:team-notes',
      kind: 'app',
      name: 'Team notes MCP',
      sourceLabel: 'Local',
      ref: { type: 'local-mcp', serverId: 'team-notes' },
    });
    act(() =>
      root.render(
        <ul>
          <CustomizeInstalledRow
            entry={plugin}
            sectionId="installed"
            showEntryType
            onSelect={() => {}}
          />
          <CustomizeInstalledRow
            entry={server}
            sectionId="installed"
            showEntryType
            onSelect={() => {}}
          />
        </ul>,
      ),
    );
    const source = q('customize-row-source-mkt:openai-curated/slack');
    expect(source?.textContent).toBe('Codex official');
    expect(
      q('customize-row-subtitle-mkt:openai-curated/slack')?.className,
    ).toContain('fg-tertiary');
    expect(q('customize-row-source-mcp-local:team-notes')).toBeNull();
  });

  it('names the plugin a bundled server row came from', () => {
    act(() =>
      root.render(
        <ul>
          <CustomizeInstalledRow
            entry={makeEntry({
              id: 'mcp-local:slack',
              kind: 'app',
              name: 'Slack',
              description: 'Team chat',
              ref: { type: 'local-mcp', serverId: 'slack' },
              bundledBy: { entryId: 'mkt:openai-curated/slack', name: 'Slack' },
            })}
            sectionId="installed"
            href="/entries/slack"
            onSelect={() => {}}
          />
        </ul>,
      ),
    );
    const from = q('customize-row-from-plugin-mcp-local:slack');
    expect(from?.tagName).toBe('SPAN');
    expect(from?.textContent).toBe('From Slack');
    expect(q('customize-row-subtitle-mcp-local:slack')?.textContent).toBe(
      'From Slack',
    );
    expect(container.querySelector('a button')).toBeNull();
  });

  it('keeps row actions from opening details and DOM ids unique per section', () => {
    const onSelect = jest.fn();
    const onDetails = jest.fn();
    const entry = makeEntry();
    act(() =>
      root.render(
        <ul>
          {['updates', 'installed'].map((sectionId) => (
            <CustomizeInstalledRow
              key={sectionId}
              entry={entry}
              sectionId={sectionId}
              onSelect={onSelect}
              menuItems={[
                { id: 'details', label: 'Open details', onSelect: onDetails },
              ]}
              actions={<button data-testid={`action-${sectionId}`}>Go</button>}
            />
          ))}
        </ul>,
      ),
    );
    const ids = Array.from(document.querySelectorAll('[id]')).map(
      (node) => node.id,
    );
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain(customizeRowDomId('installed', entry.id));
    act(() => q('action-installed')?.click());
    expect(onSelect).not.toHaveBeenCalled();
    const row = document.querySelector(
      '[data-testid="customize-installed-row-skill:github:repo/alpha"]',
    );
    // The primary control and menu trigger are siblings, not nested.
    expect(row?.querySelector('button button, a button')).toBeNull();
    act(() =>
      row
        ?.querySelector<HTMLElement>(
          '[data-testid="customize-row-menu-skill:github:repo/alpha"]',
        )
        ?.click(),
    );
    act(() =>
      document
        .querySelector<HTMLElement>(
          '[data-testid="customize-row-menu-skill:github:repo/alpha-details"]',
        )
        ?.click(),
    );
    expect(onDetails).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('routes plain link clicks through onSelect and leaves modifier clicks native', () => {
    const onSelect = jest.fn();
    act(() =>
      root.render(
        <ul>
          <CustomizeInstalledRow
            entry={makeEntry()}
            sectionId="installed"
            href="/portal/plugins/skills/alpha"
            onSelect={onSelect}
          />
        </ul>,
      ),
    );
    const link = q('customize-row-skill:github:repo/alpha');
    expect(link?.tagName).toBe('A');
    const modified = new MouseEvent('click', {
      bubbles: true,
      cancelable: true,
      metaKey: true,
    });
    act(() => {
      link?.dispatchEvent(modified);
    });
    expect(onSelect).not.toHaveBeenCalled();
    expect(modified.defaultPrevented).toBe(false);
    act(() => link?.click());
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it('renders no menu without items and puts destructive items after a divider', () => {
    act(() =>
      root.render(
        <CustomizeRowMenu
          entryName="Alpha"
          idPrefix="row"
          items={[]}
          testId="menu"
        />,
      ),
    );
    expect(q('menu')).toBeNull();
    act(() =>
      root.render(
        <CustomizeRowMenu
          entryName="Alpha"
          idPrefix="row"
          testId="menu"
          items={[
            {
              id: 'remove',
              label: 'Remove',
              onSelect: (): void => {},
              destructive: true,
            },
            { id: 'details', label: 'Open details', onSelect: (): void => {} },
          ]}
        />,
      ),
    );
    act(() => q('menu')?.click());
    const surface = q('menu-surface');
    const children = Array.from(
      surface?.querySelectorAll('[data-testid^="menu-"], [role="separator"]') ??
        [],
    );
    expect(
      children.map(
        (node) => node.getAttribute('data-testid') ?? node.getAttribute('role'),
      ),
    ).toEqual(['menu-details', 'separator', 'menu-remove']);
  });

  it.each([
    ['edit', 'Edit', 'Edit this skill in the desktop app.'],
    ['share', 'Share…', 'Sign in to share this skill.'],
  ])(
    'keeps a disabled %s action disabled when it has a reason',
    (id, label, reason) => {
      const onSelect = jest.fn();
      const onDetails = jest.fn();
      act(() =>
        root.render(
          <CustomizeRowMenu
            entryName="Alpha"
            idPrefix="row"
            testId="menu"
            items={[
              { id: 'details', label: 'Open details', onSelect: onDetails },
              { id, label, onSelect, disabled: true, disabledReason: reason },
            ]}
          />,
        ),
      );
      act(() => q('menu')?.click());
      const action = q(`menu-${id}`);
      expect(action?.matches(':disabled')).toBe(true);
      expect(action?.getAttribute('aria-disabled')).toBe('true');
      expect(action?.getAttribute('title')).toBe(reason);
      expect(action?.getAttribute('aria-description')).toBe(reason);
      act(() => action?.click());
      expect(onSelect).not.toHaveBeenCalled();
      expect(q('menu-surface')).not.toBeNull();
      expect(q('menu-details')?.matches(':disabled')).toBe(false);
      act(() => q('menu-details')?.click());
      expect(onDetails).toHaveBeenCalledTimes(1);
      expect(q('menu-surface')).toBeNull();
    },
  );

  it('dismisses the menu on Escape and returns focus to its trigger', () => {
    act(() =>
      root.render(
        <CustomizeRowMenu
          entryName="Alpha"
          idPrefix="row"
          testId="menu"
          items={[
            { id: 'details', label: 'Open details', onSelect: (): void => {} },
          ]}
        />,
      ),
    );
    const trigger = q('menu');
    act(() => trigger?.click());
    expect(q('menu-surface')).not.toBeNull();
    act(() => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    expect(q('menu-surface')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('keeps Installed and Browse on their existing two-column grid', () => {
    act(() =>
      root.render(
        <>
          <CustomizeInstalledList
            sectionId="installed"
            entries={[makeEntry()]}
            renderRow={(entry) => <li key={entry.id}>{entry.name}</li>}
          />
          <PluginsDiscoveryList
            sections={[
              {
                id: 'curated',
                title: 'Browse',
                entries: [makeEntry({ id: 'b' })],
              },
            ]}
            selectedEntryId={null}
            onSelectEntry={() => {}}
            emptyMessage="Nothing here."
          />
        </>,
      ),
    );
    for (const cls of CUSTOMIZE_ROW_GRID_CLASS.split(' ')) {
      expect(
        q('customize-section-installed-rows')?.classList.contains(cls),
      ).toBe(true);
      expect(q('plugins-section-body-curated')?.classList.contains(cls)).toBe(
        true,
      );
    }
  });

  // CAN-4840 QA: the name and its labels share one line. The name truncates
  // (its full text in `title`) without padding a short name, and the line
  // clips rather than spilling into the row's controls.
  it('keeps a neutral type icon inline while the name truncates in CSS', () => {
    act(() =>
      root.render(
        <ul>
          <CustomizeInstalledRow
            entry={makeEntry({ surface: 'cloud', typeLabel: 'Skill' })}
            sectionId="installed"
            showEntryType
            onSelect={() => {}}
          />
        </ul>,
      ),
    );
    const line = q('customize-row-name-line-skill:github:repo/alpha');
    // The name truncates on one line with its labels; nothing wraps under it.
    expect(line?.classList.contains('flex-wrap')).toBe(false);
    expect(line?.firstElementChild?.classList.contains('truncate')).toBe(true);
    expect(line?.firstElementChild?.classList.contains('min-w-0')).toBe(true);
    expect(line?.firstElementChild?.getAttribute('title')).toBe(
      'Alpha · An alpha skill.',
    );
    expect(line?.classList.contains('overflow-hidden')).toBe(true);
    const type = q('customize-row-type-skill:github:repo/alpha');
    expect(type?.classList.contains('fg-tertiary')).toBe(true);
    expect(type?.querySelectorAll('svg')).toHaveLength(1);
  });

  it('shows where an entry runs as an icon with a tooltip, not a pill', () => {
    act(() =>
      root.render(
        <ul>
          <CustomizeInstalledRow
            entry={makeEntry({ surface: 'desktop' })}
            sectionId="installed"
            showEntryType
            onSelect={() => {}}
          />
        </ul>,
      ),
    );
    const icon = q('plugins-surface-skill:github:repo/alpha');
    expect(icon?.querySelector('svg')).not.toBeNull();
    expect(icon?.className).not.toContain('rounded-full');
    // The label stays in the row's accessible name.
    expect(icon?.textContent).toBe('Desktop only');
    expect(icon?.closest('[data-testid^="customize-row-name-line-"]')).toBe(
      q('customize-row-name-line-skill:github:repo/alpha'),
    );
    // Hovering opens a tooltip naming the surface and saying why.
    jest.useFakeTimers();
    act(() => {
      icon?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    });
    act(() => jest.advanceTimersByTime(1_000));
    expect(document.querySelector('[role="tooltip"]')?.textContent).toBe(
      "Desktop only: runs on your desktop, so cloud chats can't use it",
    );
    jest.useRealTimers();
  });

  it('hides connection health that was never checked', () => {
    act(() =>
      root.render(
        <ul>
          <CustomizeInstalledRow
            entry={makeEntry({
              id: 'mcp-local:fixture',
              kind: 'app',
              connection: { status: 'unknown' },
            })}
            sectionId="installed"
            onSelect={() => {}}
          />
        </ul>,
      ),
    );
    expect(q('plugins-connection-status-mcp-local:fixture')).toBeNull();
  });

  it('previews rows and expands with Show all N', () => {
    const entries = Array.from({ length: 10 }, (_unused, index) =>
      makeEntry({ id: `skill:${index}`, name: `Skill ${index}` }),
    );
    const onShowAll = jest.fn();
    act(() =>
      root.render(
        <CustomizeInstalledList
          sectionId="installed"
          entries={entries}
          previewLimit={8}
          onShowAll={onShowAll}
          renderRow={(entry) => <li data-testid="row">{entry.name}</li>}
        />,
      ),
    );
    expect(document.querySelectorAll('[data-testid="row"]')).toHaveLength(8);
    const showAll = q('customize-section-installed-show-all');
    expect(showAll?.textContent).toBe('Show all 10');
    act(() => showAll?.click());
    expect(onShowAll).toHaveBeenCalledTimes(1);
    act(() =>
      root.render(
        <CustomizeInstalledList
          sectionId="installed"
          entries={entries}
          renderRow={(entry) => <li data-testid="row">{entry.name}</li>}
        />,
      ),
    );
    expect(document.querySelectorAll('[data-testid="row"]')).toHaveLength(10);
    expect(q('customize-section-installed-show-all')).toBeNull();
  });

  it('renders the gated Installed state with an optional host action', () => {
    act(() =>
      root.render(
        <CustomizeInstalledUnavailable
          title="Pair a desktop"
          body="Installed items live on your desktop."
        />,
      ),
    );
    expect(q('customize-installed-unavailable')?.textContent).toContain(
      'Pair a desktop',
    );
    expect(
      q('customize-installed-unavailable')?.querySelector('button'),
    ).toBeNull();
  });

  it('keeps Install exclusive to available Browse entries and preserves installed updates', () => {
    const entries = [
      makeEntry({
        id: 'a',
        name: 'A',
        state: 'installed',
        updateAvailable: true,
      }),
      makeEntry({ id: 'b', name: 'B', state: 'needs-auth' }),
      makeEntry({ id: 'c', name: 'C', state: 'available' }),
    ];
    const render = (): void =>
      act(() =>
        root.render(
          <PluginsDiscoveryList
            sections={[{ id: 'skills', title: '', entries }]}
            selectedEntryId={null}
            onSelectEntry={() => {}}
            onAddEntry={() => {}}
            emptyMessage="Empty"
          />,
        ),
      );
    render();
    expect(q('plugins-entry-installed-a')).toBeNull();
    expect(q('plugins-entry-installed-b')).toBeNull();
    expect(q('plugins-entry-add-a')).toBeNull();
    expect(q('plugins-entry-add-b')).toBeNull();
    expect(q('plugins-entry-add-c')).not.toBeNull();
    expect(q('plugins-update-available-a')).not.toBeNull();
  });
  describe('CAN-4844 — custom skill metadata', () => {
    function renderRow(entry: UnifiedPluginEntry): void {
      act(() =>
        root.render(
          <ul>
            <CustomizeInstalledRow
              entry={entry}
              sectionId="installed"
              onSelect={() => {}}
            />
          </ul>,
        ),
      );
    }

    it('overlays a filled custom badge on the avatar instead of after the name', () => {
      const custom = makeEntry({ custom: true, version: '1.2.0' });
      renderRow(custom);
      const marker = q(`customize-row-custom-${custom.id}`);
      expect(marker?.getAttribute('aria-label')).toBe('Custom skill');
      expect(q(`customize-row-name-line-${custom.id}`)?.contains(marker)).toBe(
        false,
      );
      expect(marker?.classList.contains('bg-fg-primary')).toBe(true);
      expect(marker?.classList.contains('size-4')).toBe(true);
      expect(marker?.classList.contains('ring-2')).toBe(true);
      expect(marker?.classList.contains('ring-[var(--bg-primary)]')).toBe(true);
      const overlay = marker?.parentElement?.parentElement;
      expect(overlay?.classList.contains('-bottom-1')).toBe(true);
      expect(overlay?.classList.contains('-right-1')).toBe(true);
      expect(
        overlay?.parentElement?.classList.contains('overflow-visible'),
      ).toBe(true);
      const glyph = marker?.querySelector('svg');
      expect(glyph?.getAttribute('data-icon-size')).toBe('exact');
      expect(glyph?.style.width).toBe('12px');
      expect(q(`customize-row-version-${custom.id}`)?.textContent).toBe(
        'v1.2.0',
      );
      act(() => {
        marker?.parentElement?.dispatchEvent(
          new MouseEvent('mouseover', { bubbles: true }),
        );
      });
      expect(document.querySelector('[role="tooltip"]')?.textContent).toBe(
        'Custom skill',
      );
      renderRow(makeEntry({ version: '1.2.0' }));
      expect(q('customize-row-custom-skill:github:repo/alpha')).toBeNull();
      expect(
        q('customize-row-version-skill:github:repo/alpha')?.textContent,
      ).toContain('v1.2.0');
    });

    it('keeps the known creator in the avatar badge and shows You instead of an age', () => {
      const author = 'Alexandra Montgomery';
      const custom = makeEntry({
        custom: true,
        authorName: author,
        editedAt: '2026-10-10T12:00:00Z',
      });
      renderRow(custom);
      const marker = q(`customize-row-custom-${custom.id}`);
      expect(marker?.getAttribute('aria-label')).toBe(
        `Custom skill by ${author}`,
      );
      expect(marker?.classList.contains(REPLAY_BLOCK_CLASS)).toBe(true);
      expect(q(`customize-row-subtitle-${custom.id}`)?.textContent).toBe('You');
      void act(() =>
        marker?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true })),
      );
      expect(document.querySelector('[role="tooltip"]')?.textContent).toBe(
        `Custom skill by ${author}`,
      );
    });

    it.each([undefined, 'invalid', ''])(
      'omits subtitle for missing/invalid updated time %p without inventing an author',
      (editedAt) => {
        const custom = makeEntry({ custom: true, editedAt });
        renderRow(custom);
        expect(q(`customize-row-creator-${custom.id}`)).toBeNull();
        expect(q(`customize-row-subtitle-${custom.id}`)?.textContent).toBe(
          'You',
        );
        expect(
          q(`customize-row-custom-${custom.id}`)?.getAttribute('aria-label'),
        ).toBe('Custom skill');
      },
    );

    it('uses the same typography tokens for Updated, Built-in and plugin subtitles', () => {
      const custom = makeEntry({
        id: 'custom',
        custom: true,
        editedAt: new Date().toISOString(),
      });
      const builtin = makeEntry({ id: 'builtin', origin: 'built-in' });
      const bundled = makeEntry({
        id: 'bundled',
        bundledBy: { entryId: 'plugin', name: 'Release Toolkit' },
      });
      act(() =>
        root.render(
          <ul>
            {[custom, builtin, bundled].map((entry) => (
              <CustomizeInstalledRow
                key={entry.id}
                entry={entry}
                sectionId="installed"
                onSelect={() => {}}
              />
            ))}
          </ul>,
        ),
      );
      for (const subtitle of [
        q('customize-row-subtitle-custom'),
        q('customize-row-subtitle-builtin'),
        q('customize-row-subtitle-bundled'),
      ]) {
        expect(subtitle?.classList.contains('text-xs')).toBe(true);
        expect(subtitle?.classList.contains('fg-tertiary')).toBe(true);
        expect(subtitle?.className).not.toMatch(
          /font-(?:medium|semibold|bold)/,
        );
      }
    });
  });
});
