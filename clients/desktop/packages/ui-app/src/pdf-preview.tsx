'use client';

import { useCallback, useId, useRef, type JSX } from 'react';
import {
  PdfPreview,
  type PdfPreviewProps,
  type PdfPreviewSearchResult,
} from '@canopy/ui-rich/pdf';
import { useFilePreviewFindController } from './find/useFilePreviewFindController';
import { hasClosestMethod } from './find/shortcut-target';

/** Lazy-loaded by each host so PDF.js stays out of the application shell. */
export function FindablePdfPreview(
  props: Omit<PdfPreviewProps, 'search' | 'onSearchResult'>,
): JSX.Element {
  const scopeKey = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const find = useFilePreviewFindController({
    enabled: true,
    scopeKey,
    title: props.fileName,
    rootRef,
  });
  const { previewSearchControlled: controlled, onPreviewSearchStateChange } =
    find.viewerProps;
  const onSearchResult = useCallback(
    (result: PdfPreviewSearchResult): void => {
      onPreviewSearchStateChange({
        enabled: result.ready,
        open: controlled.open,
        queryPresent: result.query.length > 0,
        currentIndex: result.currentIndex,
        totalCount: result.totalCount,
      });
    },
    [controlled.open, onPreviewSearchStateChange],
  );
  return (
    <div
      ref={rootRef}
      className="flex min-h-0 min-w-0 flex-1 flex-col outline-none"
      {...find.surfaceProps}
      onPointerDownCapture={(event): void => {
        if (
          hasClosestMethod(event.target) &&
          !event.target.closest('button, input, a')
        )
          rootRef.current?.focus({ preventScroll: true });
      }}
    >
      <PdfPreview
        {...props}
        search={{
          query: controlled.open ? controlled.query : '',
          index: controlled.index,
        }}
        onSearchResult={onSearchResult}
      />
    </div>
  );
}
