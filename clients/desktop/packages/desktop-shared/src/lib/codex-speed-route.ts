import type { CodexSpeedRouteFacts } from '@canopy/execution-engine/lib/codex-speed-availability';
import type { ReadCodexSpeedRouteRequest } from '@canopy/execution-engine/types/codex-speed-capabilities';

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null) return false;
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return Object.keys(value).every((key) => keys.includes(key));
}

function isId(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length <= 512 &&
    /^[a-z0-9][a-z0-9-]*$/.test(value)
  );
}

function isModel(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512;
}

/** Validate the portable input without accepting renderer route assertions. */
export function isCodexSpeedReadRouteRequest(
  value: unknown,
): value is ReadCodexSpeedRouteRequest {
  if (
    !isPlainRecord(value) ||
    !hasOnlyKeys(value, ['context', 'model', 'modelSelection'])
  )
    return false;
  if (
    value.model !== undefined &&
    value.model !== null &&
    !isModel(value.model)
  )
    return false;
  if (
    value.modelSelection !== undefined &&
    value.modelSelection !== 'explicit' &&
    value.modelSelection !== 'auto'
  )
    return false;
  const context = value.context;
  if (!isPlainRecord(context)) return false;
  switch (context.kind) {
    case 'defaults':
      return hasOnlyKeys(context, ['kind']);
    case 'home':
      return (
        hasOnlyKeys(context, [
          'kind',
          'projectId',
          'billingFramework',
          'executionHarness',
        ]) &&
        (context.projectId === undefined || isId(context.projectId)) &&
        (context.billingFramework === undefined ||
          context.billingFramework === 'subscription' ||
          context.billingFramework === 'ai-credits') &&
        (context.executionHarness === undefined ||
          context.executionHarness === 'claude' ||
          context.executionHarness === 'codex' ||
          context.executionHarness === 'cursor')
      );
    case 'chat':
      return (
        hasOnlyKeys(context, ['kind', 'projectId', 'worktreeId', 'chatId']) &&
        isId(context.projectId) &&
        isId(context.worktreeId) &&
        isId(context.chatId)
      );
    default:
      return false;
  }
}

/** Validate the sanitized host result before exposing it to the renderer. */
export function isCodexSpeedRouteFacts(
  value: unknown,
): value is CodexSpeedRouteFacts {
  if (
    !isPlainRecord(value) ||
    !hasOnlyKeys(value, [
      'modelSelection',
      'runtimeModel',
      'equivalentModels',
      'modelSource',
      'harness',
      'routeProfile',
    ])
  )
    return false;
  if (value.modelSelection !== 'explicit' && value.modelSelection !== 'auto')
    return false;
  if (value.runtimeModel !== null && !isModel(value.runtimeModel)) return false;
  if (
    value.equivalentModels !== undefined &&
    (!Array.isArray(value.equivalentModels) ||
      value.equivalentModels.length > 100 ||
      !value.equivalentModels.every(isModel))
  )
    return false;
  if (
    value.modelSource !== null &&
    value.modelSource !== 'claude-managed' &&
    value.modelSource !== 'codex-managed' &&
    value.modelSource !== 'cursor-managed' &&
    value.modelSource !== 'ai-gateway' &&
    value.modelSource !== 'ollama'
  )
    return false;
  if (
    value.harness !== null &&
    value.harness !== 'claude' &&
    value.harness !== 'codex' &&
    value.harness !== 'cursor'
  )
    return false;
  return (
    value.routeProfile === 'codex-native' ||
    value.routeProfile === 'account-proxy' ||
    value.routeProfile === 'ai-credits' ||
    value.routeProfile === 'org-gateway' ||
    value.routeProfile === 'ollama' ||
    value.routeProfile === 'cursor' ||
    value.routeProfile === 'foreign' ||
    value.routeProfile === 'unknown'
  );
}
