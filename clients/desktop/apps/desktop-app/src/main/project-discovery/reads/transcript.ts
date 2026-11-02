import type {
  TranscriptPage,
  TranscriptTurnSummary,
} from '@canopy/agent-transcript/transcript-storage';
import type { CoreChatTranscriptPageParams } from '@canopy/protocol/canopy-core';
import { getActiveDesktopRuntime } from '../../canopy-runtime/desktop-runtime';
import { DiscoveryError } from '../errors';
import { readOptions } from '../sources';
import type { ChatReadContext } from '../chat-target';

export const RAW_PAGE_BUDGET = 20;

export type TranscriptReadPageParams = {
  before?: number;
  view?: 'turns';
  turnId?: string;
};

/**
 * Reads one authorized chat through the core dispatcher, pinning every page
 * after the first response to that transcript revision.
 */
export class TranscriptReader {
  private pinnedRevision: number | undefined;

  public constructor(
    private readonly context: Pick<ChatReadContext, 'scope'>,
    revision?: number,
  ) {
    this.pinnedRevision = revision;
  }

  /** The pinned numeric revision, available after construction or first read. */
  public get revision(): number {
    if (this.pinnedRevision === undefined) {
      throw new DiscoveryError(
        'execution_failed',
        'Chat transcript revision is not available before its first read.',
      );
    }
    return this.pinnedRevision;
  }

  public async readPage(
    params: TranscriptReadPageParams,
  ): Promise<TranscriptPage> {
    if (params.turnId !== undefined && params.view !== 'turns') {
      throw new DiscoveryError(
        'invalid_payload',
        'Turn paging requires the turn view.',
      );
    }

    const expectedRevision = this.pinnedRevision;
    let page: TranscriptPage;
    try {
      page = await this.queryPage(params, expectedRevision);
    } catch {
      if (expectedRevision === undefined) {
        throw readFailed();
      }

      const latestRevision = await this.probeLatestRevision();
      if (latestRevision !== expectedRevision) {
        throw revisionChanged();
      }
      throw readFailed();
    }

    if (
      expectedRevision !== undefined &&
      page.transcriptRevision !== expectedRevision
    ) {
      throw revisionChanged();
    }

    if (expectedRevision === undefined) {
      this.pinnedRevision = page.transcriptRevision;
    }
    return page;
  }

  /** Rechecks the pinned revision without consuming a raw-page scan budget. */
  public async verifyRevision(): Promise<void> {
    const expectedRevision = this.pinnedRevision;
    if (expectedRevision === undefined) return;

    const latestRevision = await this.probeLatestRevision();
    if (latestRevision !== expectedRevision) {
      throw revisionChanged();
    }
  }

  private async queryPage(
    params: TranscriptReadPageParams,
    revision: number | undefined,
  ): Promise<TranscriptPage> {
    const request: CoreChatTranscriptPageParams = {
      scope: this.context.scope,
      ...(params.before !== undefined ? { before: params.before } : {}),
      ...(params.view !== undefined ? { view: params.view } : {}),
      ...(params.turnId !== undefined ? { turnId: params.turnId } : {}),
      ...(revision !== undefined ? { transcriptRevision: revision } : {}),
    };
    const response =
      await getActiveDesktopRuntime().queryChatTranscriptPageForLegacyIpc(
        request,
        readOptions('core.chat.read'),
      );
    return response.legacyResult;
  }

  private async probeLatestRevision(): Promise<number> {
    try {
      const page = await this.queryPage({ view: 'turns' }, undefined);
      return page.transcriptRevision;
    } catch {
      throw readFailed();
    }
  }
}

/**
 * Maps ordinals, asked newest-first, to canonical turns. A turn-view page
 * holds at most 100 turns, fewer rows than a raw page, so it pages backwards
 * only when an ordinal falls below the loaded window. Windows never overlap,
 * so the turn reads cover no more rows than the raw scan they follow.
 */
export function turnLookup(
  reader: TranscriptReader,
  before: number | undefined,
): (ordinal: number) => Promise<string | undefined> {
  let turns: TranscriptTurnSummary[] | undefined;
  let floor = 0;
  let next = before;
  return async (ordinal) => {
    while (turns === undefined || (ordinal < floor && next !== undefined)) {
      const page = await reader.readPage({ before: next, view: 'turns' });
      if (
        page.before !== undefined &&
        next !== undefined &&
        page.before >= next
      ) {
        throw new DiscoveryError(
          'execution_failed',
          'Transcript page could not be read or did not advance.',
        );
      }
      turns = page.turns ?? [];
      floor = page.before ?? 0;
      next = page.before;
    }
    return turns.find((turn) => turn.start <= ordinal && ordinal < turn.end)
      ?.id;
  };
}

function readFailed(): DiscoveryError {
  return new DiscoveryError(
    'execution_failed',
    'Chat transcript could not be read.',
  );
}

function revisionChanged(): DiscoveryError {
  return new DiscoveryError(
    'cursor_context_changed',
    'Chat transcript changed while it was being read.',
  );
}
