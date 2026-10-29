'use client';

import { useRef, type JSX } from 'react';
import { FileViewer, type FileViewerProps } from '../code/file/FileViewer';
import {
  findFileTitle,
  useFilePreviewFindController,
} from './useFilePreviewFindController';

export interface FindableFileViewerProps extends FileViewerProps {
  /**
   * Registers the preview with the shared find bar (CAN-3048) under `key`,
   * titled for the bar's scope menu (the file name unless given).
   */
  readonly findScope: { readonly key: string; readonly title?: string };
}

/**
 * The shared `FileViewer` with find-bar file mode: Cmd/Ctrl+F inside it opens
 * the floating bar on this file. Hosts that already own a preview search
 * (the desktop file panel) use `useFilePreviewFindController` directly.
 */
export function FindableFileViewer({
  findScope,
  ...props
}: FindableFileViewerProps): JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null);
  const find = useFilePreviewFindController({
    enabled: true,
    scopeKey: findScope.key,
    title: findScope.title ?? findFileTitle(props.request.relativePath),
    rootRef,
  });
  return (
    <div
      ref={rootRef}
      className="flex h-full min-h-0 flex-1 flex-col outline-none"
      {...find.surfaceProps}
    >
      <FileViewer {...props} {...find.viewerProps} />
    </div>
  );
}
