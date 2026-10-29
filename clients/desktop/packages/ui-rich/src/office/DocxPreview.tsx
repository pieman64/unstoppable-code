'use client';

import {
  DEFAULT_OFFICE_PREVIEW_COPY,
  type OfficePreviewCopy,
  type OfficePreviewRenderFailure,
} from './office-preview-copy';
import { LoadingPlaceholder } from '@canopy/ui-shared/components';
import { REPLAY_BLOCK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import { useEffect, useState, type JSX } from 'react';
import { buildDocxPreviewSrcDoc, sanitizeDocxHtml } from './docx-sanitize';
import { parseOfficeDocument } from './office-parse-client';
import { OfficePreviewBanner } from './OfficePreviewBanner';

export interface DocxPreviewProps {
  readonly bytes: ArrayBuffer;
  readonly fileName: string;
  readonly createWorker: () => Worker;
  readonly copy?: OfficePreviewCopy;
  readonly onRenderFailure: (failure: OfficePreviewRenderFailure) => void;
}

type State =
  | { readonly status: 'loading' }
  | {
      readonly status: 'ready';
      readonly bytes: ArrayBuffer;
      readonly srcDoc: string;
    };

export function DocxPreview({
  bytes,
  fileName,
  createWorker,
  copy = DEFAULT_OFFICE_PREVIEW_COPY,
  onRenderFailure,
}: DocxPreviewProps): JSX.Element {
  const [state, setState] = useState<State>({ status: 'loading' });
  useEffect(() => {
    const controller = new AbortController();
    void (async (): Promise<void> => {
      try {
        const result = await parseOfficeDocument(
          { kind: 'docx', bytes },
          { createWorker, signal: controller.signal },
        );
        if (controller.signal.aborted) return;
        if (result.kind !== 'docx') throw new Error('Unexpected parse result.');
        setState({
          status: 'ready',
          bytes,
          srcDoc: buildDocxPreviewSrcDoc(sanitizeDocxHtml(result.html)),
        });
      } catch {
        if (!controller.signal.aborted) onRenderFailure('parse-failed');
      }
    })();
    return (): void => controller.abort();
  }, [bytes, createWorker, onRenderFailure]);

  return (
    <div
      className={`${REPLAY_BLOCK_CLASS} flex min-h-0 flex-1 flex-col`}
      data-testid="docx-preview"
    >
      <OfficePreviewBanner text={copy.banner} />
      {state.status === 'loading' || state.bytes !== bytes ? (
        <div
          className="flex min-h-0 flex-1 items-center justify-center"
          data-testid="docx-preview-loading"
        >
          <LoadingPlaceholder />
        </div>
      ) : (
        <iframe
          title={fileName}
          srcDoc={state.srcDoc}
          sandbox=""
          referrerPolicy="no-referrer"
          className="min-h-0 flex-1 border-0 bg-white"
          data-testid="docx-preview-frame"
        />
      )}
    </div>
  );
}
