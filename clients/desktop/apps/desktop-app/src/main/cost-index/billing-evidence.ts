import type {
  AgentAuditBillingBasis,
  AgentAuditEntry,
} from '@canopy/desktop-shared/types';

const MAX_EVIDENCE_PER_FILE = 4096;
const MAX_ENTRY_ID_LENGTH = 2048;
const MAX_SCOPE_OR_CHAT_ID_LENGTH = 2048;
const MAX_ACCOUNT_IDENTITY_LENGTH = 1024;

type SupportedBillingBasis = Extract<
  AgentAuditBillingBasis,
  'subscription' | 'api_key'
>;

interface BillingIdentity {
  readonly id: string;
  readonly projectId: string;
  readonly worktreeId: string;
  readonly chatId: string;
  readonly eventType: AgentAuditEntry['eventType'];
  readonly provider: AgentAuditEntry['provider'];
  readonly startedAt: string;
  readonly sdkSessionId: string;
  readonly providerAccountKey: string;
  readonly providerAccountEmail: string | undefined;
  readonly aiCreditsRouted: boolean;
  readonly modelGatewayRouted: boolean;
}

interface BillingEvidence {
  readonly basis: SupportedBillingBasis;
  readonly identity: BillingIdentity;
}

function isNonEmptyBoundedString(
  value: string | undefined,
  maxLength: number,
): value is string {
  return (
    value !== undefined && value.trim().length > 0 && value.length <= maxLength
  );
}

function isChatEventType(entry: AgentAuditEntry): boolean {
  return (
    entry.eventType === 'worktree_chat' ||
    entry.eventType === 'standalone_chat' ||
    entry.eventType === 'app_advisor' ||
    entry.eventType === 'worktree_plan_chat'
  );
}

function nativeRoute(entry: AgentAuditEntry): boolean {
  return entry.aiCreditsRouted !== true && entry.modelGatewayRouted !== true;
}

function normalizedStartedAt(value: string): string | null {
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function billingIdentity(entry: AgentAuditEntry): BillingIdentity | null {
  if (
    !isChatEventType(entry) ||
    !isNonEmptyBoundedString(entry.id, MAX_ENTRY_ID_LENGTH) ||
    !isNonEmptyBoundedString(entry.projectId, MAX_SCOPE_OR_CHAT_ID_LENGTH) ||
    !isNonEmptyBoundedString(entry.worktreeId, MAX_SCOPE_OR_CHAT_ID_LENGTH) ||
    !isNonEmptyBoundedString(entry.chatId, MAX_SCOPE_OR_CHAT_ID_LENGTH) ||
    !isNonEmptyBoundedString(entry.sdkSessionId, MAX_ACCOUNT_IDENTITY_LENGTH) ||
    !isNonEmptyBoundedString(
      entry.providerAccountKey,
      MAX_ACCOUNT_IDENTITY_LENGTH,
    ) ||
    (entry.providerAccountEmail !== undefined &&
      entry.providerAccountEmail.length > MAX_ACCOUNT_IDENTITY_LENGTH)
  ) {
    return null;
  }
  const startedAt = normalizedStartedAt(entry.startedAt);
  if (startedAt === null) return null;
  return {
    id: entry.id,
    projectId: entry.projectId,
    worktreeId: entry.worktreeId,
    chatId: entry.chatId,
    eventType: entry.eventType,
    provider: entry.provider,
    startedAt,
    sdkSessionId: entry.sdkSessionId,
    providerAccountKey: entry.providerAccountKey,
    providerAccountEmail: entry.providerAccountEmail,
    aiCreditsRouted: entry.aiCreditsRouted === true,
    modelGatewayRouted: entry.modelGatewayRouted === true,
  };
}

function identitiesMatch(
  left: BillingIdentity,
  right: BillingIdentity,
): boolean {
  return (
    left.id === right.id &&
    left.projectId === right.projectId &&
    left.worktreeId === right.worktreeId &&
    left.chatId === right.chatId &&
    left.eventType === right.eventType &&
    left.provider === right.provider &&
    left.startedAt === right.startedAt &&
    left.sdkSessionId === right.sdkSessionId &&
    left.providerAccountKey === right.providerAccountKey &&
    left.providerAccountEmail === right.providerAccountEmail &&
    left.aiCreditsRouted === right.aiCreditsRouted &&
    left.modelGatewayRouted === right.modelGatewayRouted
  );
}

/** Ephemeral billing evidence for one sequential audit-file pass. */
export class BillingEvidencePass {
  private readonly evidence = new Map<string, BillingEvidence>();

  public apply(entry: AgentAuditEntry): AgentAuditEntry {
    const identity = billingIdentity(entry);
    const entryId = isNonEmptyBoundedString(entry.id, MAX_ENTRY_ID_LENGTH)
      ? entry.id
      : undefined;
    const prior =
      entryId === undefined ? undefined : this.evidence.get(entryId);

    if (
      entry.billingBasis === 'subscription' ||
      entry.billingBasis === 'api_key'
    ) {
      if (identity !== null && nativeRoute(entry)) {
        this.remember(entry.id, {
          basis: entry.billingBasis,
          identity,
        });
      } else if (entryId !== undefined) {
        this.evidence.delete(entryId);
      }
      return entry;
    }

    if (
      entry.billingBasis === 'unknown' &&
      identity !== null &&
      nativeRoute(entry) &&
      prior !== undefined &&
      identitiesMatch(prior.identity, identity)
    ) {
      this.remember(entry.id, prior);
      return { ...entry, billingBasis: prior.basis };
    }

    if (entryId !== undefined) this.evidence.delete(entryId);
    return entry;
  }

  private remember(entryId: string, evidence: BillingEvidence): void {
    this.evidence.delete(entryId);
    this.evidence.set(entryId, evidence);
    if (this.evidence.size <= MAX_EVIDENCE_PER_FILE) return;
    const oldest = this.evidence.keys().next();
    if (!oldest.done) this.evidence.delete(oldest.value);
  }
}
