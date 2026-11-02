import {
  CoreHookActionSchema,
  type CanopyQueryHandler,
  type CoreHookAction,
  type CoreHookSourceLayerKey,
  type CoreHookSourceOrigin,
  type CoreHookSourceTarget,
  type CoreInitiatedWorkSourceGetResult,
  type CoreInitiatedWorkSourceListResult,
} from '@canopy/protocol/canopy-core';
import type { ConfiguredPromptReference } from '@canopy/protocol/configured-prompt-references';
import { CanopyOperationError } from '../../runtime/errors';
import type { CanopyHandlerContext } from '../../runtime/types';

/*
 * Layered hook source policy behind `core.initiatedWork.source.list` and
 * `.get`. A target's hooks come from a source-controlled base layer
 * (`canopy.json` of the checkout or of the project root), an optional project
 * manifest repo entry, and the machine-local layer. Hosts read the layers and
 * own every effect; this module only combines them.
 */

/** The action fields the layering consults; hosts keep their own action type. */
export interface PortableHookAction {
  readonly type: string;
  readonly prompt?: string;
  readonly source?: string;
  readonly id?: string;
  readonly executionContext?: string;
  readonly localExecutionContextOverlay?: boolean;
  readonly localPluginSelectionOverlay?: boolean;
  readonly localPluginSelectionOverlayKey?: string;
  readonly pluginSelections?: unknown;
  readonly promptReferences?: readonly ConfiguredPromptReference[];
}

export interface HookSourceField<TAction> {
  actions?: TAction[];
  source: CoreHookSourceOrigin;
}

export type HookSourceMap<TAction> = Record<string, HookSourceField<TAction>>;

export type HookLayerScope = CoreHookSourceTarget['kind'];

export interface HookSourceLayerInputs<TAction> {
  scope: HookLayerScope;
  /** Source-controlled hooks: the checkout's `canopy.json`, or the project root's for `workspace-root`. */
  sourceHooks: Readonly<Record<string, TAction[]>> | undefined;
  /** `workspace-repo` only: the repo entry in the project manifest. */
  manifestHooks?: Readonly<Record<string, TAction[] | null>> | undefined;
  /** Machine-local hooks as persisted, including overlay stubs. */
  localHooks: Readonly<Record<string, TAction[] | null>> | undefined;
}

export interface HookOwnerBinding<TAction> {
  hooks: Readonly<Record<string, TAction[] | null>> | undefined;
  owner: { readonly organizationId: string } | undefined;
}

/** Applies the host's ownership decision to the local layer before it is overlaid. */
export type BindLocalHooks<TAction> = (
  resolvedSoFar: HookSourceMap<TAction>,
) => Promise<HookOwnerBinding<TAction>>;

export interface HookSourceLayer<TAction> {
  sourceKey: CoreHookSourceLayerKey;
  actions: TAction[] | null;
  status: 'active' | 'overridden' | 'disabled' | 'absent';
}

const BASE_SOURCE: Record<HookLayerScope, CoreHookSourceOrigin> = {
  project: 'repo-canopy',
  'workspace-root': 'workspace-hook',
  'workspace-repo': 'repo-canopy',
};

const BASE_LAYER_KEY: Record<HookLayerScope, CoreHookSourceLayerKey> = {
  project: 'repo-canopy',
  'workspace-root': 'workspace-hook',
  'workspace-repo': 'repo-canopy',
};

const DISABLED_SOURCES: ReadonlySet<CoreHookSourceOrigin> =
  new Set<CoreHookSourceOrigin>([
    'local-disabled',
    'workspace-manifest-disabled',
    'workspace-hook-disabled',
  ]);

export function isDisabledHookSource(source: CoreHookSourceOrigin): boolean {
  return DISABLED_SOURCES.has(source);
}

/** Resolves a target's effective hooks, most specific layer last. */
export async function resolveLayeredHookSources<
  TAction extends PortableHookAction,
>(
  inputs: HookSourceLayerInputs<TAction>,
  bindLocalHooks: BindLocalHooks<TAction>,
): Promise<HookSourceMap<TAction>> {
  const resolved: HookSourceMap<TAction> = {};
  applyActiveHooks(resolved, inputs.sourceHooks, BASE_SOURCE[inputs.scope]);
  if (inputs.scope === 'workspace-repo') {
    applyOverrideHooks(
      resolved,
      inputs.manifestHooks,
      'workspace-manifest',
      'workspace-manifest-disabled',
    );
  }
  const { hooks: localHooks, owner } = await bindLocalHooks(resolved);
  applyLocalPluginSelectionOverlays(resolved, localHooks);
  applyOverrideHooks(resolved, localHooks, 'local-override', 'local-disabled', {
    preserveSourceForPluginSelections: true,
  });
  applyLocalExecutionContextOverlays(resolved, localHooks, owner);
  return resolved;
}

/** The layers that define one trigger, most specific first, with the winner marked. */
export function collectHookSourceLayers<TAction>(
  inputs: HookSourceLayerInputs<TAction>,
  triggerName: string,
): HookSourceLayer<TAction>[] {
  const candidates: Array<HookSourceLayer<TAction> | null> = [
    buildHookSourceLayer('local-override', inputs.localHooks, triggerName),
    inputs.scope === 'workspace-repo'
      ? buildHookSourceLayer(
          'workspace-manifest',
          inputs.manifestHooks,
          triggerName,
        )
      : null,
    buildHookSourceLayer(
      BASE_LAYER_KEY[inputs.scope],
      inputs.sourceHooks,
      triggerName,
    ),
  ];
  const layers = candidates.filter(
    (layer): layer is HookSourceLayer<TAction> => layer !== null,
  );
  assignEffectiveSourceLayerStatus(layers);
  return layers;
}

/** The winning layer's actions; a disabled winner yields null. */
export function effectiveHookSourceActions<TAction>(
  layers: readonly HookSourceLayer<TAction>[],
): TAction[] | null {
  return (
    layers.find(
      (layer) => layer.status === 'active' || layer.status === 'disabled',
    )?.actions ?? null
  );
}

function buildHookSourceLayer<TAction>(
  sourceKey: CoreHookSourceLayerKey,
  hooks: Readonly<Record<string, TAction[] | null | undefined>> | undefined,
  triggerName: string,
): HookSourceLayer<TAction> | null {
  if (!hooks || !(triggerName in hooks)) return null;
  const actions = hooks[triggerName];
  if (actions === null) return { sourceKey, actions: null, status: 'disabled' };
  if (Array.isArray(actions)) return { sourceKey, actions, status: 'active' };
  return null;
}

/** Marks every active layer after the first resolved one as overridden. */
export function assignEffectiveSourceLayerStatus<
  TLayer extends { status: 'active' | 'overridden' | 'disabled' | 'absent' },
>(layers: TLayer[]): void {
  let resolved = false;
  for (const layer of layers) {
    if (resolved) {
      if (layer.status === 'active') layer.status = 'overridden';
      continue;
    }
    if (layer.status === 'active' || layer.status === 'disabled')
      resolved = true;
  }
}

function applyActiveHooks<TAction>(
  resolved: HookSourceMap<TAction>,
  hooks: Readonly<Record<string, TAction[]>> | undefined,
  source: CoreHookSourceOrigin,
): void {
  if (!hooks) return;
  for (const [triggerName, actions] of Object.entries(hooks)) {
    resolved[triggerName] = { actions, source };
  }
}

function applyOverrideHooks<TAction extends PortableHookAction>(
  resolved: HookSourceMap<TAction>,
  hooks: Readonly<Record<string, TAction[] | null>> | undefined,
  enabledSource: CoreHookSourceOrigin,
  disabledSource: CoreHookSourceOrigin,
  options?: { preserveSourceForPluginSelections?: boolean },
): void {
  if (!hooks) return;
  for (const [triggerName, actions] of Object.entries(hooks)) {
    if (Array.isArray(actions)) {
      const executableActions = actions.filter(
        (action) =>
          !isExecutionContextOverlay(action) &&
          (!options?.preserveSourceForPluginSelections ||
            !isPluginSelectionOverlayAction(action)),
      );
      if (executableActions.length === 0) continue;
      resolved[triggerName] = {
        actions: executableActions,
        source: enabledSource,
      };
      continue;
    }
    resolved[triggerName] = { source: disabledSource };
  }
}

function isExecutionContextOverlay(action: PortableHookAction): boolean {
  return (
    (action.type === 'pipeline' || action.type === 'chat') &&
    action.localExecutionContextOverlay === true
  );
}

function isPluginSelectionOverlayAction(action: PortableHookAction): boolean {
  return (
    action.type === 'chat' &&
    action.localPluginSelectionOverlay === true &&
    typeof action.localPluginSelectionOverlayKey === 'string'
  );
}

// Mirrors `getChatHookActionOverlayKey`: a chat action's identity is its prompt.
function chatOverlayKey(action: PortableHookAction): string {
  return `chat:${(action.prompt ?? '').trim()}`;
}

/** Scope is the containing local config; trigger, source and id identify its binding. */
function applyLocalExecutionContextOverlays<TAction extends PortableHookAction>(
  resolved: HookSourceMap<TAction>,
  hooks: Readonly<Record<string, TAction[] | null>> | undefined,
  owner: HookOwnerBinding<TAction>['owner'],
): void {
  for (const [trigger, actions] of Object.entries(hooks ?? {})) {
    const field = resolved[trigger];
    if (!field?.actions || !Array.isArray(actions)) continue;
    // Organization overlays cannot outlive the owner that enabled them.
    const overlays = actions
      .filter(isExecutionContextOverlay)
      .filter(
        (action) =>
          !action.executionContext?.startsWith('org:') ||
          (owner !== undefined &&
            action.executionContext === `org:${owner.organizationId}`),
      );
    if (overlays.length === 0) continue;
    const chatKeyCounts = new Map<string, number>();
    for (const action of field.actions) {
      if (action.type !== 'chat') continue;
      const key = chatOverlayKey(action);
      chatKeyCounts.set(key, (chatKeyCounts.get(key) ?? 0) + 1);
    }
    field.actions = field.actions.map((action): TAction => {
      if (
        (action.type !== 'pipeline' && action.type !== 'chat') ||
        action.executionContext !== undefined
      )
        return action;
      const matches = overlays.filter((overlay) => {
        if (overlay.type !== action.type) return false;
        return action.type === 'pipeline'
          ? overlay.source === action.source && overlay.id === action.id
          : chatOverlayKey(overlay) === chatOverlayKey(action);
      });
      const overlay = matches.length === 1 ? matches[0] : undefined;
      if (
        action.type === 'chat' &&
        chatKeyCounts.get(chatOverlayKey(action)) !== 1
      )
        return action;
      return overlay?.executionContext !== undefined
        ? { ...action, executionContext: overlay.executionContext }
        : action;
    });
  }
}

/**
 * Source-control setup retains full local hook actions only to remember each
 * machine's runtime plugin selections. Keep those selections local without
 * letting the retained action copy shadow later source-controlled edits.
 */
function applyLocalPluginSelectionOverlays<TAction extends PortableHookAction>(
  resolved: HookSourceMap<TAction>,
  hooks: Readonly<Record<string, TAction[] | null>> | undefined,
): void {
  if (!hooks) return;
  for (const [triggerName, localActions] of Object.entries(hooks)) {
    if (!Array.isArray(localActions)) continue;
    const sourceActions = resolved[triggerName]?.actions;
    if (!sourceActions) continue;
    const overlays = localActions.filter(
      (action) =>
        isPluginSelectionOverlayAction(action) &&
        (action.pluginSelections !== undefined ||
          action.promptReferences !== undefined),
    );
    if (overlays.length === 0) continue;

    const sourceActionKeyCounts = new Map<string, number>();
    for (const sourceAction of sourceActions) {
      if (sourceAction.type !== 'chat') continue;
      const key = chatOverlayKey(sourceAction);
      sourceActionKeyCounts.set(key, (sourceActionKeyCounts.get(key) ?? 0) + 1);
    }
    const overlaysByKey = new Map<string, TAction[]>();
    for (const overlay of overlays) {
      const key = overlay.localPluginSelectionOverlayKey;
      if (!key) continue;
      const matchingOverlays = overlaysByKey.get(key) ?? [];
      matchingOverlays.push(overlay);
      overlaysByKey.set(key, matchingOverlays);
    }

    resolved[triggerName] = {
      ...resolved[triggerName],
      actions: sourceActions.map((sourceAction): TAction => {
        if (sourceAction.type !== 'chat') return sourceAction;
        const key = chatOverlayKey(sourceAction);
        const matchingOverlays = overlaysByKey.get(key);
        const overlay =
          sourceActionKeyCounts.get(key) === 1 && matchingOverlays?.length === 1
            ? matchingOverlays[0]
            : undefined;
        if (!overlay) return sourceAction;
        const sourceReferences = sourceAction.promptReferences ?? [];
        return {
          ...sourceAction,
          ...(overlay.pluginSelections !== undefined
            ? { pluginSelections: overlay.pluginSelections }
            : {}),
          ...(overlay.promptReferences !== undefined
            ? {
                promptReferences: [
                  ...sourceReferences,
                  ...overlay.promptReferences.filter(
                    (ref) =>
                      ref.kind === 'plugin' &&
                      ref.plugin.kind === 'installed' &&
                      !sourceReferences.some(
                        (sourceRef) =>
                          sourceRef.textStart === ref.textStart &&
                          sourceRef.displayText === ref.displayText,
                      ),
                  ),
                ].sort((a, b) => a.textStart - b.textStart),
              }
            : {}),
        };
      }),
    };
  }
}

// ---------------------------------------------------------------------------
// core.initiatedWork.source.list / .get
// ---------------------------------------------------------------------------

export interface HookSourceLayerRead<TAction> {
  layers: HookSourceLayerInputs<TAction>;
  bindLocalHooks: BindLocalHooks<TAction>;
}

export interface CoreHookSourceHost<TAction extends PortableHookAction> {
  /** Reads a target's layers from trusted host state; params never carry paths. */
  readLayers(
    target: CoreHookSourceTarget,
  ): Promise<HookSourceLayerRead<TAction>>;
  /** Whether a host error rejected a target identifier before any read. */
  isInvalidTarget(error: unknown): boolean;
  /** Receives the host-typed resolution, for in-process compatibility projections. */
  observeResolved?(resolved: HookSourceMap<TAction>): void;
  /** Receives the host-typed layers, for in-process compatibility projections. */
  observeLayers?(layers: HookSourceLayer<TAction>[]): void;
}

export interface CoreInitiatedWorkSourceHandlers {
  queries: {
    'core.initiatedWork.source.list': CanopyQueryHandler<
      'core.initiatedWork.source.list',
      CanopyHandlerContext
    >;
    'core.initiatedWork.source.get': CanopyQueryHandler<
      'core.initiatedWork.source.get',
      CanopyHandlerContext
    >;
  };
}

// Results cross the binding as JSON: undefined members are dropped, as any
// serializing binding would drop them.
function jsonMembers(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(jsonMembers);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).flatMap(([key, member]) =>
      member === undefined ? [] : [[key, jsonMembers(member)]],
    ),
  );
}

function toCoreHookActions(
  actions: readonly PortableHookAction[] | null | undefined,
): CoreHookAction[] | null {
  return actions
    ? actions.map((action) => CoreHookActionSchema.parse(jsonMembers(action)))
    : null;
}

// The original error stays the runtime cause so in-process projections can
// rethrow it with its exact message.
function typedError<TAction extends PortableHookAction>(
  error: unknown,
  host: CoreHookSourceHost<TAction>,
): unknown {
  const message = error instanceof Error ? error.message.slice(0, 4_096) : '';
  if (message && host.isInvalidTarget(error))
    return new CanopyOperationError(
      {
        kind: 'invalid_argument',
        code: 'core.initiatedWork.source.invalidTarget',
        message,
        retry: { kind: 'never' },
      },
      error,
    );
  return error;
}

export function createCoreInitiatedWorkSourceHandlers<
  TAction extends PortableHookAction,
>(host: CoreHookSourceHost<TAction>): CoreInitiatedWorkSourceHandlers {
  return {
    queries: {
      'core.initiatedWork.source.list': async ({
        target,
      }): Promise<CoreInitiatedWorkSourceListResult> => {
        try {
          const read = await host.readLayers(target);
          const resolved = await resolveLayeredHookSources(
            read.layers,
            read.bindLocalHooks,
          );
          host.observeResolved?.(resolved);
          return {
            sources: Object.entries(resolved).map(([triggerName, field]) => ({
              sourceKind: 'hook',
              triggerName,
              origin: field.source,
              actions: toCoreHookActions(field.actions),
            })),
          };
        } catch (error) {
          throw typedError(error, host);
        }
      },
      'core.initiatedWork.source.get': async ({
        target,
        triggerName,
      }): Promise<CoreInitiatedWorkSourceGetResult> => {
        try {
          const read = await host.readLayers(target);
          const layers = collectHookSourceLayers(read.layers, triggerName);
          host.observeLayers?.(layers);
          return {
            sourceKind: 'hook',
            triggerName,
            effectiveActions: toCoreHookActions(
              effectiveHookSourceActions(layers),
            ),
            layers: layers.map((layer) => ({
              sourceKey: layer.sourceKey,
              status: layer.status,
              actions: toCoreHookActions(layer.actions),
            })),
          };
        } catch (error) {
          throw typedError(error, host);
        }
      },
    },
  };
}
