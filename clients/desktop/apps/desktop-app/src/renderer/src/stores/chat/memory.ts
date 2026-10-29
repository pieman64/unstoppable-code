import {
  normalizeMemoryByMessageId,
  normalizeOrgMemoryFacts,
  normalizeOrgMemoryTurn,
} from '@canopy/desktop-shared/lib/org-memory';
import {
  ORG_MEMORY_USED_EVENT_TYPE,
  type AppliedOrgMemoryTurn,
  type OrgMemoryUsedEventData,
} from '@canopy/desktop-shared/types';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function parseOrgMemoryUsedEvent(
  value: unknown,
): OrgMemoryUsedEventData | null {
  if (
    !isRecord(value) ||
    value.type !== ORG_MEMORY_USED_EVENT_TYPE ||
    typeof value.localChatId !== 'string' ||
    typeof value.localMessageId !== 'string'
  ) {
    return null;
  }
  const memory = normalizeOrgMemoryTurn(value);
  return memory
    ? {
        type: ORG_MEMORY_USED_EVENT_TYPE,
        localChatId: value.localChatId,
        localMessageId: value.localMessageId,
        ...(memory.organizationExternalId === undefined
          ? {}
          : { organizationExternalId: memory.organizationExternalId }),
        ...(memory.searchId === undefined ? {} : { searchId: memory.searchId }),
        facts: memory.facts,
      }
    : null;
}

export { normalizeMemoryByMessageId, normalizeOrgMemoryFacts };

export function readPersistedMemoryByMessageId(
  value: unknown,
  userMessageIds?: Set<string>,
): Record<string, AppliedOrgMemoryTurn> | undefined {
  return isRecord(value)
    ? normalizeMemoryByMessageId(value.memoryByMessageId, userMessageIds)
    : undefined;
}
