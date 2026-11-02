import type { AgentExecutionHarness } from '@canopy/protocol/models';
import type { PluginProviderSupport } from '@canopy/protocol/plugins';
import {
  cursorPluginFacetSupport,
  type CursorLoadablePluginDetails,
} from './cursor-support';

/**
 * Every harness a plugin page lists, in display order. Each one is listed
 * whether or not you are signed in to it; the row states whether the harness
 * can run the plugin and whether the plugin is installed for it.
 */
export const PLUGIN_HARNESSES = [
  'claude',
  'codex',
  'cursor',
  'copilot',
  'opencode',
] as const satisfies readonly AgentExecutionHarness[];

export type PluginHarnessId = (typeof PLUGIN_HARNESSES)[number];

export function isPluginHarnessId(value: unknown): value is PluginHarnessId {
  return PLUGIN_HARNESSES.some((id) => id === value);
}

/**
 * Harnesses every build offers. A host that cannot read the desktop's harness
 * gates (the public catalog page, or a Portal paired with an older desktop)
 * lists only these.
 */
export const ALWAYS_OFFERED_PLUGIN_HARNESSES = [
  'claude',
  'codex',
] as const satisfies readonly PluginHarnessId[];

/** The desktop's harness gates for the harnesses that have one. */
export interface PluginHarnessGates {
  cursor: boolean;
  copilot: boolean;
  opencode: boolean;
}

/**
 * The harnesses this build offers, in display order: Claude and Codex always,
 * the others when their harness gate is on. A plugin page lists a harness
 * whether or not you are signed in to it, but never one the build hides.
 */
export function offeredPluginHarnesses(
  gates: PluginHarnessGates,
): PluginHarnessId[] {
  return PLUGIN_HARNESSES.filter(
    (id) => id === 'claude' || id === 'codex' || gates[id],
  );
}

/**
 * Display label for a harness row. Matches the model catalog's provider
 * labels except Copilot, which plugin pages name "Copilot" to match the
 * Copilot connection copy. A literal map so this package has no runtime
 * protocol dependency.
 */
export function pluginHarnessLabel(id: PluginHarnessId): string {
  switch (id) {
    case 'claude':
      return 'Claude';
    case 'codex':
      return 'Codex';
    case 'cursor':
      return 'Cursor';
    case 'copilot':
      return 'Copilot';
    case 'opencode':
      return 'OpenCode';
  }
}

export type PluginHarnessInstallation =
  | 'Installed'
  | 'Not installed'
  | 'Not supported';

export interface PluginHarnessRow {
  id: PluginHarnessId;
  name: string;
  installation: PluginHarnessInstallation;
}

type PluginHarnessFacetProvider = 'claude' | 'codex';

export interface PluginHarnessRowsInput {
  providerSupport: PluginProviderSupport;
  /** The Claude plugin's Codex compatibility setting is off. */
  codexCompatDisabled?: boolean;
  /** Hosts pass facets only for providers they support; the rule does not filter them. */
  facets: {
    claude?: { details?: CursorLoadablePluginDetails | null };
    codex?: { details?: CursorLoadablePluginDetails | null };
  };
  /** Per-provider truth, or one flag when the host only has that (web). `false` never claims Installed. */
  installed: boolean | Partial<Record<PluginHarnessFacetProvider, boolean>>;
  /**
   * The harnesses the host offers ({@link offeredPluginHarnesses}). Rows keep
   * {@link PLUGIN_HARNESSES} order. Required so a display caller cannot list
   * a harness the build hides; a caller reading one named harness's support
   * passes {@link PLUGIN_HARNESSES}.
   */
  harnesses: readonly PluginHarnessId[];
}

function isInstalledFor(
  installed: PluginHarnessRowsInput['installed'],
  provider: PluginHarnessFacetProvider,
): boolean {
  if (typeof installed === 'boolean') return installed;
  return installed[provider] === true;
}

/**
 * One row per offered harness ({@link PluginHarnessRowsInput.harnesses}), read from the plugin's
 * provider support and facets so the harness table and Try it state the same
 * support (CAP-01 in the harness checklist).
 *
 * - Claude runs a plugin with a Claude facet; Codex runs a native or
 *   compatibility facet unless the Claude plugin's Codex compatibility is off.
 * - Cursor, Copilot, and OpenCode sessions read the facet a Cursor session
 *   reads (`cursorPluginFacetSupport`; the desktop resolver runs the same
 *   projection for Copilot and OpenCode sessions), so they are supported when
 *   that facet carries something they load, and installed when the plugin is
 *   installed for that facet's provider.
 * - `codexCompatDisabled` changes only the Codex row. It does not strip the
 *   Codex facet: compatibility is a Claude-plugin setting, so a Codex-only
 *   plugin never carries it.
 */
export function pluginHarnessRows(
  input: PluginHarnessRowsInput,
): PluginHarnessRow[] {
  const { providerSupport, codexCompatDisabled, facets, installed, harnesses } =
    input;
  const facetSupport = cursorPluginFacetSupport(facets);
  const row = (
    id: PluginHarnessId,
    supported: boolean,
    provider: PluginHarnessFacetProvider,
  ): PluginHarnessRow => ({
    id,
    name: pluginHarnessLabel(id),
    installation: !supported
      ? 'Not supported'
      : isInstalledFor(installed, provider)
        ? 'Installed'
        : 'Not installed',
  });
  return PLUGIN_HARNESSES.filter((id) => harnesses.includes(id)).map((id) => {
    switch (id) {
      case 'claude':
        return row(id, providerSupport.claude !== 'none', 'claude');
      case 'codex':
        return row(
          id,
          providerSupport.codex !== 'none' && !codexCompatDisabled,
          'codex',
        );
      case 'cursor':
      case 'copilot':
      case 'opencode':
        return row(id, facetSupport.supported, facetSupport.provider);
    }
  });
}
