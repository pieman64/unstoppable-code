import type { PersistedChatMessage, TodoItem } from './types';

export const TRANSCRIPT_PAGE_SIZE = 500;
export const TOOL_OUTPUT_INLINE_BYTES = 65_536;
export const TOOL_OUTPUT_PREVIEW_HEAD_BYTES = 49_152;

export interface TranscriptDescriptor {
  format: 'complete-message-jsonl-v1';
  committedMessageCount: number;
  committedByteLength: number;
  transcriptRevision: number;
  hasActiveSidecar: boolean;
  /**
   * Hash chain over the committed rows in order, seeded by a fixed constant;
   * identifies the committed prefix content independently of its length or
   * of active-sidecar updates. Absent only on descriptors persisted before it
   * existed.
   */
  committedDigest?: string;
  /** Counts include the active suffix in scope index descriptors. */
  messageCount?: number;
  userMessageCount?: number;
  firstMessageAt?: number;
  lastMessageAt?: number;
  lastMessageId?: string;
  /** Newest user/assistant row, ignoring system/tool rows. Absent when unknown. */
  lastMessageRole?: 'user' | 'assistant';
  /** Bounded derived text for unread badges; never a transcript source. */
  lastAssistantPreview?: string;
  todos?: TodoItem[];
  taskTodos?: TodoItem[];
}

/**
 * Estimate a loaded transcript window from durable aggregate metadata without
 * traversing or serializing message bodies on an application event loop.
 */
export function estimateTranscriptWindowBytes(
  descriptor: Pick<
    TranscriptDescriptor,
    'committedByteLength' | 'committedMessageCount'
  >,
  loadedRows: number,
): number {
  if (
    !Number.isSafeInteger(descriptor.committedByteLength) ||
    descriptor.committedByteLength <= 0 ||
    !Number.isSafeInteger(descriptor.committedMessageCount) ||
    descriptor.committedMessageCount <= 0 ||
    !Number.isSafeInteger(loadedRows) ||
    loadedRows <= 0
  ) {
    return 0;
  }
  return Math.min(
    Number.MAX_SAFE_INTEGER,
    Math.round(
      (descriptor.committedByteLength / descriptor.committedMessageCount) *
        loadedRows,
    ),
  );
}

export function isHumanAuthoredUserMessage(
  message: Pick<
    PersistedChatMessage,
    'role' | 'watcherFired' | 'userMessageSource'
  >,
): boolean {
  return (
    message.role === 'user' &&
    message.watcherFired === undefined &&
    (message.userMessageSource === undefined ||
      message.userMessageSource === 'human')
  );
}

export interface TranscriptPage {
  messages: PersistedChatMessage[];
  view?: 'turns';
  turnId?: string;
  messageOrdinals?: Record<string, number>;
  turns?: TranscriptTurnSummary[];
  /** Ordinal exclusive upper bound for the next older page. */
  before?: number;
  totalMessages: number;
  transcriptRevision: number;
  /** Render as a sticky supplement, never as an extra chronological row. */
  latestHumanMessage?: PersistedChatMessage;
}

export interface TurnSummaryCounts {
  messages: number;
  thinking: number;
  bash: number;
  read: number;
  readLines: number;
  writeEdit: number;
  plan: number;
  fileEdit: number;
  fileAdd: number;
  fileDelete: number;
  search: number;
  grep: number;
  web: number;
  agent: number;
  workflow: number;
  tasks: number;
  taskStop: number;
  skills: number;
  monitor: number;
  claude: number;
  scheduleWakeup: number;
  askUser: number;
  scriptOutput: number;
  watcher: number;
  canopy: number;
  graph: number;
  appAdvisor: number;
  pipelineEditor: number;
  computerUse: number;
  mcp: number;
  other: number;
}

export interface TranscriptViewRequest {
  view?: 'turns';
  /** User message ID owning an interior gap; before is a raw ordinal. */
  turnId?: string;
}
export interface TranscriptTurnFile {
  /**
   * Untrusted path text retained from a transcript tool record, like the
   * existing file_references/image/revert_info blocks. This local-storage
   * projection is not a portable worker file locator or a filesystem grant;
   * the desktop host resolves and authorizes it when the user opens the tile.
   */
  path: string;
  state: 'creating' | 'ready' | 'failed';
  /** Explicit workspace selected by an App Advisor ShowFiles call. */
  target?: { projectId: string; worktreeId: string };
}

export interface TranscriptTurnSummary {
  id: string;
  start: number;
  end: number;
  complete: boolean;
  summary: TurnSummaryCounts;
  /** Display IDs selected before any interior rows were omitted. */
  finalMessageIds: string[];
  /** Local file outputs survive omission of interior tool history. */
  files?: TranscriptTurnFile[];
  /** Display-only frame for legacy turns without a persisted timer. */
  frameTimer?: PersistedChatMessage;
  /** Earliest loaded contiguous suffix; absent when the turn is complete in memory. */
  before?: number;
}
