import { getModelCatalogProviderLabel } from '@canopy/protocol/models';
import type { CursorLoadablePluginDetails } from '../cursor-support';
import {
  ALWAYS_OFFERED_PLUGIN_HARNESSES,
  isPluginHarnessId,
  offeredPluginHarnesses,
  PLUGIN_HARNESSES,
  pluginHarnessLabel,
  pluginHarnessRows,
  type PluginHarnessRow,
} from '../harness-support';

const detailsWith = (
  counts: Partial<Record<keyof CursorLoadablePluginDetails, number>> = {},
): CursorLoadablePluginDetails => ({
  mcpServers: Array.from({ length: counts.mcpServers ?? 0 }, () => ({})),
  skills: Array.from({ length: counts.skills ?? 0 }, () => ({})),
  commands: Array.from({ length: counts.commands ?? 0 }, () => ({})),
});

const installations = (
  rows: readonly PluginHarnessRow[],
): Array<[string, string]> =>
  rows.map((row): [string, string] => [row.id, row.installation]);

describe('PLUGIN_HARNESSES', () => {
  it('lists every harness in display order', () => {
    expect(PLUGIN_HARNESSES).toEqual([
      'claude',
      'codex',
      'cursor',
      'copilot',
      'opencode',
    ]);
  });

  it('labels match the model catalog except Copilot', () => {
    for (const id of PLUGIN_HARNESSES) {
      expect(pluginHarnessLabel(id)).toBe(
        id === 'copilot' ? 'Copilot' : getModelCatalogProviderLabel(id),
      );
    }
  });
});

describe('pluginHarnessRows', () => {
  it('names every row with its label', () => {
    const rows = pluginHarnessRows({
      harnesses: PLUGIN_HARNESSES,
      providerSupport: { claude: 'native', codex: 'none' },
      facets: {},
      installed: false,
    });
    expect(rows.map((row) => row.name)).toEqual([
      'Claude',
      'Codex',
      'Cursor',
      'Copilot',
      'OpenCode',
    ]);
  });

  it('claude facet with a skill: codex none → Not supported, cursor/copilot/opencode follow claude install', () => {
    const rows = pluginHarnessRows({
      harnesses: PLUGIN_HARNESSES,
      providerSupport: { claude: 'native', codex: 'none' },
      facets: { claude: { details: detailsWith({ skills: 1 }) } },
      installed: { claude: true, codex: false },
    });
    expect(installations(rows)).toEqual([
      ['claude', 'Installed'],
      ['codex', 'Not supported'],
      ['cursor', 'Installed'],
      ['copilot', 'Installed'],
      ['opencode', 'Installed'],
    ]);
  });

  it('codex compat disabled → Codex Not supported, facet harnesses still follow Claude', () => {
    const rows = pluginHarnessRows({
      harnesses: PLUGIN_HARNESSES,
      providerSupport: { claude: 'native', codex: 'compat' },
      codexCompatDisabled: true,
      facets: { claude: { details: detailsWith({ commands: 1 }) } },
      installed: { claude: false, codex: true },
    });
    expect(installations(rows)).toEqual([
      ['claude', 'Not installed'],
      ['codex', 'Not supported'],
      ['cursor', 'Not installed'],
      ['copilot', 'Not installed'],
      ['opencode', 'Not installed'],
    ]);
  });

  it('codex compat disabled with a codex-only facet → Codex Not supported, facet harnesses follow codex install (documents the no-strip rule)', () => {
    const rows = pluginHarnessRows({
      harnesses: PLUGIN_HARNESSES,
      providerSupport: { claude: 'none', codex: 'native' },
      codexCompatDisabled: true,
      facets: { codex: { details: detailsWith({ skills: 1 }) } },
      installed: { codex: true },
    });
    expect(installations(rows)).toEqual([
      ['claude', 'Not supported'],
      ['codex', 'Not supported'],
      ['cursor', 'Installed'],
      ['copilot', 'Installed'],
      ['opencode', 'Installed'],
    ]);
  });

  it('codex-only facet with empty details → cursor/copilot/opencode Not supported, Codex Installed when installed.codex', () => {
    const rows = pluginHarnessRows({
      harnesses: PLUGIN_HARNESSES,
      providerSupport: { claude: 'none', codex: 'native' },
      facets: { codex: { details: detailsWith() } },
      installed: { codex: true },
    });
    expect(installations(rows)).toEqual([
      ['claude', 'Not supported'],
      ['codex', 'Installed'],
      ['cursor', 'Not supported'],
      ['copilot', 'Not supported'],
      ['opencode', 'Not supported'],
    ]);
  });

  it('a codex facet carrying only commands gives the facet harnesses nothing to load', () => {
    const rows = pluginHarnessRows({
      harnesses: PLUGIN_HARNESSES,
      providerSupport: { claude: 'none', codex: 'native' },
      facets: { codex: { details: detailsWith({ commands: 2 }) } },
      installed: true,
    });
    expect(installations(rows).slice(2)).toEqual([
      ['cursor', 'Not supported'],
      ['copilot', 'Not supported'],
      ['opencode', 'Not supported'],
    ]);
  });

  it('installed: true marks every supported harness Installed; installed: false never does', () => {
    const input = {
      providerSupport: { claude: 'native', codex: 'compat' },
      facets: { claude: { details: detailsWith({ mcpServers: 1 }) } },
    } as const;
    expect(
      installations(
        pluginHarnessRows({
          ...input,
          installed: true,
          harnesses: PLUGIN_HARNESSES,
        }),
      ),
    ).toEqual([
      ['claude', 'Installed'],
      ['codex', 'Installed'],
      ['cursor', 'Installed'],
      ['copilot', 'Installed'],
      ['opencode', 'Installed'],
    ]);
    expect(
      pluginHarnessRows({
        ...input,
        installed: false,
        harnesses: PLUGIN_HARNESSES,
      }).some((row) => row.installation === 'Installed'),
    ).toBe(false);
  });

  it('installed record missing the facet provider key → facet harnesses Not installed', () => {
    const rows = pluginHarnessRows({
      harnesses: PLUGIN_HARNESSES,
      providerSupport: { claude: 'native', codex: 'compat' },
      facets: { claude: { details: detailsWith({ skills: 1 }) } },
      installed: { codex: true },
    });
    expect(installations(rows)).toEqual([
      ['claude', 'Not installed'],
      ['codex', 'Installed'],
      ['cursor', 'Not installed'],
      ['copilot', 'Not installed'],
      ['opencode', 'Not installed'],
    ]);
  });

  it('no facets → the three facet harnesses are Not supported', () => {
    const rows = pluginHarnessRows({
      harnesses: PLUGIN_HARNESSES,
      providerSupport: { claude: 'native', codex: 'native' },
      facets: {},
      installed: true,
    });
    expect(installations(rows)).toEqual([
      ['claude', 'Installed'],
      ['codex', 'Installed'],
      ['cursor', 'Not supported'],
      ['copilot', 'Not supported'],
      ['opencode', 'Not supported'],
    ]);
  });
});

describe('offeredPluginHarnesses', () => {
  it('always offers Claude and Codex and adds the gated harnesses in display order', () => {
    expect(
      offeredPluginHarnesses({
        cursor: false,
        copilot: false,
        opencode: false,
      }),
    ).toEqual(['claude', 'codex']);
    expect(
      offeredPluginHarnesses({ cursor: true, copilot: false, opencode: true }),
    ).toEqual(['claude', 'codex', 'cursor', 'opencode']);
    expect(
      offeredPluginHarnesses({ cursor: true, copilot: true, opencode: true }),
    ).toEqual([...PLUGIN_HARNESSES]);
  });

  it('the always-offered set is what a host lists without gates', () => {
    expect(
      offeredPluginHarnesses({
        cursor: false,
        copilot: false,
        opencode: false,
      }),
    ).toEqual([...ALWAYS_OFFERED_PLUGIN_HARNESSES]);
  });
});

describe('isPluginHarnessId', () => {
  it('accepts listed harnesses only', () => {
    for (const id of PLUGIN_HARNESSES) expect(isPluginHarnessId(id)).toBe(true);
    expect(isPluginHarnessId('ollama')).toBe(false);
    expect(isPluginHarnessId(undefined)).toBe(false);
  });
});

describe('pluginHarnessRows harnesses', () => {
  it('lists only offered harnesses, in display order, whatever order the host passes', () => {
    const rows = pluginHarnessRows({
      providerSupport: { claude: 'native', codex: 'native' },
      facets: {},
      installed: true,
      harnesses: ['opencode', 'codex', 'claude'],
    });
    expect(installations(rows)).toEqual([
      ['claude', 'Installed'],
      ['codex', 'Installed'],
      ['opencode', 'Not supported'],
    ]);
  });

  it('a hidden harness gets no row even when the plugin supports it', () => {
    const rows = pluginHarnessRows({
      providerSupport: { claude: 'native', codex: 'none' },
      facets: { claude: { details: detailsWith({ skills: 1 }) } },
      installed: true,
      harnesses: offeredPluginHarnesses({
        cursor: true,
        copilot: false,
        opencode: false,
      }),
    });
    expect(rows.map((row) => row.id)).toEqual(['claude', 'codex', 'cursor']);
  });
});
