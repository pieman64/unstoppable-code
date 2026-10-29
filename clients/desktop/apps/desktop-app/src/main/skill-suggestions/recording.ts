import { isSkillSuggestionDraftPrompt } from '@canopy/desktop-shared/lib/skill-suggestions';
import {
  localDay,
  prepareExcerpt,
  type ChatChainFingerprint,
  type FingerprintStore,
  type TurnFingerprint,
} from './fingerprint-store';
import {
  countContentTokens,
  normalizePromptTokens,
  skillsInToolShape,
} from './normalize';
import type { SkillSuggestionPartition } from './partition';

/**
 * One builder for live and backfilled turns (CAN-385), so both paths apply
 * the same noise filter and produce the same row for the same message.
 */
export const MIN_CONTENT_TOKENS = 4;
const MAX_CHAIN_SKILLS = 50;

export interface TurnFingerprintInput {
  projectId: string;
  worktreeId: string;
  chatId: string;
  /** Transcript row id of the user message. */
  userMessageId: string;
  auditEntryId?: string;
  promptText: string;
  tools: readonly string[];
  createdAt: number;
  status: string;
}

/**
 * The fingerprint for a turn, or `null` for noise: fewer than four content
 * tokens and no skill invoked ("continue", "yes", "fix it"). A turn that
 * invokes a skill is always kept, so skill chains are seen.
 */
export function buildTurnFingerprint(
  input: TurnFingerprintInput,
  partition: SkillSuggestionPartition,
): TurnFingerprint | null {
  // A sent drafting prompt is the suggestion itself, not a repeated task.
  if (isSkillSuggestionDraftPrompt(input.promptText)) return null;
  // Tokens come from the redacted excerpt so no secret fragment is stored.
  const excerpt = prepareExcerpt(input.promptText);
  const tokens = normalizePromptTokens(excerpt);
  const invokesSkill = skillsInToolShape(input.tools).length > 0;
  if (!invokesSkill && countContentTokens(tokens) < MIN_CONTENT_TOKENS) {
    return null;
  }
  return {
    kind: 'turn',
    projectId: input.projectId,
    worktreeId: input.worktreeId,
    chatId: input.chatId,
    userMessageId: input.userMessageId,
    ...(input.auditEntryId ? { auditEntryId: input.auditEntryId } : {}),
    partition: partition.key,
    createdAt: input.createdAt,
    day: localDay(input.createdAt),
    excerpt,
    tokens,
    tools: [...input.tools],
    status: input.status,
  };
}

/** Appends a turn's skills to its chat's ordered skill sequence. */
export function extendChatChain(
  previous: ChatChainFingerprint | null,
  turn: TurnFingerprint,
): ChatChainFingerprint | null {
  const skills = skillsInToolShape(turn.tools);
  if (skills.length === 0) return null;
  return {
    kind: 'chat_chain',
    projectId: turn.projectId,
    worktreeId: turn.worktreeId,
    chatId: turn.chatId,
    partition: turn.partition,
    skills: [...(previous?.skills ?? []), ...skills].slice(-MAX_CHAIN_SKILLS),
    lastActivityAt: turn.createdAt,
    day: turn.day,
  };
}

/**
 * Latest chain row per chat, loaded once from the store and kept current by
 * every append, so a live turn never re-reads the fingerprint file.
 */
export class ChatChainCache {
  private chains: Map<string, ChatChainFingerprint> | null = null;
  private loading: Promise<Map<string, ChatChainFingerprint>> | null = null;
  private generation = 0;

  constructor(private readonly store: FingerprintStore) {}

  private async load(): Promise<Map<string, ChatChainFingerprint>> {
    if (this.chains) return this.chains;
    const generation = this.generation;
    this.loading ??= this.store.read().then(
      (rows) => {
        const chains = new Map<string, ChatChainFingerprint>();
        for (const row of rows) {
          if (row.kind === 'chat_chain') chains.set(row.chatId, row);
        }
        // A read that started before a reset never repopulates the cache.
        if (generation === this.generation) this.chains = chains;
        return chains;
      },
      (error: unknown) => {
        // A failed read is retried by the next turn, not cached.
        if (generation === this.generation) this.loading = null;
        throw error;
      },
    );
    return this.loading;
  }

  async get(chatId: string): Promise<ChatChainFingerprint | null> {
    // A reset while waiting means the awaited map is stale; read again.
    for (;;) {
      const generation = this.generation;
      const chains = await this.load();
      if (generation === this.generation) return chains.get(chatId) ?? null;
    }
  }

  async set(chain: ChatChainFingerprint): Promise<void> {
    (await this.load()).set(chain.chatId, chain);
  }

  reset(): void {
    this.generation += 1;
    this.chains = null;
    this.loading = null;
  }
}
