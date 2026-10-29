import { readdir } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { isUserTurnBoundary } from '@canopy/agent-transcript/lib/turn-boundary';
import { isHumanAuthoredUserMessage } from '@canopy/agent-transcript/transcript-storage';
import {
  COWORK_HOME_WORKTREE_ID,
  type ArchivedChatsFile,
  type ChatTabsFile,
  type PersistedChatMessage,
  type PersistedChatTab,
} from '@canopy/desktop-shared/types';
import {
  getArchivedContainerChatStorage,
  readArchivedContainerManifest,
} from '../lib/archived-containers';
import { logMainProcessWarn } from '../lib/main-process-logging';
import {
  getArchivedContainersRootDir,
  getWorkspaceChatArchivesFilePath,
  getWorkspaceChatHistoryRootDir,
  getWorkspaceChatTabsFilePath,
  getWorkspacesRootDir,
} from '../lib/paths';
import {
  getStandaloneHistoryStorage,
  readArchiveMetaForIndex,
} from '../lib/standalone-history';
import { ChatStateV2Backend } from '../services/chat-state-v2-backend';
import {
  FINGERPRINT_RETENTION_MS,
  type ChatChainFingerprint,
  type FingerprintRow,
  type FingerprintStore,
} from './fingerprint-store';
import {
  appendToolShape,
  leadingSkillInvocation,
  MAX_PROMPT_INPUT_CHARS,
  toolShapeEntry,
} from './normalize';
import {
  resolveTurnPartition,
  type SkillSuggestionPartition,
} from './partition';
import { buildTurnFingerprint, extendChatChain } from './recording';
import type { SkillSuggestionsRegistry } from './registry';
import type { TimeSlicer } from './time-slicer';

/**
 * First-scan backfill for repeat-task skill suggestions (CAN-385): a bounded,
 * read-only, resumable walk over recent live chat transcripts. Every row is
 * pulled out in time slices so one large transcript never blocks main, and
 * the run stops at its next yield when a chat becomes busy or the gate
 * closes. Live transcripts are read through the chat state service's preview
 * projection, the same read chat search uses.
 */
export const BACKFILL_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
export const BACKFILL_MAX_CHATS = 300;
export const BACKFILL_MAX_TURNS_PER_CHAT = 200;

/** Where an archived chat's transcript lives. */
export type BackfillArchiveSource =
  | 'worktree-archive'
  | 'cowork-archive'
  | 'archived-container';

export interface BackfillChatRef {
  projectId: string;
  worktreeId: string;
  chatId: string;
  lastActivityAt: number;
  /** Set for an archived chat; a live chat when omitted. */
  source?: BackfillArchiveSource;
}

export interface ExtractedTurn {
  userMessageId: string;
  text: string;
  timestamp: number;
  tools: string[];
}

export interface ExtractedChat {
  turns: ExtractedTurn[];
  automation: boolean;
  /** The walk stopped at the turn cap before the last row. */
  capped?: boolean;
}

function isArchiveSource(value: unknown): value is BackfillArchiveSource {
  return (
    value === 'worktree-archive' ||
    value === 'cowork-archive' ||
    value === 'archived-container'
  );
}

/** Cursor entry; live chats keep the original three-id shape. */
function chatKey(ref: Omit<BackfillChatRef, 'lastActivityAt'>): string {
  const ids = [ref.projectId, ref.worktreeId, ref.chatId];
  return JSON.stringify(ref.source ? [...ids, ref.source] : ids);
}

function parseChatKey(
  key: string,
): Omit<BackfillChatRef, 'lastActivityAt'> | null {
  try {
    const parsed: unknown = JSON.parse(key);
    if (!Array.isArray(parsed) || (parsed.length !== 3 && parsed.length !== 4))
      return null;
    const fields: unknown[] = parsed;
    const projectId = fields[0];
    const worktreeId = fields[1];
    const chatId = fields[2];
    const source = fields[3];
    if (
      typeof projectId === 'string' &&
      typeof worktreeId === 'string' &&
      typeof chatId === 'string' &&
      projectId &&
      worktreeId &&
      chatId
    ) {
      if (source === undefined) return { projectId, worktreeId, chatId };
      if (isArchiveSource(source))
        return { projectId, worktreeId, chatId, source };
    }
  } catch {
    // Ignored: a malformed cursor entry is skipped.
  }
  return null;
}

/**
 * File tabs and managed terminal chats are skipped, matching the live
 * recorder, which never records terminal turns.
 */
function isRecordableTab(tab: {
  kind?: string;
  interfaceMode?: string | null;
}): boolean {
  return (
    tab.kind !== 'file' &&
    tab.interfaceMode !== 'claude-code' &&
    tab.interfaceMode !== 'auto'
  );
}

function userText(message: PersistedChatMessage): string {
  const parts: string[] = [];
  let length = 0;
  for (const block of message.blocks) {
    if (block.type !== 'text') continue;
    parts.push(block.text);
    length += block.text.length;
    if (length >= MAX_PROMPT_INPUT_CHARS) break;
  }
  return parts.join('\n').slice(0, MAX_PROMPT_INPUT_CHARS);
}

function skillFromInput(input: string): { skill?: unknown } | undefined {
  if (input.length > 2000) return undefined;
  try {
    const parsed: unknown = JSON.parse(input);
    return parsed !== null && typeof parsed === 'object' && 'skill' in parsed
      ? { skill: parsed.skill }
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Splits a transcript into human-authored turns inside the window. Rows
 * older than `cutoff` are skipped by timestamp without reading their blocks.
 * A chat with an automation block is reported so the caller skips it.
 * Returns `null` when the slicer stops the walk.
 */
export async function extractChatTurns(
  messages: AsyncIterable<PersistedChatMessage>,
  options: { cutoff: number; slicer: TimeSlicer; maxTurns?: number },
): Promise<ExtractedChat | null> {
  const maxTurns = options.maxTurns ?? BACKFILL_MAX_TURNS_PER_CHAT;
  const turns: ExtractedTurn[] = [];
  let current: ExtractedTurn | null = null;
  for await (const message of messages) {
    if (!(await options.slicer.tick())) return null;
    if (message.timestamp < options.cutoff) continue;
    if (message.blocks.some((block) => block.type === 'automation_info')) {
      return { turns: [], automation: true };
    }
    if (message.role === 'user') {
      if (
        message.hidden === true ||
        !isHumanAuthoredUserMessage(message) ||
        !isUserTurnBoundary(message)
      ) {
        continue;
      }
      if (turns.length >= maxTurns)
        return { turns, automation: false, capped: true };
      const text = userText(message);
      const tools: string[] = [];
      const leading = leadingSkillInvocation(text);
      if (leading) appendToolShape(tools, `skill:${leading}`);
      current = {
        userMessageId: message.id,
        text,
        timestamp: message.timestamp,
        tools,
      };
      turns.push(current);
      continue;
    }
    if (!current || message.role !== 'assistant' || message.parentToolUseId) {
      continue;
    }
    for (const block of message.blocks) {
      if (block.type !== 'tool_use') continue;
      const entry = toolShapeEntry(
        block.toolName,
        block.toolName === 'Skill' ? skillFromInput(block.input) : undefined,
      );
      if (entry) appendToolShape(current.tools, entry);
    }
  }
  return { turns, automation: false };
}

export interface BackfillDeps {
  store: FingerprintStore;
  registry: SkillSuggestionsRegistry;
  slicer: TimeSlicer;
  now: () => number;
  /** Re-checked before every write; a closed gate discards the result. */
  isAllowed: () => boolean;
  listChats: (now: number) => Promise<BackfillChatRef[]>;
  readTranscript: <T>(
    ref: Omit<BackfillChatRef, 'lastActivityAt'>,
    consume: (messages: AsyncIterable<PersistedChatMessage>) => Promise<T>,
  ) => Promise<T>;
  resolvePartition: (
    ref: Omit<BackfillChatRef, 'lastActivityAt'>,
  ) => Promise<SkillSuggestionPartition | null>;
}

export type BackfillResult = 'done' | 'cancelled';

/** Runs or resumes the backfill from its persisted cursor. */
export async function runBackfill(deps: BackfillDeps): Promise<BackfillResult> {
  const now = deps.now();
  const state = await deps.registry.read();
  if (state.backfill.done) return 'done';
  let snapshot = state.backfill.chatIdsSnapshot;
  let index = state.backfill.nextChatIndex;
  if (!snapshot) {
    const chats = await deps.listChats(now);
    if (!deps.isAllowed() || deps.slicer.stopped) return 'cancelled';
    snapshot = chats.map((ref) => chatKey(ref));
    index = 0;
    const saved = snapshot;
    await deps.registry.update((draft) => {
      draft.backfill = {
        done: false,
        nextChatIndex: 0,
        chatIdsSnapshot: saved,
      };
      return true;
    });
  }
  const cutoff = now - BACKFILL_WINDOW_MS;
  for (; index < snapshot.length; index += 1) {
    if (!deps.isAllowed() || !(await deps.slicer.tick())) return 'cancelled';
    const ref = parseChatKey(snapshot[index] ?? '');
    const rows = ref ? await backfillChat(ref, cutoff, deps) : [];
    if (rows === null) return 'cancelled';
    if (!deps.isAllowed()) return 'cancelled';
    if (rows.length > 0) await deps.store.append(rows);
    const next = index + 1;
    const advanced = await deps.registry.update((draft) => {
      // A preference-off reset during the append must not be undone.
      if (!deps.isAllowed()) return false;
      draft.backfill = {
        done: false,
        nextChatIndex: next,
        chatIdsSnapshot: draft.backfill.chatIdsSnapshot ?? snapshot,
      };
      return true;
    });
    if (advanced === false) return 'cancelled';
  }
  if (!deps.isAllowed()) return 'cancelled';
  await deps.registry.update((draft) => {
    draft.backfill = { done: true, nextChatIndex: 0 };
    return true;
  });
  return 'done';
}

async function backfillChat(
  ref: Omit<BackfillChatRef, 'lastActivityAt'>,
  cutoff: number,
  deps: BackfillDeps,
): Promise<FingerprintRow[] | null> {
  const partition = await deps.resolvePartition(ref);
  if (!partition) return [];
  let extracted: ExtractedChat | null | undefined;
  try {
    await deps.readTranscript(ref, async (messages) => {
      extracted = await extractChatTurns(messages, {
        cutoff,
        slicer: deps.slicer,
      });
    });
  } catch (error) {
    // The chat state preview fails a read the consumer stopped early (at the
    // turn cap, on an automation chat, or when the slicer stops); what was
    // extracted from the captured rows before the stop still stands.
    const stoppedEarly =
      extracted === null ||
      extracted?.automation === true ||
      extracted?.capped === true;
    if (!stoppedEarly) {
      logMainProcessWarn(
        '[skill-suggestions] backfill transcript read failed',
        { chatId: ref.chatId, error },
      );
      return [];
    }
  }
  if (extracted === undefined) return [];
  if (extracted === null) return null;
  if (extracted.automation) return [];
  const rows: FingerprintRow[] = [];
  let chain: ChatChainFingerprint | null = null;
  for (const turn of extracted.turns) {
    const row = buildTurnFingerprint(
      {
        ...ref,
        userMessageId: turn.userMessageId,
        promptText: turn.text,
        tools: turn.tools,
        createdAt: turn.timestamp,
        status: 'backfill',
      },
      partition,
    );
    if (!row) continue;
    rows.push(row);
    chain = extendChatChain(chain, row) ?? chain;
  }
  if (chain) rows.push(chain);
  return rows;
}

/** The read-only chat state operations the backfill uses. */
interface BackfillChatReader {
  getCompatibilityTabs(scope: {
    projectId: string;
    worktreeId: string;
  }): Promise<ChatTabsFile>;
  getCompatibilityArchives(scope: {
    projectId: string;
    worktreeId: string;
  }): Promise<ArchivedChatsFile>;
  consumeTranscriptPreview<T>(
    scope: { projectId: string; worktreeId: string },
    chatId: string,
    consume: (messages: AsyncIterable<PersistedChatMessage>) => Promise<T>,
  ): Promise<T>;
}

// Deferred: the chat state service is heavy and only needed while a
// backfill runs.
async function loadChatStateService(): Promise<BackfillChatReader> {
  const { getChatStateService } =
    await import('../services/chat-state-service');
  return getChatStateService();
}

async function safeReadDir(path: string): Promise<string[]> {
  try {
    return (await readdir(path, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => basename(entry.name, '.json'));
  } catch {
    return [];
  }
}

async function safeReadSubdirs(path: string): Promise<string[]> {
  try {
    return (await readdir(path, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function parsedTime(value: string | undefined): number {
  return value === undefined ? Number.NaN : Date.parse(value);
}

/** Last message time, else the given fallback (archive time), else creation. */
function tabActivity(tab: PersistedChatTab, fallback?: string): number {
  const last = tab.transcript?.lastMessageAt;
  if (typeof last === 'number' && Number.isFinite(last)) return last;
  const fallbackAt = parsedTime(fallback);
  return Number.isFinite(fallbackAt) ? fallbackAt : parsedTime(tab.createdAt);
}

export interface ChatEnumerationOptions {
  /** Only chats active since then; `null` lists every chat. */
  activeSince: number | null;
  /**
   * Archived worktrees archived before this hold no chat active after it,
   * so their chat state is never read.
   */
  containersArchivedSince: number;
}

export interface ChatEnumeration {
  refs: BackfillChatRef[];
  /** False when a chat source could not be read. */
  complete: boolean;
}

/**
 * User chats across live tabs, archived tabs of live worktrees, archived
 * Cowork chats and chats in archived worktrees. A chat listed live is never
 * listed again from an archive. App-managed chats (App Advisor, Pipeline
 * Editor, review and explore chats) live outside the user workspaces root and
 * are never listed.
 */
export async function enumerateUserChats(
  options: ChatEnumerationOptions,
): Promise<ChatEnumeration> {
  const service = await loadChatStateService();
  const refs = new Map<string, BackfillChatRef>();
  let complete = true;
  const add = (ref: BackfillChatRef): void => {
    if (!Number.isFinite(ref.lastActivityAt)) return;
    if (
      options.activeSince !== null &&
      ref.lastActivityAt < options.activeSince
    )
      return;
    const key = JSON.stringify([ref.projectId, ref.chatId]);
    if (!refs.has(key)) refs.set(key, ref);
  };
  for (const projectId of await safeReadSubdirs(getWorkspacesRootDir())) {
    const tabsDir = dirname(
      getWorkspaceChatTabsFilePath(projectId, 'placeholder'),
    );
    const manifestIds = (
      await safeReadDir(join(dirname(tabsDir), 'chat-storage-manifests'))
    ).filter((id) => !id.startsWith('plan-explore-chats-'));
    const liveIds = new Set([...(await safeReadDir(tabsDir)), ...manifestIds]);
    const archiveIds = new Set([
      ...(await safeReadDir(
        dirname(getWorkspaceChatArchivesFilePath(projectId, 'placeholder')),
      )),
      ...manifestIds,
    ]);
    // Live copies first, so an archive never shadows them.
    for (const worktreeId of Array.from(liveIds)) {
      try {
        const tabs = await service.getCompatibilityTabs({
          projectId,
          worktreeId,
        });
        for (const tab of tabs.tabs) {
          if (!isRecordableTab(tab)) continue;
          add({
            projectId,
            worktreeId,
            chatId: tab.id,
            lastActivityAt: tabActivity(tab),
          });
        }
      } catch {
        complete = false;
      }
    }
    for (const worktreeId of Array.from(archiveIds)) {
      try {
        const archives = await service.getCompatibilityArchives({
          projectId,
          worktreeId,
        });
        for (const entry of archives.archived) {
          if (!isRecordableTab(entry.tab)) continue;
          add({
            projectId,
            worktreeId,
            chatId: entry.tab.id,
            lastActivityAt: tabActivity(entry.tab, entry.archivedAt),
            source: 'worktree-archive',
          });
        }
      } catch {
        complete = false;
      }
    }
    for (const chatId of await safeReadSubdirs(
      getWorkspaceChatHistoryRootDir(projectId),
    )) {
      try {
        const meta = await readArchiveMetaForIndex(projectId, chatId);
        if (meta?.archived !== true) continue;
        const lastActivityAt = [
          meta.lastMessageAt,
          meta.archivedAt,
          meta.createdAt,
        ]
          .map(parsedTime)
          .find((time) => Number.isFinite(time));
        add({
          projectId,
          worktreeId: COWORK_HOME_WORKTREE_ID,
          chatId,
          lastActivityAt: lastActivityAt ?? Number.NaN,
          source: 'cowork-archive',
        });
      } catch {
        complete = false;
      }
    }
    for (const containerId of await safeReadSubdirs(
      getArchivedContainersRootDir(projectId),
    )) {
      let manifest;
      try {
        manifest = await readArchivedContainerManifest(projectId, containerId);
      } catch {
        // Expired, invalid or removed: its chats are no longer readable.
        continue;
      }
      if (
        manifest.restoredTo ||
        !(parsedTime(manifest.archivedAt) >= options.containersArchivedSince)
      )
        continue;
      try {
        const store = await getArchivedContainerChatStorage(
          projectId,
          containerId,
        );
        const state = await new ChatStateV2Backend(store).state();
        const entries: Array<{ tab: PersistedChatTab; archivedAt?: string }> = [
          ...state.tabsFile.tabs.map((tab) => ({ tab })),
          ...state.archivesFile.archived,
        ];
        for (const entry of entries) {
          if (!isRecordableTab(entry.tab)) continue;
          add({
            projectId,
            worktreeId: containerId,
            chatId: entry.tab.id,
            lastActivityAt: tabActivity(
              entry.tab,
              entry.archivedAt ?? manifest.archivedAt,
            ),
            source: 'archived-container',
          });
        }
      } catch {
        complete = false;
      }
    }
  }
  return { refs: Array.from(refs.values()), complete };
}

/** Chats active in the window, live and archived, newest first, capped. */
export async function listRecentChats(now: number): Promise<BackfillChatRef[]> {
  const cutoff = now - BACKFILL_WINDOW_MS;
  const { refs } = await enumerateUserChats({
    activeSince: cutoff,
    containersArchivedSince: cutoff,
  });
  return refs
    .sort((a, b) => b.lastActivityAt - a.lastActivityAt)
    .slice(0, BACKFILL_MAX_CHATS);
}

/**
 * Ids of chats that still exist and could own a retained fingerprint row, or
 * `null` when a source could not be read, so a failed read never prunes.
 */
export async function listRetainedChatIds(
  now: number,
): Promise<ReadonlySet<string> | null> {
  const { refs, complete } = await enumerateUserChats({
    activeSince: null,
    containersArchivedSince: now - FINGERPRINT_RETENTION_MS,
  });
  return complete ? new Set(refs.map((ref) => ref.chatId)) : null;
}

/**
 * Reads a transcript where it lives: live chats and archived tabs of live
 * worktrees through the chat state service preview, archived Cowork chats and
 * archived worktrees through their own V2 stores, as chat search does.
 */
export async function readChatTranscript<T>(
  ref: Omit<BackfillChatRef, 'lastActivityAt'>,
  consume: (messages: AsyncIterable<PersistedChatMessage>) => Promise<T>,
): Promise<T> {
  if (ref.source === 'cowork-archive') {
    const store = await getStandaloneHistoryStorage(ref.projectId, ref.chatId);
    if (!store) throw new Error('Archived chat is no longer available');
    return new ChatStateV2Backend(store).consumeTranscript(
      ref.chatId,
      false,
      consume,
    );
  }
  if (ref.source === 'archived-container') {
    const store = await getArchivedContainerChatStorage(
      ref.projectId,
      ref.worktreeId,
    );
    return new ChatStateV2Backend(store).consumeTranscript(
      ref.chatId,
      false,
      consume,
    );
  }
  const service = await loadChatStateService();
  return service.consumeTranscriptPreview(
    { projectId: ref.projectId, worktreeId: ref.worktreeId },
    ref.chatId,
    (messages) => consume(messages),
  );
}

export const defaultBackfillSources = {
  listChats: listRecentChats,
  readTranscript: readChatTranscript,
  resolvePartition: (
    ref: Omit<BackfillChatRef, 'lastActivityAt'>,
  ): Promise<SkillSuggestionPartition | null> => resolveTurnPartition(ref),
};
