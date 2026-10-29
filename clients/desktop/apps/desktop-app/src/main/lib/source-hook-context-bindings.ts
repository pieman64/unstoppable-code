import {
  getChatHookActionOverlayKey,
  type HookAction,
  type HookOverrides,
} from '@canopy/desktop-shared/hooks';

type ContextHookAction = Extract<HookAction, { type: 'pipeline' | 'chat' }>;

function identity(action: ContextHookAction): string {
  return action.type === 'chat'
    ? getChatHookActionOverlayKey(action)
    : JSON.stringify(['pipeline', action.source, action.id]);
}

function isLocalOverlay(action: HookAction): boolean {
  return (
    (action.type === 'pipeline' || action.type === 'chat') &&
    (action.localExecutionContextOverlay === true ||
      (action.type === 'chat' &&
        action.localPluginSelectionOverlay === true &&
        typeof action.localPluginSelectionOverlayKey === 'string'))
  );
}

/** Repair inherited enablement only; explicit/local choices retain their binding. */
export function addOrganizationSourceHookBindings(
  source: HookOverrides | undefined,
  local: HookOverrides | undefined,
  organizationId: string,
): HookOverrides | undefined {
  let result = local;
  for (const [trigger, actions] of Object.entries(source ?? {})) {
    if (!Array.isArray(actions)) continue;
    const previous =
      local && Object.prototype.hasOwnProperty.call(local, trigger)
        ? local[trigger]
        : undefined;
    if (
      previous === null ||
      previous?.some((action) => !isLocalOverlay(action))
    )
      continue;
    const counts = new Map<string, number>();
    for (const action of actions) {
      if (action.type === 'command') continue;
      const key = identity(action);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    let overlays = previous;
    for (const action of actions) {
      if (action.type === 'command' || action.executionContext !== undefined)
        continue;
      const key = identity(action);
      if (counts.get(key) !== 1) continue;
      const matches = (overlays ?? []).filter(
        (candidate) =>
          candidate.type !== 'command' && identity(candidate) === key,
      );
      if (matches.length > 1) continue;
      const existing = matches[0];
      if (
        existing?.type !== 'command' &&
        existing?.executionContext !== undefined
      )
        continue;
      const binding: ContextHookAction = {
        ...(existing?.type === 'pipeline' || existing?.type === 'chat'
          ? existing
          : action.type === 'pipeline'
            ? { type: 'pipeline', source: action.source, id: action.id }
            : { type: 'chat', prompt: action.prompt }),
        executionContext: `org:${organizationId}`,
        localExecutionContextOverlay: true,
      };
      overlays = existing
        ? (overlays ?? []).map((candidate) =>
            candidate === existing ? binding : candidate,
          )
        : [...(overlays ?? []), binding];
    }
    if (overlays !== undefined && overlays !== previous)
      result = { ...result, [trigger]: overlays };
  }
  return result;
}
