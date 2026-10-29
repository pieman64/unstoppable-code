import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  isLiveSubagentStatus,
  type SubagentNode,
} from '@canopy/agent-transcript';
import type { AgentDelegationTranscriptItem } from '@canopy/protocol/delegation';
import type { ManagedDelegationTranscriptPageResult } from '@canopy/desktop-shared/types';
import type { ChatMessage } from '@/stores/chatStore';
import { subagentScopeKey, type SubagentHostScope } from './subagent-scope';

const TRANSCRIPT_PAGE_SIZE = 100;
/**
 * How often an open chat re-reads its subagent's running run. The root chat
 * commits an idle parent's delegate card at most every 10 seconds, so the
 * chat reads the live run itself.
 */
const LIVE_REFRESH_MS = 1_000;

export interface SubagentTranscriptPageRun {
  readonly task: {
    readonly description: string;
    readonly prompt: string;
    readonly executionMode: 'foreground' | 'background';
  };
  readonly messages: readonly ChatMessage[];
  /**
   * The page holds the run's latest rows, so it replaces the root chat's copy
   * of them. Their row IDs differ, so the two cannot be merged.
   */
  readonly replacesRootRows: boolean;
}

export interface SubagentTranscriptPagesQuery {
  readonly runs: ReadonlyMap<number, SubagentTranscriptPageRun>;
  readonly hasOlder: boolean;
  readonly loadingOlder: boolean;
  readonly error?: string;
  readonly onLoadOlder: () => void;
}

interface RunPage extends SubagentTranscriptPageRun {
  /** The earliest loaded page reported more items before it. */
  readonly hasMore: boolean;
  /** An older page was read, so `hasMore` describes that page. */
  readonly olderLoaded: boolean;
  /** An older read reached the run's first item. */
  readonly exhausted: boolean;
  /** Fingerprint of the latest page, to skip refreshes that changed nothing. */
  readonly latestSignature?: string;
}

interface PagesState {
  readonly key: string;
  readonly runs: ReadonlyMap<number, RunPage>;
  readonly loadingOlder: boolean;
  readonly error?: string;
}

const EMPTY_RUNS: ReadonlyMap<number, SubagentTranscriptPageRun> = new Map();

function runAgentBlockId(node: SubagentNode, runGeneration: number): string {
  const run = node.runs.find(
    (candidate) => candidate.runGeneration === runGeneration,
  );
  if (run?.agentBlockId) return run.agentBlockId;
  return `delegated-agent-${node.id}${runGeneration > 1 ? `-run-${runGeneration}` : ''}`;
}

function messageFromItem(
  item: AgentDelegationTranscriptItem,
  agentBlockId: string,
): ChatMessage {
  const id = `${agentBlockId}:${item.id}`;
  const blocks: ChatMessage['blocks'] =
    item.type === 'tool'
      ? [
          {
            type: 'tool_use',
            toolUseId: id,
            toolName: item.toolName,
            input: item.input,
          },
          ...(item.output !== undefined
            ? [
                {
                  type: 'tool_result' as const,
                  toolUseId: id,
                  toolName: item.toolName,
                  output: item.output,
                  isError: item.isError === true,
                },
              ]
            : []),
        ]
      : [{ type: item.type, text: item.text }];
  return {
    id,
    role: item.type === 'text' && item.author ? 'user' : 'assistant',
    timestamp: item.occurredAt,
    parentBlockId: agentBlockId,
    delegationSequence: item.sequence,
    ...(item.type === 'text' && item.author
      ? { delegationAuthor: item.author }
      : {}),
    ...(item.type === 'text' && item.delivery
      ? { delegationDelivery: item.delivery }
      : {}),
    blocks,
  };
}

function directRunMessages(
  messages: readonly ChatMessage[],
  agentBlockId: string,
): readonly ChatMessage[] {
  return messages.filter(
    (message) =>
      message.parentBlockId === agentBlockId ||
      message.parentToolUseId === agentBlockId,
  );
}

function firstSequence(messages: readonly ChatMessage[]): number | undefined {
  return messages.reduce<number | undefined>((first, message) => {
    const sequence = message.delegationSequence;
    return sequence !== undefined && (first === undefined || sequence < first)
      ? sequence
      : first;
  }, undefined);
}

function mergeTranscriptItems(
  current: readonly ChatMessage[],
  incoming: readonly ChatMessage[],
): ChatMessage[] {
  const messages: ChatMessage[] = [];
  const indexById = new Map<string, number>();
  for (const message of current) {
    indexById.set(message.id, messages.length);
    messages.push(message);
  }
  for (const message of incoming) {
    const existingIndex = indexById.get(message.id);
    if (existingIndex === undefined) {
      indexById.set(message.id, messages.length);
      messages.push(message);
    } else {
      messages[existingIndex] = message;
    }
  }
  return messages.sort(
    (left, right) =>
      (left.delegationSequence ?? 0) - (right.delegationSequence ?? 0) ||
      left.timestamp - right.timestamp,
  );
}

// Covers every item field, so an edit that keeps an item's length still
// replaces the cached page.
function pageSignature(
  page: Extract<ManagedDelegationTranscriptPageResult, { ok: true }>,
): string {
  return JSON.stringify([page.task.prompt, page.hasMore, page.items]);
}

/** The run's direct rows: its page alone, or the root chat's plus older pages. */
function runRows(
  page: RunPage | undefined,
  rootRows: readonly ChatMessage[],
): readonly ChatMessage[] {
  if (!page) return rootRows;
  return page.replacesRootRows
    ? page.messages
    : mergeTranscriptItems(rootRows, page.messages);
}

function runHasOlder(
  page: RunPage | undefined,
  rows: readonly ChatMessage[],
): boolean {
  if (page?.exhausted) return false;
  return page?.hasMore === true || (firstSequence(rows) ?? 0) > 1;
}

/**
 * Reads a managed subagent's runs from its delegation record. Every run the
 * root chat has no rows for is read once, and a running run is re-read while
 * the chat is open so it updates as the subagent works. Earlier runs stay
 * loaded when a follow-up starts a new one.
 */
export function useSubagentTranscriptPages(
  scope: SubagentHostScope,
  rootChatId: string,
  node: SubagentNode | undefined,
  rootMessages: readonly ChatMessage[],
  options: { readonly enabled: boolean },
): SubagentTranscriptPagesQuery {
  const managed = node?.kind === 'managed' ? node : undefined;
  const scopeKey = subagentScopeKey(scope);
  const key = managed ? `${scopeKey}/${rootChatId}/${managed.id}` : undefined;
  const generations = useMemo(
    (): readonly number[] =>
      managed
        ? Array.from(
            new Set(managed.runs.map((run) => run.runGeneration)),
          ).sort((left, right) => left - right)
        : [],
    [managed],
  );
  const latestGeneration = generations[generations.length - 1];
  const status = managed?.status;
  const live = status !== undefined && isLiveSubagentStatus(status);
  const rootRowsByRun = useMemo(
    (): ReadonlyMap<number, readonly ChatMessage[]> =>
      new Map(
        managed
          ? generations.map((generation) => [
              generation,
              directRunMessages(
                rootMessages,
                runAgentBlockId(managed, generation),
              ),
            ])
          : [],
      ),
    [generations, managed, rootMessages],
  );
  const [state, setState] = useState<PagesState | null>(null);
  const current = state !== null && state.key === key ? state : undefined;
  const keyRef = useRef(key);
  keyRef.current = key;
  const inFlight = useRef(new Set<string>());
  const requested = useRef(new Map<string, string>());
  // The latest transcript revision read per run, so a live re-read can ask
  // for items only when something changed.
  const revisions = useRef(new Map<string, number>());
  const projectId = scope.projectId;
  const worktreeId = scope.worktreeId;

  const readPage = useCallback(
    async (
      runGeneration: number,
      beforeSequence?: number,
      sinceRevision?: number,
    ): Promise<void> => {
      if (!managed || key === undefined) return;
      const flight = `${key}/${runGeneration}/${beforeSequence ?? 'latest'}`;
      if (inFlight.current.has(flight)) return;
      inFlight.current.add(flight);
      const loadOlder = beforeSequence !== undefined;
      const emptyState: PagesState = {
        key,
        runs: new Map(),
        loadingOlder: false,
      };
      if (loadOlder)
        setState((previous) => ({
          ...(previous?.key === key ? previous : emptyState),
          loadingOlder: true,
          error: undefined,
        }));
      try {
        const result = await window.api.managedDelegation.transcriptPage({
          projectId,
          worktreeId,
          chatId: rootChatId,
          delegationId: managed.id,
          runGeneration,
          ...(beforeSequence !== undefined ? { beforeSequence } : {}),
          ...(sinceRevision !== undefined ? { sinceRevision } : {}),
          limit: TRANSCRIPT_PAGE_SIZE,
        });
        if (keyRef.current !== key) return;
        if (!result.ok) {
          setState((previous) => ({
            ...(previous?.key === key ? previous : emptyState),
            loadingOlder: false,
            error: result.error,
          }));
          return;
        }
        if (!loadOlder)
          revisions.current.set(`${key}/${runGeneration}`, result.revision);
        if (result.unchanged) return;
        const agentBlockId = runAgentBlockId(managed, runGeneration);
        const signature = loadOlder ? undefined : pageSignature(result);
        setState((previous) => {
          const base = previous?.key === key ? previous : emptyState;
          const existing = base.runs.get(runGeneration);
          if (
            !loadOlder &&
            existing?.replacesRootRows === true &&
            existing.latestSignature === signature
          )
            return base.error === undefined
              ? base
              : { ...base, error: undefined };
          const incoming = result.items.map((item) =>
            messageFromItem(item, agentBlockId),
          );
          // A latest read is authoritative for its window: an item it no
          // longer has (such as a message the broker moved into the next
          // run) leaves the cache. Older items below the window stay.
          const windowStart =
            loadOlder || !result.hasMore
              ? Number.NEGATIVE_INFINITY
              : (firstSequence(incoming) ?? Number.NEGATIVE_INFINITY);
          const incomingIds = new Set(incoming.map((message) => message.id));
          const retained = (existing?.messages ?? []).filter(
            (message) =>
              loadOlder ||
              incomingIds.has(message.id) ||
              (message.delegationSequence ?? 0) < windowStart,
          );
          const runs = new Map(base.runs);
          runs.set(runGeneration, {
            task: {
              description: result.task.description,
              prompt: result.task.prompt,
              executionMode: result.task.executionMode,
            },
            messages: mergeTranscriptItems(retained, incoming),
            hasMore:
              loadOlder || existing?.olderLoaded !== true
                ? result.hasMore
                : existing.hasMore,
            olderLoaded: loadOlder || existing?.olderLoaded === true,
            exhausted:
              existing?.exhausted === true || (loadOlder && !result.hasMore),
            replacesRootRows: !loadOlder || existing?.replacesRootRows === true,
            ...((signature ?? existing?.latestSignature) !== undefined
              ? { latestSignature: signature ?? existing?.latestSignature }
              : {}),
          });
          return {
            key,
            runs,
            loadingOlder: loadOlder ? false : base.loadingOlder,
          };
        });
      } catch (error: unknown) {
        if (keyRef.current !== key) return;
        setState((previous) => ({
          ...(previous?.key === key ? previous : emptyState),
          loadingOlder: false,
          error:
            error instanceof Error ? error.message : 'Transcript unavailable.',
        }));
      } finally {
        inFlight.current.delete(flight);
      }
    },
    [key, managed, projectId, rootChatId, worktreeId],
  );

  // Read each run the root chat lacks, and re-read the latest run when its
  // status changes while it is read from its record.
  useEffect(() => {
    if (!options.enabled || !managed || key === undefined) return;
    for (const generation of generations) {
      const latest = generation === latestGeneration;
      const page = current?.runs.get(generation);
      const missingRows = (rootRowsByRun.get(generation)?.length ?? 0) === 0;
      // A run read while it was the latest is read once more after a
      // continuation starts: the broker may move its last message into the
      // new run.
      if (!missingRows && !(latest && live) && page?.replacesRootRows !== true)
        continue;
      const token = latest ? `status:${status ?? ''}` : 'once';
      const requestKey = `${key}/${generation}`;
      if (requested.current.get(requestKey) === token) continue;
      requested.current.set(requestKey, token);
      void readPage(generation);
    }
  }, [
    current,
    generations,
    key,
    latestGeneration,
    live,
    managed,
    options.enabled,
    readPage,
    rootRowsByRun,
    status,
  ]);

  // Follow a running run as the subagent works.
  useEffect(() => {
    if (!options.enabled || !live || latestGeneration === undefined)
      return undefined;
    const timer = setInterval((): void => {
      void readPage(
        latestGeneration,
        undefined,
        revisions.current.get(`${key ?? ''}/${latestGeneration}`),
      );
    }, LIVE_REFRESH_MS);
    return (): void => clearInterval(timer);
  }, [key, latestGeneration, live, options.enabled, readPage]);

  useEffect(
    () => (): void => {
      inFlight.current.clear();
      requested.current.clear();
      revisions.current.clear();
    },
    [key],
  );

  const olderRun = useMemo((): number | undefined => {
    for (const generation of generations) {
      const page = current?.runs.get(generation);
      const rows = runRows(page, rootRowsByRun.get(generation) ?? []);
      if (rows.length > 0 && runHasOlder(page, rows)) return generation;
    }
    return undefined;
  }, [current, generations, rootRowsByRun]);
  const hasOlder = olderRun !== undefined;

  const onLoadOlder = useCallback((): void => {
    if (!options.enabled || olderRun === undefined) return;
    const rows = runRows(
      current?.runs.get(olderRun),
      rootRowsByRun.get(olderRun) ?? [],
    );
    void readPage(olderRun, firstSequence(rows));
  }, [current, olderRun, options.enabled, readPage, rootRowsByRun]);

  const runs = useMemo(
    (): ReadonlyMap<number, SubagentTranscriptPageRun> =>
      current ? current.runs : EMPTY_RUNS,
    [current],
  );

  return {
    runs,
    hasOlder,
    loadingOlder: current?.loadingOlder === true,
    ...(current?.error !== undefined ? { error: current.error } : {}),
    onLoadOlder,
  };
}
