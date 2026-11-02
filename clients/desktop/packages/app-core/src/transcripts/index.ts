/**
 * The seam the shared transcript readers depend on: child stream pages, a
 * paged row's blocks and field bodies of one chat. Desktop implements it over its local
 * dispatcher; a host without it reports the `delegationTranscriptReads`
 * capability off and the readers render their unavailable state.
 */

/** The chat a read selects, and the archive that holds it, if any. */
export interface TranscriptReadSource {
  readonly scope: {
    readonly workspaceId: string;
    readonly worktreeId: string;
    readonly chatId: string;
  };
  readonly archivedContainerId?: string;
  readonly standaloneHistory?: true;
}

/** One delegation run's child stream within the source chat. */
export interface DelegationReadTarget {
  readonly kind: 'delegation';
  readonly chatId: string;
  readonly delegationId: string;
  readonly runGeneration: number;
}

/** The source chat's own transcript. */
export interface PrimaryReadTarget {
  readonly kind: 'primary';
  readonly chatId: string;
}

/** Body fields a content read selects. */
export type TranscriptContentField =
  | 'output'
  | 'input'
  | 'text'
  | 'partialText'
  | 'finalText';

/**
 * One stored child row. The shared reader uses the narrowed fields; `row` is
 * the stored row as read, which each host's row renderer validates against
 * its own message model.
 */
export interface PortableChildRow {
  readonly id: string;
  readonly role: 'user' | 'assistant' | 'system';
  readonly timestamp: number;
  /** The row was captured shortened. */
  readonly truncated?: true;
  /** The row's blocks live in block pages, which this page does not include. */
  readonly blocksPaged?: { readonly blockCount: number };
  readonly row: unknown;
}

/** One newest-first page of a child stream; rows are oldest first. */
export interface DelegationPage {
  readonly rows: readonly PortableChildRow[];
  /** Continues with the next older page; absent at the stream's start. */
  readonly cursor?: string;
  /** The child stream revision this page and its cursor belong to. */
  readonly transcriptRevision: number;
  /** The run is known to have truncated output. */
  readonly runTruncated?: true;
}

export interface DelegationPageRequest extends TranscriptReadSource {
  readonly target: DelegationReadTarget;
  readonly cursor?: string;
}

/** A byte range of a stored field body. */
export interface TranscriptContentRange {
  readonly text: string;
  readonly nextOffset?: number;
  readonly byteLength: number;
}

export interface TranscriptContentRequest extends TranscriptReadSource {
  /** A primary target needs the `primaryContentReads` capability. */
  readonly target: DelegationReadTarget | PrimaryReadTarget;
  /** The stored row id, never a display id. */
  readonly messageId: string;
  /** The block's ordinal in the stored row's logical block list. */
  readonly blockOrdinal: number;
  readonly field: TranscriptContentField;
  /**
   * `logical` also reads a field kept inline, such as one cut for display;
   * absent reads only a body stored apart.
   */
  readonly fieldSource?: 'logical';
  readonly offset: number;
  readonly limit: number;
}

/**
 * One block of a paged row at its absolute ordinal. Each host validates
 * `block` against its own message model. `preview` names the fields cut or
 * stored apart, which read in full with `fieldSource: 'logical'`; `notice`
 * stands for a block the page cannot carry.
 */
export type TranscriptBlockEntry =
  | {
      readonly kind: 'block';
      readonly ordinal: number;
      readonly block: unknown;
    }
  | {
      readonly kind: 'preview';
      readonly ordinal: number;
      readonly block: unknown;
      readonly omittedFields: readonly TranscriptContentField[];
    }
  | {
      readonly kind: 'notice';
      readonly ordinal: number;
      readonly reason: 'unsupported' | 'tooLarge';
      readonly blockType?: string;
    };

/** One bounded page of a child row's blocks, in ordinal order. */
export interface DelegationBlocksPage {
  readonly messageId: string;
  readonly firstBlockOrdinal: number;
  readonly entries: readonly TranscriptBlockEntry[];
  readonly blockCount: number;
  /** Continues with the next page; absent at the row's last block. */
  readonly cursor?: string;
  readonly nextBlockOrdinal?: number;
  readonly transcriptRevision: number;
  readonly runTruncated?: true;
}

export interface DelegationBlocksRequest extends TranscriptReadSource {
  readonly target: DelegationReadTarget;
  /** The stored row id, never a display id. */
  readonly messageId: string;
  /** A first page's start; a later page passes `cursor` instead. */
  readonly firstBlockOrdinal?: number;
  readonly cursor?: string;
  readonly limit: number;
}

/**
 * Reads resolve, never reject. `stale` means the page's revision moved on and
 * the reader starts again from the newest page; `cancelled` follows the
 * caller's abort and is never shown.
 */
export type TranscriptReadResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly kind: 'stale' | 'unavailable' | 'failed' | 'cancelled';
    };

export interface TranscriptReadClient {
  delegationPage(
    request: DelegationPageRequest,
    signal: AbortSignal,
  ): Promise<TranscriptReadResult<DelegationPage>>;
  content(
    request: TranscriptContentRequest,
    signal: AbortSignal,
  ): Promise<TranscriptReadResult<TranscriptContentRange>>;
  /** Needs the `delegationBlockReads` capability. */
  blocks(
    request: DelegationBlocksRequest,
    signal: AbortSignal,
  ): Promise<TranscriptReadResult<DelegationBlocksPage>>;
}
