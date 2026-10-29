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
import { displayVersion, updateMarkerLabel } from '../UpdateMarker';
import type { UnifiedPluginEntry } from '../../lib/unified-plugin-entry';
import { REPLAY_BLOCK_CLASS } from '../../lib/replay-privacy';
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

  it('normalizes versions and never fabricates a latest version', () => {
    expect(displayVersion('1.2.0')).toBe('v1.2.0');
    expect(displayVersion('v1.2.0')).toBe('v1.2.0');
    expect(displayVersion('  ')).toBeNull();
    expect(displayVersion(undefined)).toBeNull();
    expect(updateMarkerLabel('V1.3.0')).toBe('Update available: v1.3.0');
    expect(updateMarkerLabel()).toBe('Update available');
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

  it('blocks a local agent instruction subtitle from replay, and only that', () => {
    // CAN-4261: a local agent's description is the first line of its
    // instructions, as on the discovery cards.
    const agent = makeEntry({
      id: 'agent:local:private',
      kind: 'agent',
      name: 'Private agent',
      description: 'Private instructions for this agent.',
      ref: { type: 'local-agent', agentId: 'private' },
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
            entry={makeEntry()}
            sectionId="installed"
            onSelect={() => {}}
          />
        </ul>,
      ),
    );
    const subtitle = q(`customize-row-subtitle-${agent.id}`);
    expect(subtitle?.textContent).toBe('Private instructions for this agent.');
    expect(subtitle?.classList.contains(REPLAY_BLOCK_CLASS)).toBe(true);
    expect(
      subtitle?.parentElement?.closest(`.${REPLAY_BLOCK_CLASS}`),
    ).toBeNull();
    expect(
      q('customize-row-subtitle-skill:github:repo/alpha')?.classList.contains(
        REPLAY_BLOCK_CLASS,
      ),
    ).toBe(false);
  });

  it('shows only real installation harnesses, version and update marker', () => {
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
    expect(
      q(`customize-row-update-marker-${id}`)?.getAttribute('aria-label'),
    ).toBe('Update available: v1.3.0');
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

  it('lays every section out in the same two-column grid as Browse', () => {
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

  // CAN-4261: in a half-width grid column, badges move under the name as a
  // group instead of squeezing it to nothing (same rule as Browse cards).
  it('wraps badges under the name instead of squeezing it', () => {
    act(() =>
      root.render(
        <ul>
          <CustomizeInstalledRow
            entry={makeEntry({ surface: 'cloud' })}
            sectionId="installed"
            showEntryType
            onSelect={() => {}}
          />
        </ul>,
      ),
    );
    const line = q('customize-row-name-line-skill:github:repo/alpha');
    expect(line?.classList.contains('flex-wrap')).toBe(true);
    expect(line?.firstElementChild?.classList.contains('max-w-full')).toBe(
      true,
    );
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

  it('labels installed and needs-auth Browse cards Installed only in label mode', () => {
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
    const render = (installedAction?: 'label'): void =>
      act(() =>
        root.render(
          <PluginsDiscoveryList
            sections={[{ id: 'skills', title: '', entries }]}
            selectedEntryId={null}
            onSelectEntry={() => {}}
            onAddEntry={() => {}}
            emptyMessage="Empty"
            installedAction={installedAction}
          />,
        ),
      );
    render();
    expect(q('plugins-entry-installed-a')).toBeNull();
    expect(q('plugins-update-available-a')).not.toBeNull();
    render('label');
    const installed = q('plugins-entry-installed-a');
    expect(installed?.textContent).toBe('Installed');
    expect(installed?.hasAttribute('disabled')).toBe(true);
    expect(q('plugins-entry-installed-b')).not.toBeNull();
    expect(q('plugins-entry-installed-c')).toBeNull();
    expect(q('plugins-entry-add-c')).not.toBeNull();
    expect(q('plugins-update-available-a')).toBeNull();
  });
});
