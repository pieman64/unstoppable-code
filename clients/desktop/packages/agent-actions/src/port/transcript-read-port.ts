import type {
  CanopyQueryName,
  CoreChatContentReadResult,
  CoreChatTranscriptBoundedBlocksPageResult,
  CoreChatTranscriptPageResult,
} from '@canopy/protocol/canopy-core';
import type {
  AgentTranscriptReadTarget,
  TranscriptReadActionOf,
} from '../families/transcript-read/actions';
import type { AgentActionCall } from '../surface/family';

/** Dedicated read inventory; never expands the environment port's queries. */
export const AGENT_TRANSCRIPT_READ_OPERATIONS = {
  page: 'core.chat.transcript.page',
  content: 'core.chat.content.read',
  blocks: 'core.chat.transcript.blocks.page',
} as const satisfies Record<'page' | 'content' | 'blocks', CanopyQueryName>;

export type AgentTranscriptPageInput = Omit<
  TranscriptReadActionOf<'chat.transcript.page'>,
  'type'
>;
export type AgentTranscriptContentInput = Omit<
  TranscriptReadActionOf<'chat.content.read'>,
  'type'
>;
export type AgentTranscriptBlocksInput = Omit<
  TranscriptReadActionOf<'chat.transcript.blocks.page'>,
  'type'
> & {
  projection: 'bounded-v1';
};

/** Metadata-only owner resolution; never supplied by an action payload. */
export interface AgentTranscriptReadOwner {
  readonly scope: {
    readonly workspaceId: string;
    readonly worktreeId: string;
    readonly chatId: string;
  };
  readonly entryId?: string;
  readonly archivedContainerId?: string;
  readonly standaloneHistory?: true;
}

/**
 * Hosts resolve the owner using metadata only, starting at trusted caller scope.
 * No caller-supplied scope, account, grant or filesystem projection crosses this
 * boundary. Throw AgentPortError on rejection (including invalid_target for a
 * stale/foreign cursor). All members must honor call.signal. No read may bypass
 * authorizeOwner, which the family calls both before a read and before delivery.
 * Reads use the supplied authorized owner, never re-derive scope from input.
 */
export interface AgentTranscriptReadPort<H> {
  authorizeOwner(
    target: AgentTranscriptReadTarget,
    call: AgentActionCall<H>,
  ): Promise<AgentTranscriptReadOwner>;
  page(
    input: AgentTranscriptPageInput,
    owner: AgentTranscriptReadOwner,
    call: AgentActionCall<H>,
  ): Promise<CoreChatTranscriptPageResult>;
  content(
    input: AgentTranscriptContentInput,
    owner: AgentTranscriptReadOwner,
    call: AgentActionCall<H>,
  ): Promise<CoreChatContentReadResult>;
  blocks(
    input: AgentTranscriptBlocksInput,
    owner: AgentTranscriptReadOwner,
    call: AgentActionCall<H>,
  ): Promise<CoreChatTranscriptBoundedBlocksPageResult>;
}
