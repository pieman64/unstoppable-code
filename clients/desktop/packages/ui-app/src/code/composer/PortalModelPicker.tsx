'use client';

import { useCallback, useMemo, type JSX } from 'react';
import {
  getModelCatalogProviderLabel,
  MODEL_PICKER_AUTO_REASONS,
  ModelPickerMenu,
  modelLibraryUnlockHint,
  modelLibraryUnlockLabel,
  type ModelCatalog,
  type ModelCatalogOption,
  type ModelCatalogProvider,
  type ModelPickerAutoOption,
  type ModelPickerOptionState,
  type ModelPickerSelectionContext,
} from '@canopy/ui-shared';
import { parseAgentRouteModelId } from '@canopy/protocol/agents';
import type {
  AgentExecutionHarness,
  ModelLibraryAccess,
} from '@canopy/protocol/models';
import type { PortalChatProviderAvailability } from '@canopy/protocol/portal';

export interface PortalModelPickerProps {
  readonly disabled?: boolean;
  readonly catalog: ModelCatalog;
  readonly currentModel?: string;
  readonly currentModelLabel?: string;
  readonly providerType?: string;
  readonly providerAvailability?: PortalChatProviderAvailability;
  readonly capturedHarness?: AgentExecutionHarness;
  /**
   * Display name of the running brand, used to label gateway rows that carry
   * no vendor of their own. Injected by the host: the brand runtime is an
   * app-level concern, and this component is shared.
   */
  readonly brandDisplayName?: string;
  /**
   * Per-turn Auto routing row. Omitted entirely when the rollout flag is off,
   * the server lacks `model-routing-v1`, or the paired desktop projects no
   * Auto support — the shared menu then renders exactly as it does today.
   */
  readonly autoOption?: ModelPickerAutoOption;
  /**
   * Model-library access for the chat's work owner, from the host. Rows the
   * host marked `libraryEligibility: 'locked'` stay reachable and start
   * `onUnlock` instead of selecting; Auto needs unlocked access too. Omitted
   * (or `unlocked`) renders the picker exactly as before.
   */
  readonly modelLibrary?: {
    readonly access: ModelLibraryAccess;
    /** Start recovery. `modelId` is absent when the locked row was Auto. */
    readonly onUnlock: (modelId?: string) => void;
  };
  readonly onSelect: (modelId: string) => void;
}

const CLAUDE_SORT_ORDER = 100;
const CODEX_SORT_ORDER = 200;
const ZAI_SORT_ORDER = 300;
const OTHER_SORT_ORDER = 400;

const GATEWAY_VENDOR_SORT_ORDER: Readonly<Record<string, number>> = {
  anthropic: CLAUDE_SORT_ORDER,
  claude: CLAUDE_SORT_ORDER,
  openai: CODEX_SORT_ORDER,
  codex: CODEX_SORT_ORDER,
  zai: ZAI_SORT_ORDER,
};

function gatewayVendorSortOrder(vendor: string | undefined): number {
  const normalized = vendor?.trim().toLowerCase() ?? '';
  const known = Object.prototype.hasOwnProperty.call(
    GATEWAY_VENDOR_SORT_ORDER,
    normalized,
  )
    ? GATEWAY_VENDOR_SORT_ORDER[normalized]
    : undefined;
  return known ?? OTHER_SORT_ORDER;
}

function optionSource(
  option: ModelCatalogOption,
): ModelCatalogOption['source'] | ModelCatalogProvider {
  return option.source ?? option.provider;
}

function optionHarness(
  option: ModelCatalogOption,
): AgentExecutionHarness | undefined {
  if (option.harness) return option.harness;
  if (
    option.source === 'claude' ||
    option.source === 'codex' ||
    option.source === 'cursor' ||
    option.source === 'copilot' ||
    option.source === 'opencode'
  ) {
    return option.source;
  }
  if (option.source === undefined) {
    if (
      option.provider === 'claude' ||
      option.provider === 'cursor' ||
      option.provider === 'copilot' ||
      option.provider === 'opencode'
    )
      return option.provider;
    if (option.provider === 'codex' || option.provider === 'ollama') {
      return 'codex';
    }
  }
  return undefined;
}

/** Portal wiring for the browser-safe shared model picker. */
export function PortalModelPicker({
  disabled,
  catalog,
  currentModel,
  currentModelLabel,
  providerType,
  providerAvailability,
  capturedHarness,
  brandDisplayName,
  autoOption,
  modelLibrary,
  onSelect,
}: PortalModelPickerProps): JSX.Element {
  const unlockHint = modelLibraryUnlockHint(modelLibrary?.access);
  const unlockLabel = modelLibraryUnlockLabel(modelLibrary?.access);
  const onUnlock = modelLibrary?.onUnlock;
  // Only the desktop can establish model equivalence. Never merge by label:
  // two similarly named models or parameter variants may execute differently.
  const modelRoutes = useMemo(() => {
    const optionsById = new Map(catalog.map((option) => [option.id, option]));
    const routes = new Map<string, ModelCatalogOption[]>();
    for (const option of catalog) {
      const canonical = option.canonicalModelId
        ? optionsById.get(option.canonicalModelId)
        : undefined;
      const id =
        option.kind === 'model' &&
        (option.source === 'cursor' ||
          option.source === 'copilot' ||
          option.source === 'opencode') &&
        canonical?.kind === 'model' &&
        !canonical.canonicalModelId
          ? canonical.id
          : option.id;
      const existing = routes.get(id);
      if (existing) existing.push(option);
      else routes.set(id, [option]);
    }
    return routes;
  }, [catalog]);
  const favoriteModelAliases = useMemo(() => {
    const aliases = new Map<string, string>();
    for (const [id, routes] of modelRoutes) {
      for (const route of routes) {
        if (route.id !== id) aliases.set(route.id, id);
        else if (
          route.kind === 'model' &&
          (route.source === 'cursor' ||
            route.source === 'copilot' ||
            route.source === 'opencode') &&
          route.canonicalModelId &&
          !modelRoutes.has(route.canonicalModelId)
        ) {
          // Keep the host's identity link when only the account row remains.
          aliases.set(route.id, route.canonicalModelId);
        }
      }
    }
    return aliases;
  }, [modelRoutes]);
  const supportedModelIds = useMemo(() => {
    const supported: Record<string, string[]> = {};
    for (const [id, routes] of modelRoutes) {
      for (const route of routes) {
        const harness = optionHarness(route);
        if (harness) (supported[harness] ??= []).push(id);
        else if (optionSource(route) === 'ai-gateway') {
          // Missing cloud curation metadata needs a display group, not a harness.
          (supported.other ??= []).push(id);
        }
      }
    }
    return supported;
  }, [modelRoutes]);
  const rawSelectedModelId =
    currentModel === undefined
      ? undefined
      : (parseAgentRouteModelId(currentModel)?.agentId ?? currentModel);
  const selectedModelId =
    [...modelRoutes].find(([, routes]) =>
      routes.some((route) => route.id === rawSelectedModelId),
    )?.[0] ?? rawSelectedModelId;
  const resolveRoute = useCallback(
    (
      option: ModelCatalogOption,
      selection?: ModelPickerSelectionContext,
    ): ModelCatalogOption => {
      const routes = modelRoutes.get(option.id) ?? [option];
      const harness = selection?.harnessExplicitlyChosen
        ? selection.harness
        : (capturedHarness ?? selection?.harness);
      return (
        (harness
          ? routes.find((route) => optionHarness(route) === harness)
          : (routes.find((route) => route.id === rawSelectedModelId) ??
            routes.find((route) => route.isDefault))) ??
        routes.find((route) => route.id === option.id) ??
        option
      );
    },
    [capturedHarness, modelRoutes, rawSelectedModelId],
  );
  const menuCatalog = useMemo<ModelCatalog>(
    () =>
      [...modelRoutes].map(([id, routes]) => {
        const identity = routes.find((route) => route.id === id) ?? routes[0];
        const option = routes.some((route) => route.isDefault)
          ? { ...identity, isDefault: true }
          : identity;
        const source = optionSource(option);
        if (source === 'ai-gateway') {
          // Preserve the projected vendor metadata so gateway rows land in the
          // same per-vendor sections desktop shows; the branded fallback vendor
          // is only for rows whose host projected no vendor at all, and its
          // heading comes from the `vendorLabels` override built below.
          return {
            ...option,
            family: option.family ?? 'ai-gateway',
            familyLabel: option.familyLabel ?? brandDisplayName ?? 'AI Credits',
            vendor: option.vendor ?? 'ai-gateway',
            sortOrder:
              option.sortOrder ?? gatewayVendorSortOrder(option.vendor),
          };
        }
        if (option.sortOrder !== undefined) return option;
        return {
          ...option,
          sortOrder:
            source === 'claude'
              ? CLAUDE_SORT_ORDER
              : source === 'codex'
                ? CODEX_SORT_ORDER
                : OTHER_SORT_ORDER,
        };
      }),
    [brandDisplayName, modelRoutes],
  );
  /*
   * The one vendor whose heading the shared picker cannot name: gateway rows
   * with no vendor of their own belong under the brand, and the brand runtime
   * lives here, not in `@canopy/ui-shared` (CAN-2701).
   */
  const vendorLabels = useMemo<Readonly<Record<string, string>>>(
    () => ({ 'ai-gateway': brandDisplayName ?? 'AI Credits' }),
    [brandDisplayName],
  );
  const selectedOption = useMemo(
    () =>
      menuCatalog.find((option) => option.id === selectedModelId) ??
      (selectedModelId === undefined
        ? menuCatalog.find((option) => option.isDefault === true)
        : undefined),
    [selectedModelId, menuCatalog],
  );
  const triggerProvider =
    capturedHarness && selectedOption?.provider !== 'ollama'
      ? capturedHarness
      : selectedOption
        ? resolveRoute(selectedOption).provider
        : undefined;

  const getRouteState = useCallback(
    (option: ModelCatalogOption): ModelPickerOptionState => {
      // Cursor runs on the paired desktop's managed runtime. The desktop
      // projects whether that runtime is connected on `providerAvailability.
      // cursor`; anything but an explicit `true` (including a cold "unknown")
      // keeps the row disabled with connect guidance. This branch must stay
      // ahead of the generic provider check below, whose "not signed in"
      // wording does not describe a runtime that is simply not connected.
      if (
        (option.provider === 'cursor' ||
          option.harness === 'cursor' ||
          option.source === 'cursor') &&
        providerAvailability?.cursor !== true
      )
        return {
          disabled: true,
          unavailableReason:
            'Connect Cursor in the desktop app to use it here.',
        };
      if (
        (option.provider === 'copilot' ||
          option.harness === 'copilot' ||
          option.source === 'copilot') &&
        providerAvailability?.copilot !== true
      )
        return {
          disabled: true,
          unavailableReason:
            'Connect Copilot in the desktop app to use it here.',
        };
      if (
        (option.provider === 'opencode' ||
          option.harness === 'opencode' ||
          option.source === 'opencode') &&
        providerAvailability?.opencode !== true
      )
        return {
          disabled: true,
          unavailableReason:
            'Connect OpenCode in the desktop app to use it here.',
        };
      if (option.kind === 'agent' && !option.available) {
        return {
          disabled: true,
          unavailableReason:
            'This agent is unavailable — its base model is not registered on the desktop app.',
        };
      }
      if (
        capturedHarness !== undefined &&
        optionHarness(option) !== capturedHarness
      ) {
        return {
          disabled: true,
          unavailableReason: `This chat started on the ${getModelCatalogProviderLabel(capturedHarness)} harness and can only switch to models that run on it.`,
        };
      }
      if (
        optionSource(option) !== 'ai-gateway' &&
        option.provider !== 'unknown' &&
        providerAvailability?.[option.provider] === false
      ) {
        return {
          disabled: true,
          unavailableReason: `${getModelCatalogProviderLabel(option.provider)} is not signed in on the desktop app.`,
        };
      }
      // Last on purpose: a provider or harness restriction is not something a
      // sign-in or purchase can clear, so it keeps its own reason.
      if (
        unlockHint !== undefined &&
        onUnlock &&
        option.libraryEligibility === 'locked'
      ) {
        return {
          disabled: false,
          locked: {
            hint: unlockHint,
            ...(unlockLabel === undefined ? {} : { label: unlockLabel }),
            onUnlock: (): void => onUnlock(option.id),
          },
        };
      }
      return { disabled: false };
    },
    [capturedHarness, onUnlock, providerAvailability, unlockHint, unlockLabel],
  );
  const getOptionState = useCallback(
    (
      option: ModelCatalogOption,
      selection?: ModelPickerSelectionContext,
    ): ModelPickerOptionState => getRouteState(resolveRoute(option, selection)),
    [getRouteState, resolveRoute],
  );
  const effectiveAutoOption = useMemo<ModelPickerAutoOption | undefined>(() => {
    if (!autoOption || autoOption.unavailableReason) return autoOption;
    // Auto can route to any model, so it needs unlocked access.
    if (unlockHint !== undefined && onUnlock) {
      return {
        selected: autoOption.selected,
        onSelect: autoOption.onSelect,
        unavailableReason: unlockHint,
        unavailableAction: (): void => onUnlock(),
        ...(autoOption.hideWhenUnavailable
          ? { hideWhenUnavailable: true }
          : {}),
      };
    }
    const selectedSource = selectedOption
      ? optionSource(resolveRoute(selectedOption))
      : undefined;
    // Auto executes raw Claude/Codex routes. A merged display row may borrow
    // their description while manual selection uses a managed account route.
    const eligibleCount = catalog.filter((option) => {
      if (
        option.kind === 'agent' ||
        !option.available ||
        !option.description?.trim()
      )
        return false;
      const harness = optionHarness(option);
      if (harness !== 'claude' && harness !== 'codex') return false;
      const source = optionSource(option);
      if (source !== 'claude' && source !== 'codex' && source !== 'ai-gateway')
        return false;
      const state = getRouteState(option);
      if (state.disabled || state.locked) return false;
      if (selectedSource === 'ai-gateway') return source === 'ai-gateway';
      if (selectedSource !== undefined) {
        return source !== 'ai-gateway';
      }
      return true;
    }).length;
    return eligibleCount >= 2
      ? autoOption
      : {
          selected: autoOption.selected,
          onSelect: autoOption.onSelect,
          // Nothing to open for a candidate-count reason, so no action.
          unavailableReason: MODEL_PICKER_AUTO_REASONS.tooFewCandidates,
          ...(autoOption.hideWhenUnavailable
            ? { hideWhenUnavailable: true }
            : {}),
        };
  }, [
    autoOption,
    catalog,
    getRouteState,
    onUnlock,
    resolveRoute,
    selectedOption,
    unlockHint,
  ]);

  return (
    <ModelPickerMenu
      disabled={disabled}
      catalog={menuCatalog}
      currentModel={selectedModelId}
      currentModelLabel={currentModelLabel}
      providerType={providerType}
      triggerProvider={triggerProvider}
      onSelect={(modelId, selection): void => {
        const option = menuCatalog.find((entry) => entry.id === modelId);
        if (option) onSelect(resolveRoute(option, selection).id);
      }}
      harnessTabs={{
        // Favorites must remain reachable while routes or account state refresh.
        allModelsTab: true,
        leadingFavorites: true,
        brandIcon: null,
        brandLabel: brandDisplayName ?? 'AI Credits',
        // A captured harness without rows has no tab; open on All so the
        // locked rows stay visible instead of an empty Favorites tab.
        initialTab:
          capturedHarness === 'claude' ||
          capturedHarness === 'codex' ||
          (capturedHarness && supportedModelIds[capturedHarness]?.length)
            ? capturedHarness
            : 'all',
        supportedModelIds,
        favoriteModelAliases,
      }}
      getOptionState={getOptionState}
      getOptionPresentation={resolveRoute}
      vendorLabels={vendorLabels}
      autoOption={effectiveAutoOption}
      variant="capsule"
      menuId="portal-chat-model-menu"
      testIdPrefix="portal-chat-model"
      uniformTestIds
      triggerLabelClassName="max-w-20 lg:max-w-none"
    />
  );
}
