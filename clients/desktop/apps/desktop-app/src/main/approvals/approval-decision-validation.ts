import type {
  ApprovalPromptDecision,
  ApprovalRuleTarget,
} from '@canopy/desktop-shared/types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isApprovalRuleTarget(value: unknown): value is ApprovalRuleTarget {
  if (!isRecord(value)) return false;
  switch (value.kind) {
    case 'command':
      return isNonEmptyString(value.pattern);
    case 'file-write':
      return isNonEmptyString(value.path);
    case 'mcp':
      return (
        isNonEmptyString(value.server) &&
        (value.tool === undefined || isNonEmptyString(value.tool))
      );
    case 'network':
      return isNonEmptyString(value.host);
    case 'tool':
      return isNonEmptyString(value.toolName);
    case 'browser-upload':
      return (
        isNonEmptyString(value.origin) &&
        (value.path === undefined || isNonEmptyString(value.path))
      );
    default:
      return false;
  }
}

/** Runtime validation for renderer-originated approval decisions. */
export function isApprovalPromptDecision(
  value: unknown,
): value is ApprovalPromptDecision {
  if (!isRecord(value)) return false;
  if (value.behavior !== 'allow' && value.behavior !== 'deny') return false;
  if (
    value.scope !== 'once' &&
    value.scope !== 'session' &&
    value.scope !== 'project' &&
    value.scope !== 'global'
  ) {
    return false;
  }
  if (value.scope === 'once') {
    if (value.target !== undefined) return false;
  } else if (!isApprovalRuleTarget(value.target)) {
    return false;
  }
  if (value.message !== undefined && typeof value.message !== 'string') {
    return false;
  }
  if (value.stopTurn !== undefined && typeof value.stopTurn !== 'boolean') {
    return false;
  }
  if (
    value.behavior === 'allow' &&
    (value.message !== undefined || value.stopTurn !== undefined)
  ) {
    return false;
  }
  return true;
}
