import type { MemorySearchFact } from '@canopy/protocol/memory';
import type { AppliedOrgMemoryTurn } from '../types';
import { normalizeUuid } from './workspace-owner';

const MAX_FACTS_PER_TURN = 8;
const MAX_FACT_TEXT_LENGTH = 500;
const MAX_VALID_AT_LENGTH = 64;
const MAX_SOURCE_TURN_IDS = 16;
const MAX_SOURCE_TURN_ID_LENGTH = 256;
const MAX_FACT_ID_LENGTH = 64;
const MAX_SEARCH_ID_LENGTH = 64;

const MAX_MEMORY_SEARCH_ORGANIZATIONS = 256;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Normalizes an organization external id (a UUID) to its lowercase form, or
 * returns `null` when the value is not a UUID. Organization memory keys every
 * search, delivery ack, and feedback call by this id (CAN-3457), so a malformed
 * value must never reach a request.
 */
export function normalizeOrganizationExternalId(value: unknown): string | null {
  return normalizeUuid(value);
}

/**
 * Normalizes the account response's organization-memory eligibility into the
 * list of organizations the user may search (CAN-3457).
 *
 * - The list drops malformed values and duplicates and lowercases the UUIDs.
 * - A response without the list but with the deprecated single-org field (an
 *   older server) is read as `[legacyId]`. This is not a fallback to another
 *   org: the owning org is still searched only when it appears in the list.
 */
export function normalizeMemorySearchOrganizationExternalIds(
  list: unknown,
  legacyId: unknown,
): string[] {
  const source: unknown[] = Array.isArray(list)
    ? list
    : legacyId === undefined
      ? []
      : [legacyId];
  const normalized: string[] = [];
  for (const raw of source.slice(0, MAX_MEMORY_SEARCH_ORGANIZATIONS)) {
    const id = normalizeOrganizationExternalId(raw);
    if (id !== null && !normalized.includes(id)) normalized.push(id);
  }
  return normalized;
}

export function normalizeOrgMemoryFacts(value: unknown): MemorySearchFact[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, MAX_FACTS_PER_TURN).flatMap((rawFact) => {
    if (
      !isRecord(rawFact) ||
      typeof rawFact.factText !== 'string' ||
      rawFact.factText.trim().length === 0 ||
      (rawFact.validAt !== null && typeof rawFact.validAt !== 'string') ||
      !Array.isArray(rawFact.sourceTurnIds)
    ) {
      return [];
    }
    const sourceTurnIds = rawFact.sourceTurnIds
      .filter((id): id is string => typeof id === 'string')
      .slice(0, MAX_SOURCE_TURN_IDS)
      .map((id) => id.slice(0, MAX_SOURCE_TURN_ID_LENGTH));
    return [
      {
        // factId and the turn-level searchId gate per-occurrence feedback;
        // facts persisted before ids were exposed stay read-only.
        ...(typeof rawFact.factId === 'string' &&
        rawFact.factId.trim().length > 0
          ? { factId: rawFact.factId.slice(0, MAX_FACT_ID_LENGTH) }
          : {}),
        factText: rawFact.factText.slice(0, MAX_FACT_TEXT_LENGTH),
        validAt:
          typeof rawFact.validAt === 'string'
            ? rawFact.validAt.slice(0, MAX_VALID_AT_LENGTH)
            : null,
        sourceTurnIds,
      },
    ];
  });
}

export function normalizeOrgMemoryTurn(
  value: unknown,
): AppliedOrgMemoryTurn | null {
  if (!isRecord(value)) return null;
  const facts = normalizeOrgMemoryFacts(value.facts);
  const organizationExternalId = normalizeOrganizationExternalId(
    value.organizationExternalId,
  );
  return facts.length > 0
    ? {
        // The org that was searched (CAN-3457). Turns persisted before it was
        // recorded keep their facts but lose feedback, which needs the org.
        ...(organizationExternalId === null ? {} : { organizationExternalId }),
        ...(typeof value.searchId === 'string' &&
        value.searchId.trim().length > 0
          ? { searchId: value.searchId.trim().slice(0, MAX_SEARCH_ID_LENGTH) }
          : {}),
        facts,
      }
    : null;
}

export function normalizeMemoryByMessageId(
  value: unknown,
  userMessageIds?: ReadonlySet<string>,
): Record<string, AppliedOrgMemoryTurn> | undefined {
  if (!isRecord(value)) return undefined;
  const normalized: Record<string, AppliedOrgMemoryTurn> = {};
  for (const [messageId, rawTurn] of Object.entries(value)) {
    if (userMessageIds && !userMessageIds.has(messageId)) continue;
    const turn = normalizeOrgMemoryTurn(rawTurn);
    if (turn) {
      normalized[messageId] = turn;
    }
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}
