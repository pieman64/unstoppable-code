import {
  resolveTryItHarness,
  TRY_IT_HARNESSES,
  type TryItHarness,
} from '@canopy/protocol/try-it';
import type {
  AgentProviderType,
  ModelDefaultsByProvider,
  ProviderModelSelection,
} from '@canopy/desktop-shared/types';
import type { PluginInfo } from '@canopy/desktop-shared/types/plugins';
import { cursorPluginFacetSupport } from '@canopy/desktop-shared/lib/cursor-capabilities';

/** Per-harness support, as the detail page's Harness rows show it. */
export type TryItHarnessSupport = Record<TryItHarness, boolean>;

/**
 * How a Try it chat starts: on the viewer's default, on another supported
 * harness's default model, or an unresolved model while setup is needed.
 */
export type TryItRuntime =
  | { status: 'loading' }
  | { status: 'default' }
  | { status: 'model'; selection: ProviderModelSelection }
  | { status: 'setup-required' };

/** The plugin's Harness rows: provider support, Codex compat, Cursor facets. */
export function pluginHarnessSupport(plugin: PluginInfo): TryItHarnessSupport {
  return {
    claude: plugin.providerSupport.claude !== 'none',
    codex:
      plugin.providerSupport.codex !== 'none' && !plugin.codexCompatDisabled,
    cursor: cursorPluginFacetSupport(plugin.facets).supported,
  };
}

function harnessForProvider(provider: AgentProviderType): TryItHarness | null {
  return TRY_IT_HARNESSES.find((harness) => harness === provider) ?? null;
}

/**
 * Picks the Try it runtime (CAN-4359). The viewer's default chat provider
 * wins when the capability supports it; otherwise the first supported,
 * signed-in harness runs on its default model. Without sign-in, retain a
 * supported model so the chat owns authorization and its pending turn.
 * `signedIn` is `null` while a harness's status is loading.
 */
export function resolveTryItRuntime(input: {
  support: TryItHarnessSupport | undefined;
  defaults: {
    chatProvider: AgentProviderType;
    chatModelByProvider: ModelDefaultsByProvider;
  } | null;
  signedIn: Record<TryItHarness, boolean | null>;
}): TryItRuntime {
  const { support, defaults, signedIn } = input;
  if (!support || TRY_IT_HARNESSES.every((harness) => support[harness]))
    return { status: 'default' };
  if (!defaults) return { status: 'loading' };
  const preferred = harnessForProvider(defaults.chatProvider);
  if (preferred && support[preferred]) return { status: 'default' };
  if (
    TRY_IT_HARNESSES.some(
      (harness) => support[harness] && signedIn[harness] === null,
    )
  )
    return { status: 'loading' };
  const selectionFor = (
    harness: TryItHarness,
  ): ProviderModelSelection | null =>
    harness === 'cursor'
      ? (defaults.chatModelByProvider.cursor ?? null)
      : defaults.chatModelByProvider[harness];
  const chosen =
    resolveTryItHarness({
      preferred,
      options: TRY_IT_HARNESSES.map((harness) => ({
        harness,
        supported: support[harness],
        available: signedIn[harness] === true && selectionFor(harness) !== null,
      })),
    }) ??
    resolveTryItHarness({
      preferred,
      options: TRY_IT_HARNESSES.map((harness) => ({
        harness,
        supported: support[harness],
        available: selectionFor(harness) !== null,
      })),
    });
  const selection = chosen ? selectionFor(chosen) : null;
  return selection
    ? { status: 'model', selection }
    : { status: 'setup-required' };
}
