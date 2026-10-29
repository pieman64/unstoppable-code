'use client';

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type JSX,
  type ReactNode,
  type UIEventHandler,
} from 'react';
import type { PortalFileReadPayload } from '@canopy/protocol/portal';
import {
  fileViewerKey,
  useFileViewerStore,
  type FileViewerSession,
  type FileViewMode,
} from '@canopy/app-state';
import { LoadingPlaceholder } from '@canopy/ui-shared/components';
import { REPLAY_BLOCK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import type { FileLinkLineLocation } from '@canopy/ui-shared/lib/file-link-line-suffix';
import { FileReadOnlyCode } from './FileReadOnlyCode';
import {
  resolveFileRenderKind,
  isRichDocumentRenderKind,
  type FileRenderKind,
  type RichDocumentRenderKind,
} from './file-kind';
import { FileHtmlPreview, type FileHtmlPreviewProps } from './FileHtmlPreview';
import { FileMarkdownPreview } from './FileMarkdownPreview';
import { FileCsvPreview } from './FileCsvPreview';
import {
  FilePreviewSearch,
  type PreviewSearchControlled,
  type PreviewSearchPresentation,
  type PreviewSearchState,
} from './FilePreviewSearch';

/**
 * A request to reveal lines of the open file (CAN-4275), from a transcript
 * link such as `src/a.ts:12-20`. Hosts bump `revision` for every click so a
 * repeated click on the same lines is a fresh reveal; the viewer treats each
 * distinct `line`/`lineEnd`/`revision` as one request.
 */
export type FileLineReveal = FileLinkLineLocation & {
  readonly revision?: number;
};

/**
 * Props the host passes to its injected editor. Desktop lazy-loads Monaco and
 * renders it here; the browser-safe package never imports Monaco itself, so a
 * relay host (web) simply omits {@link FileViewerProps.renderEditor} and the
 * viewer falls back to a read-only `<pre>`.
 */
export interface FileEditorSlot {
  readonly value: string;
  readonly language?: string;
  readonly filePath: string;
  readonly dirty: boolean;
  readonly onChange: (next: string) => void;
  readonly onSave: () => void;
  /**
   * The current reveal request, if any. Apply it once per distinct request
   * after the editor shows this file's content (clamped to its lines), not on
   * every content change, so editing never snaps the selection back.
   */
  readonly reveal?: FileLineReveal;
  /** False until this reveal request has read the current file content. */
  readonly revealReady?: boolean;
}

export interface FileContentScrollBinding {
  readonly ref: (node: HTMLElement | null) => void;
  readonly onScroll: UIEventHandler<HTMLElement>;
  /**
   * Called when async content (an image, or images inside rendered markdown)
   * finishes loading and may have grown the scroll extents — hosts use it to
   * re-apply a persisted scroll position after layout settles.
   */
  readonly onContentLoaded?: () => void;
}

export type FileDocumentBytesResult =
  | { readonly status: 'ready'; readonly bytes: ArrayBuffer }
  | { readonly status: 'too-large'; readonly maxBytes: number }
  | { readonly status: 'failed'; readonly message?: string };

export type FileDocumentRenderFailure =
  | 'password-protected'
  | 'corrupt'
  /** The host parser could not convert the bytes (REG-2903 upgrades this seam). */
  | 'parse-failed';

export interface FileRichDocumentSlot {
  readonly bytes: ArrayBuffer;
  readonly request: PortalFileReadPayload;
  readonly displayName: string;
  /** Selects the host renderer without re-sniffing the file. */
  readonly renderKind: RichDocumentRenderKind | 'image';
  readonly onRenderFailure: (failure: FileDocumentRenderFailure) => void;
}

/**
 * The write-once file viewer for the Code tab. Reads/opens the file through the
 * shared {@link useFileViewerStore} (which routes to `client.query('file.read')`
 * / `client.command('file.save')`), and picks a renderer from the file's kind:
 *
 * - `code`: the injected {@link FileViewerProps.renderEditor} when the host can
 *   edit (`fileSystemAccess === 'read-write'`), else a read-only `<pre>`.
 * - `markdown` / `html`: a Raw/Preview toggle over the editor-or-`<pre>` (raw)
 *   and {@link FileMarkdownPreview} / {@link FileHtmlPreview} (preview).
 * - CSV: a Raw/Table toggle over the editor-or-`<pre>` and a parsed table.
 *
 * Editing, saving, and discarding are gated on the store's `canEdit` — the same
 * capability signal — so a relay host shows a read-only view with no Save/Discard.
 */
export interface FileViewerProps {
  /** Read-only host presentation that shares the file chrome and preserves the editable session. */
  readonly alternateContent?: ReactNode;
  readonly request: PortalFileReadPayload;
  /** Overrides extension dispatch before a binary read (for MIME-known files). */
  readonly requestRenderKind?: FileRenderKind;
  /** Host editor slot (desktop Monaco); omit for a read-only host. */
  readonly renderEditor?: (slot: FileEditorSlot) => ReactNode;
  /** Opens an in-app target for a relative markdown link. */
  readonly onOpenRelativePath?: (path: string) => void;
  /** Resolves relative preview images; HTML requires an image data URL. */
  readonly resolveAssetSrc?: (
    src: string,
  ) => string | Promise<string | null> | null;
  /** Authorized HTML asset identity with a lazy byte read for alias deduplication. */
  readonly resolveHtmlAsset?: FileHtmlPreviewProps['resolveHtmlAsset'];
  /** Resolves an image file request to a host-renderable URL/data URL. */
  readonly resolveImageSrc?: (
    request: PortalFileReadPayload,
  ) => Promise<string | null>;
  /** Fetches bounded bytes for a host-owned rich-document renderer. */
  readonly resolveDocumentBytes?: (
    request: PortalFileReadPayload,
    signal: AbortSignal,
  ) => Promise<FileDocumentBytesResult>;
  /** Host-owned rich-document renderer; ui-app remains vendor-neutral. */
  readonly renderRichDocument?: (slot: FileRichDocumentSlot) => ReactNode;
  /** Rich document kinds this host explicitly supports. Defaults to PDF only. */
  readonly supportedDocumentKinds?: readonly RichDocumentRenderKind[];
  /** Opt-in image renderer sharing the bounded, cancellable document loader. */
  readonly renderImageDocument?: (slot: FileRichDocumentSlot) => ReactNode;
  /** Safe display name for document chrome and failures. */
  readonly documentDisplayName?: string;
  /**
   * Sentence appended to the parse-failed card after
   * "<name> could not be converted for preview." Hosts without a download
   * action (desktop) pass their platform recovery sentence.
   */
  readonly documentRecoveryHint?: string;
  /** Changing this value re-runs the image resolver for the same request. */
  readonly imageRetryGeneration?: number;
  /** Re-resolves document bytes without changing the stable resolver. */
  readonly documentRetryGeneration?: number;
  /** Optional host-owned mode used by desktop's persisted file tabs. */
  readonly viewMode?: FileViewMode;
  /** Host focus gate for Cmd/Ctrl+F when the panel tab owns keyboard focus. */
  readonly searchShortcutActive?: boolean;
  /** Optional host-owned command for the active preview search drawer. */
  readonly previewSearchControl?: {
    operation: 'open' | 'close';
    revision: number;
  };
  /** Acknowledges that a host-owned drawer command was consumed. */
  readonly onPreviewSearchControlApplied?: (revision: number) => void;
  /** Reports bounded drawer metadata without exposing the search query. */
  readonly onPreviewSearchStateChange?: (state: PreviewSearchState) => void;
  /** `headless` hands the preview search UI to the host (desktop find bar). */
  readonly previewSearchPresentation?: PreviewSearchPresentation;
  /** Host-owned search state for the `headless` presentation. */
  readonly previewSearchControlled?: PreviewSearchControlled;
  /** Headless only: the preview asked to open or close the search. */
  readonly onPreviewSearchRequest?: (operation: 'open' | 'close') => void;
  readonly onViewModeChange?: (mode: FileViewMode) => void;
  /** Optional host-owned controls rendered in the existing header row. */
  readonly headerActions?: ReactNode;
  /**
   * Optional host-owned replacement for the plain path text in the header
   * row (e.g. desktop's interactive breadcrumb). Receives the displayed
   * path; the dirty indicator stays owned by the viewer. Returning `null`
   * means the host displays the path in its own chrome, so the viewer leaves
   * the slot empty and drops the whole row when nothing else fills it.
   */
  readonly renderPathBreadcrumb?: (path: string) => ReactNode;
  /**
   * Optional host-owned controls rendered at the very end of the header row,
   * after the view-mode toggle (e.g. desktop's embedded file-tree toggle).
   */
  readonly trailingHeaderActions?: ReactNode;
  /** Optional host-owned action shown after the unsupported-file explanation. */
  readonly unsupportedFileAction?: ReactNode;
  /**
   * Byte budget the host's file read is capped at, used to state the real
   * limit in the truncation banner. Defaults to desktop's 5 MiB
   * (`MAX_TEXT_BYTES_FULL`); relay hosts with a smaller window pass their own
   * so the banner never overstates how much of the file is on screen.
   */
  readonly previewByteBudget?: number;
  /**
   * Keep a missing first read in the neutral loading state while the host is
   * waiting for an external lifecycle (for example, desktop worktree setup)
   * to make the file available and issue one final read.
   */
  readonly deferMissing?: boolean;
  /** Optional host-owned binding for the active scrollable content body. */
  readonly contentScrollBinding?: FileContentScrollBinding;
  /**
   * Lines to reveal in the raw text view (CAN-4275). Read-only text
   * highlights them and centers the first line in its own scroller; the
   * editor slot receives it as `reveal`. Rendered previews ignore it until
   * the file enters raw mode. Omit for an unlocated open.
   */
  readonly revealLine?: FileLineReveal;
}

interface FileStatusActionsProps {
  readonly session: FileViewerSession;
  readonly editable: boolean;
  readonly savedContentNotice?: boolean;
  readonly onDiscard: () => void;
  readonly onSave: () => void;
}

/**
 * Whether `FileStatusActions` renders anything at all. The header gate needs
 * the same answer, and duplicating the component's internal conditions would
 * let the two drift into an empty bordered row.
 */
function fileStatusActionsVisible(
  session: FileViewerSession,
  editable: boolean,
  savedContentNotice = false,
): boolean {
  return (
    session.status === 'saving' ||
    session.status === 'error' ||
    (session.dirty && (editable || savedContentNotice))
  );
}

function FileStatusActions({
  session,
  editable,
  savedContentNotice = false,
  onDiscard,
  onSave,
}: FileStatusActionsProps): JSX.Element {
  if (!fileStatusActionsVisible(session, editable, savedContentNotice))
    return <></>;
  const statusText =
    session.status === 'saving'
      ? 'Saving…'
      : session.status === 'error'
        ? (session.error ?? 'Save failed')
        : null;
  return (
    <>
      {savedContentNotice && session.dirty && (
        <span className="fg-secondary" data-testid="file-diff-saved-content">
          Diff shows saved content
        </span>
      )}
      {statusText && (
        <span
          className={
            session.status === 'error' ? 'fg-destructive' : 'fg-secondary'
          }
        >
          {statusText}
        </span>
      )}
      {editable && session.dirty && (
        <>
          <button
            type="button"
            className="rounded px-2 py-0.5 fg-secondary hover:fg-primary"
            onClick={onDiscard}
            data-testid="file-discard"
          >
            Discard
          </button>
          <button
            type="button"
            className="rounded bg-accent px-2 py-0.5 fg-emphasis disabled:opacity-50"
            disabled={session.status === 'saving'}
            onClick={onSave}
            data-testid="file-save"
          >
            Save
          </button>
        </>
      )}
    </>
  );
}

/** Desktop's `MAX_TEXT_BYTES_FULL`; the historical banner figure. */
const DEFAULT_PREVIEW_BYTE_BUDGET = 5 * 1024 * 1024;

function formatByteBudget(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  return `${Number.isInteger(mb) ? mb : mb.toFixed(1)} MB`;
}

function RawPreviewToggle({
  value,
  onChange,
  previewLabel = 'Preview',
}: {
  value: FileViewMode;
  onChange: (next: FileViewMode) => void;
  previewLabel?: 'Preview' | 'Table';
}): JSX.Element {
  const previewMode: FileViewMode =
    previewLabel === 'Table' ? 'table' : 'preview';
  // One action button showing only the mode you would SWITCH TO: in a
  // rendered mode it offers "View source"; in raw mode it offers
  // "View preview" (or "View table" for CSV).
  const inRaw = value === 'raw';
  const label = inRaw
    ? previewLabel === 'Table'
      ? 'View table'
      : 'View preview'
    : 'View source';
  const currentViewLabel = inRaw
    ? 'source'
    : previewLabel === 'Table'
      ? 'table'
      : 'preview';
  return (
    <button
      type="button"
      data-testid="file-view-toggle"
      aria-label={`${label}; current view: ${currentViewLabel}`}
      className="shrink-0 rounded-md border px-2 py-1 text-xs fg-secondary transition hover:fg-primary"
      onClick={(): void => onChange(inRaw ? previewMode : 'raw')}
    >
      {label}
    </button>
  );
}

function FileImagePreview({
  request,
  resolveImageSrc,
  retryGeneration,
  scrollBinding,
}: {
  request: PortalFileReadPayload;
  resolveImageSrc: NonNullable<FileViewerProps['resolveImageSrc']>;
  retryGeneration: number;
  scrollBinding?: FileContentScrollBinding;
}): JSX.Element {
  const [state, setState] = useState<
    | { status: 'loading' }
    | { status: 'unavailable' }
    | { status: 'ready'; src: string }
  >({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    void resolveImageSrc(request)
      .then((src) => {
        if (!cancelled) {
          setState(src ? { status: 'ready', src } : { status: 'unavailable' });
        }
      })
      .catch(() => {
        if (!cancelled) setState({ status: 'unavailable' });
      });
    return (): void => {
      cancelled = true;
    };
  }, [request, resolveImageSrc, retryGeneration]);

  return (
    <div
      ref={scrollBinding?.ref}
      onScroll={scrollBinding?.onScroll}
      data-testid="file-viewer-image-scroll"
      className={`${REPLAY_BLOCK_CLASS} flex min-h-0 flex-1 items-center justify-center overflow-auto bg-fg-primary/[0.02] p-4`}
    >
      {state.status === 'loading' ? (
        <LoadingPlaceholder />
      ) : state.status === 'unavailable' ? (
        <span className="text-s fg-secondary">Image unavailable</span>
      ) : (
        <img
          src={state.src}
          alt={request.relativePath.split('/').pop() ?? request.relativePath}
          onLoad={scrollBinding?.onContentLoaded}
          className="max-h-full max-w-full object-contain"
        />
      )}
    </div>
  );
}

type FileDocumentPreviewState =
  | { readonly status: 'loading' }
  | { readonly status: 'ready'; readonly bytes: ArrayBuffer }
  | { readonly status: 'too-large'; readonly maxBytes: number }
  | { readonly status: 'fetch-failed'; readonly message?: string }
  | { readonly status: 'password-protected' }
  | { readonly status: 'corrupt' }
  | { readonly status: 'parse-failed' };

interface FileDocumentPreviewProps {
  readonly request: PortalFileReadPayload;
  readonly renderKind: RichDocumentRenderKind | 'image';
  readonly resolveDocumentBytes: NonNullable<
    FileViewerProps['resolveDocumentBytes']
  >;
  readonly renderRichDocument: NonNullable<
    FileViewerProps['renderRichDocument']
  >;
  readonly displayName: string;
  readonly documentRecoveryHint: string;
  readonly headerActions?: ReactNode;
  readonly unsupportedFileAction?: ReactNode;
  readonly renderPathBreadcrumb?: FileViewerProps['renderPathBreadcrumb'];
  readonly trailingHeaderActions?: ReactNode;
  readonly documentRetryGeneration: number;
  readonly deferMissing: boolean;
}

function FileDocumentPreview({
  request,
  renderKind,
  resolveDocumentBytes,
  renderRichDocument,
  displayName,
  documentRecoveryHint,
  headerActions,
  unsupportedFileAction,
  renderPathBreadcrumb,
  trailingHeaderActions,
  documentRetryGeneration,
  deferMissing,
}: FileDocumentPreviewProps): JSX.Element {
  const requestKey = fileViewerKey(request);
  const activeRequestKey = useRef(requestKey);
  activeRequestKey.current = requestKey;
  const [state, setState] = useState<FileDocumentPreviewState>({
    status: 'loading',
  });

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setState({ status: 'loading' });
    void resolveDocumentBytes(request, controller.signal).then(
      (result) => {
        if (!active || controller.signal.aborted) return;
        if (result.status === 'failed') {
          setState({ status: 'fetch-failed', message: result.message });
          return;
        }
        setState(result);
      },
      () => {
        // Cleanup flips `active` and aborts the signal together, so a
        // rejection after teardown (including the resolver's own abort
        // rejection) is silently dropped.
        if (active) setState({ status: 'fetch-failed' });
      },
    );
    return (): void => {
      active = false;
      controller.abort();
    };
    // `requestKey` canonically identifies the request; raw object identity is
    // intentionally excluded so equivalent host renders do not refetch.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestKey, resolveDocumentBytes, documentRetryGeneration]);

  const onRenderFailure = useCallback(
    (failure: FileDocumentRenderFailure): void => {
      if (activeRequestKey.current === requestKey)
        setState({ status: failure });
    },
    [requestKey],
  );

  let body: JSX.Element;
  if (
    state.status === 'too-large' ||
    (state.status === 'fetch-failed' && !deferMissing) ||
    state.status === 'password-protected' ||
    state.status === 'corrupt' ||
    state.status === 'parse-failed'
  ) {
    const copy =
      state.status === 'too-large'
        ? `${displayName} exceeds the ${formatByteBudget(state.maxBytes)} document preview limit.`
        : state.status === 'fetch-failed'
          ? (state.message ?? `${displayName} could not be loaded for preview.`)
          : state.status === 'password-protected'
            ? `${displayName} is password-protected and cannot be previewed.`
            : state.status === 'parse-failed'
              ? `${displayName} could not be converted for preview. ${documentRecoveryHint}`
              : `${displayName} is damaged or invalid and cannot be previewed.`;
    body = (
      <div
        className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-6 text-center"
        data-testid="file-viewer-document-error"
        data-error-kind={state.status}
      >
        <p className="text-s font-medium fg-primary">
          Document preview unavailable
        </p>
        <p className="text-xs fg-secondary">{copy}</p>
        {unsupportedFileAction}
      </div>
    );
  } else {
    body = (
      <div
        className={`${REPLAY_BLOCK_CLASS} flex min-h-0 flex-1 flex-col`}
        data-testid="file-viewer-document"
      >
        {state.status !== 'ready' ? (
          <div className="flex min-h-0 flex-1 items-center justify-center">
            <LoadingPlaceholder />
          </div>
        ) : (
          renderRichDocument({
            bytes: state.bytes,
            request,
            displayName,
            renderKind,
            onRenderFailure,
          })
        )}
      </div>
    );
  }
  // A host breadcrumb that renders nothing means the host names the file in
  // its own chrome, so the path slot is absent: without this the row survives
  // as a bare bordered strip under the host's own title.
  const pathSlot = renderPathBreadcrumb?.(request.relativePath) ?? null;
  if (
    pathSlot == null &&
    headerActions == null &&
    trailingHeaderActions == null
  )
    return body;
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="file-viewer">
      <div
        className="flex items-center gap-2 border-b px-3 py-1.5 text-xs"
        data-testid="file-viewer-document-header"
      >
        {pathSlot !== null ? (
          <div className="flex min-w-0 flex-1 items-center overflow-hidden">
            {pathSlot}
          </div>
        ) : renderPathBreadcrumb === undefined ? (
          <span className="min-w-0 flex-1 truncate fg-secondary">
            {displayName}
          </span>
        ) : (
          // Host-owned name: hold the flexible slot open so the actions stay
          // on the trailing edge, exactly where every other header puts them.
          <div className="min-w-0 flex-1" />
        )}
        {headerActions}
        {trailingHeaderActions}
      </div>
      {body}
    </div>
  );
}

export function FileViewer(props: FileViewerProps): JSX.Element {
  const alternate = props.alternateContent !== undefined;
  const kind = resolveFileRenderKind({ path: props.request.relativePath });
  const key = fileViewerKey(props.request);
  const session = useFileViewerStore((state) => state.files[key]);
  const defaultCanEdit = useFileViewerStore((state) => state.canEdit);
  const saveFile = useFileViewerStore((state) => state.saveFile);
  const discardEdits = useFileViewerStore((state) => state.discardEdits);
  const editable =
    session?.preview?.truncated === false &&
    (session.canEdit ?? defaultCanEdit) &&
    props.renderEditor !== undefined;
  // Session replay records the header (path, status, actions); each content
  // body carries its own block. An `alternateContent` host blocks its own
  // content.
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div
        className={alternate ? 'hidden' : 'flex min-h-0 flex-1 flex-col'}
        inert={alternate}
      >
        <FileViewerBody
          {...props}
          searchShortcutActive={!alternate && props.searchShortcutActive}
          suppressStatusChrome={alternate}
        />
      </div>
      {alternate && (
        <>
          <div
            className="flex items-center gap-2 px-3 py-1.5 text-xs ring-1 ring-inset ring-line-base"
            data-testid="file-viewer-header"
          >
            <div className="min-w-0 flex-1 truncate fg-secondary">
              {props.renderPathBreadcrumb?.(props.request.relativePath) ??
                props.request.relativePath}
              {session?.dirty === true && (
                <span
                  className="ml-1 fg-warning"
                  data-testid="file-viewer-dirty"
                >
                  •
                </span>
              )}
            </div>
            {session && (
              <FileStatusActions
                session={session}
                editable={editable}
                savedContentNotice
                onDiscard={() => discardEdits(key)}
                onSave={() => {
                  void saveFile(key);
                }}
              />
            )}
            {props.headerActions}
            {(kind === 'markdown' ||
              kind === 'html' ||
              props.request.relativePath.toLowerCase().endsWith('.csv')) && (
              <RawPreviewToggle
                value="raw"
                previewLabel={
                  props.request.relativePath.toLowerCase().endsWith('.csv')
                    ? 'Table'
                    : 'Preview'
                }
                onChange={(mode) => props.onViewModeChange?.(mode)}
              />
            )}
            {props.trailingHeaderActions}
          </div>
          {props.alternateContent}
        </>
      )}
    </div>
  );
}

interface FileViewerBodyProps extends FileViewerProps {
  readonly suppressStatusChrome?: boolean;
}

function FileViewerBody({
  request,
  requestRenderKind,
  supportedDocumentKinds = ['pdf'],
  renderEditor,
  onOpenRelativePath,
  resolveAssetSrc,
  resolveHtmlAsset,
  resolveImageSrc,
  resolveDocumentBytes,
  renderRichDocument,
  renderImageDocument,
  documentDisplayName,
  documentRecoveryHint = 'Download it to open in its native app.',
  imageRetryGeneration = 0,
  documentRetryGeneration = 0,
  viewMode,
  searchShortcutActive = false,
  previewSearchControl,
  onPreviewSearchControlApplied,
  onPreviewSearchStateChange,
  previewSearchPresentation,
  previewSearchControlled,
  onPreviewSearchRequest,
  onViewModeChange,
  headerActions,
  renderPathBreadcrumb,
  trailingHeaderActions,
  unsupportedFileAction,
  previewByteBudget = DEFAULT_PREVIEW_BYTE_BUDGET,
  deferMissing = false,
  contentScrollBinding,
  revealLine,
  suppressStatusChrome = false,
}: FileViewerBodyProps): JSX.Element {
  const key = fileViewerKey(request);
  const revealRequestKey = JSON.stringify([
    key,
    revealLine?.line,
    revealLine?.lineEnd,
    revealLine?.revision,
  ]);
  const [settledRevealRequest, setSettledRevealRequest] = useState<
    string | null
  >(null);
  const session = useFileViewerStore((state) => state.files[key]);
  const revealReady =
    settledRevealRequest === revealRequestKey &&
    (session?.dirty === true ||
      (session?.status !== 'loading' && session?.status !== 'error'));
  const defaultCanEdit = useFileViewerStore((state) => state.canEdit);

  const openFile = useFileViewerStore((state) => state.openFile);
  const updateContent = useFileViewerStore((state) => state.updateContent);
  const saveFile = useFileViewerStore((state) => state.saveFile);
  const discardEdits = useFileViewerStore((state) => state.discardEdits);
  const setViewMode = useFileViewerStore((state) => state.setViewMode);

  const requestKind = resolveFileRenderKind({
    path: request.relativePath,
    language: undefined,
  });
  const effectiveRequestKind = requestRenderKind ?? requestKind;
  // Image tabs render straight from the resolved src below and never read the
  // session, so skip the text `file.read` round trip entirely for them.
  const documentRenderer =
    effectiveRequestKind === 'image'
      ? renderImageDocument
      : isRichDocumentRenderKind(effectiveRequestKind) &&
          supportedDocumentKinds.includes(effectiveRequestKind)
        ? renderRichDocument
        : undefined;
  const rendersAsDocument =
    resolveDocumentBytes != null && documentRenderer != null;
  const rendersAsImage =
    effectiveRequestKind === 'image' &&
    !rendersAsDocument &&
    resolveImageSrc != null;

  useEffect(() => {
    if (rendersAsImage || rendersAsDocument) return;
    let current = true;
    // A fresh location request must wait for the opening read, even when a
    // cached preview is already renderable. The store protects dirty buffers.
    void openFile(request).then(() => {
      if (current) setSettledRevealRequest(revealRequestKey);
    });
    return (): void => {
      current = false;
    };
    // The request key includes both the file identity and location revision.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [revealRequestKey, openFile, rendersAsDocument, rendersAsImage]);

  if (rendersAsImage && resolveImageSrc) {
    const imagePreview = (
      <FileImagePreview
        request={request}
        resolveImageSrc={resolveImageSrc}
        retryGeneration={imageRetryGeneration}
        scrollBinding={contentScrollBinding}
      />
    );
    // Image tabs bypass the shared header entirely (they never read a session),
    // which would strand a host action like Download on exactly the files that
    // most need one. Add a minimal header ONLY when the host filled the slot,
    // so every existing image host keeps its chrome-free markup. Nullish, not
    // just `undefined`: hosts spell "no action" as `null` too (desktop passes
    // `diffTarget ? <button/> : null`), and treating that as present would put
    // an empty header row above every ordinary image preview.
    if (
      (headerActions === undefined || headerActions === null) &&
      (trailingHeaderActions === undefined || trailingHeaderActions === null)
    ) {
      return imagePreview;
    }
    // The breadcrumb deliberately stays out of this gate: adding it would put
    // a path row above every desktop image preview that has no host action.
    const imagePathSlot = renderPathBreadcrumb?.(request.relativePath) ?? null;
    return (
      <div className="flex h-full min-h-0 flex-col" data-testid="file-viewer">
        <div
          className="flex items-center gap-2 border-b px-3 py-1.5 text-xs"
          data-testid="file-viewer-image-header"
        >
          {imagePathSlot !== null ? (
            <div className="flex min-w-0 flex-1 items-center overflow-hidden">
              {imagePathSlot}
            </div>
          ) : renderPathBreadcrumb === undefined ? (
            <span className="min-w-0 flex-1 truncate fg-secondary">
              {request.relativePath}
            </span>
          ) : (
            <div className="min-w-0 flex-1" />
          )}
          {headerActions}
          {trailingHeaderActions}
        </div>
        {imagePreview}
      </div>
    );
  }

  if (
    rendersAsDocument &&
    resolveDocumentBytes &&
    documentRenderer &&
    (effectiveRequestKind === 'image' ||
      isRichDocumentRenderKind(effectiveRequestKind))
  ) {
    return (
      <FileDocumentPreview
        key={`${key}:${effectiveRequestKind}`}
        request={request}
        renderKind={effectiveRequestKind}
        resolveDocumentBytes={resolveDocumentBytes}
        renderRichDocument={documentRenderer}
        displayName={documentDisplayName ?? request.relativePath}
        documentRecoveryHint={documentRecoveryHint}
        renderPathBreadcrumb={renderPathBreadcrumb}
        trailingHeaderActions={trailingHeaderActions}
        documentRetryGeneration={documentRetryGeneration}
        deferMissing={deferMissing}
        headerActions={headerActions}
        unsupportedFileAction={unsupportedFileAction}
      />
    );
  }

  if (!session || (session.status === 'loading' && session.preview === null)) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center">
        <LoadingPlaceholder />
      </div>
    );
  }

  if (session.status === 'error' && session.preview === null) {
    // TODO(CAN-759): replace with a typed error code on the file session.
    const missing = session.error?.startsWith('File not found:') === true;
    if (missing) {
      if (deferMissing) {
        return (
          <div className="flex min-h-0 flex-1 items-center justify-center">
            <LoadingPlaceholder />
          </div>
        );
      }
      return (
        <div
          className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-6 text-center"
          data-testid="file-viewer-missing"
        >
          <p className="text-s font-medium fg-primary">File does not exist</p>
          <p className="text-xs fg-secondary">
            {request.relativePath} could not be found. It may have been moved,
            renamed, or deleted.
          </p>
        </div>
      );
    }
    if (session.error?.includes('Binary files cannot be read') === true) {
      return (
        <div className="flex h-full min-h-0 flex-col" data-testid="file-viewer">
          <div className="flex items-center gap-2 border-b px-3 py-1.5 text-xs">
            {renderPathBreadcrumb ? (
              <div className="flex min-w-0 flex-1 items-center overflow-hidden">
                {renderPathBreadcrumb(request.relativePath)}
              </div>
            ) : (
              <span className="min-w-0 flex-1 truncate fg-secondary">
                {request.relativePath}
              </span>
            )}
            {headerActions}
            {trailingHeaderActions}
          </div>
          <div
            className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 p-6 text-center"
            data-testid="file-viewer-unsupported"
          >
            <p className="text-s font-medium fg-primary">
              Unsupported file type
            </p>
            <p className="text-xs fg-secondary">
              {request.relativePath} cannot be previewed.
            </p>
            {unsupportedFileAction}
          </div>
        </div>
      );
    }
    return (
      <div
        className="flex min-h-0 flex-1 items-center justify-center px-6 text-s fg-destructive"
        data-testid="file-error"
      >
        {session.error ?? 'Failed to read file.'}
      </div>
    );
  }

  const preview = session.preview;
  if (!preview) {
    return (
      <div className="flex min-h-0 flex-1 items-center justify-center">
        <LoadingPlaceholder />
      </div>
    );
  }

  const kind = requestRenderKind ?? resolveFileRenderKind(preview);
  const isCsv = preview.path.toLowerCase().endsWith('.csv');
  const showToggle =
    !preview.truncated && (kind === 'markdown' || kind === 'html' || isCsv);
  const requestedViewMode = viewMode ?? session.viewMode;
  // A CSV has no neutral 'preview' rendering and other kinds have no 'table':
  // normalize both directions so a persisted/host mode from before a rename or
  // from a non-CSV default always maps to a rendered body and an active toggle.
  const effectiveViewMode: FileViewMode =
    isCsv && requestedViewMode === 'preview'
      ? 'table'
      : !isCsv && requestedViewMode === 'table'
        ? 'preview'
        : requestedViewMode;
  const inRawMode = !showToggle || effectiveViewMode === 'raw';
  const editable =
    !preview.truncated &&
    (session.canEdit ?? defaultCanEdit) &&
    renderEditor !== undefined;

  const rawBody: ReactNode =
    // The `renderEditor` re-check is not redundant: `editable` is a boolean, so
    // TS does not narrow the optional `renderEditor` from it — this guard does.
    editable && renderEditor ? (
      renderEditor({
        value: session.content,
        language: preview.language,
        filePath: preview.path,
        dirty: session.dirty,
        onChange: (next): void => updateContent(key, next),
        onSave: (): void => {
          void saveFile(key);
        },
        reveal: revealLine,
        revealReady,
      })
    ) : (
      <FileReadOnlyCode
        content={session.content}
        scrollBinding={contentScrollBinding}
        reveal={revealLine}
        revealReady={revealReady}
        fileIdentity={key}
      />
    );

  let body: ReactNode = rawBody;
  if ((!inRawMode || preview.truncated) && kind === 'markdown') {
    body = (
      <FileMarkdownPreview
        content={session.content}
        onOpenRelativePath={onOpenRelativePath}
        resolveAssetSrc={resolveAssetSrc}
        scrollBinding={contentScrollBinding}
      />
    );
  } else if ((!inRawMode || preview.truncated) && kind === 'html') {
    body = (
      <FileHtmlPreview
        content={session.content}
        title={preview.path}
        resolveAssetSrc={resolveAssetSrc}
        resolveHtmlAsset={resolveHtmlAsset}
      />
    );
  } else if (!inRawMode && isCsv && effectiveViewMode === 'table') {
    body = (
      <FileCsvPreview
        content={session.content}
        scrollBinding={contentScrollBinding}
      />
    );
  }

  // Mirrors the document header: a breadcrumb that renders nothing hands the
  // filename to the host's chrome, so this row keeps only what it owns — and
  // disappears when it owns nothing.
  const pathSlot = renderPathBreadcrumb?.(preview.path) ?? null;
  const pathVisible = renderPathBreadcrumb === undefined || pathSlot !== null;
  const dirtyMarker =
    !suppressStatusChrome && session.dirty ? (
      <span
        className="ml-1 shrink-0 fg-warning"
        data-testid="file-viewer-dirty"
      >
        •
      </span>
    ) : null;
  const showHeaderRow =
    pathVisible ||
    dirtyMarker !== null ||
    (!suppressStatusChrome && fileStatusActionsVisible(session, editable)) ||
    headerActions != null ||
    showToggle ||
    trailingHeaderActions != null;

  return (
    <FilePreviewSearch
      searchShortcutActive={searchShortcutActive}
      key={`${key}:${effectiveViewMode}`}
      enabled={
        !inRawMode ||
        !editable ||
        (preview.truncated && (kind === 'markdown' || kind === 'html'))
      }
      remote={kind === 'html' && (!inRawMode || preview.truncated)}
      control={previewSearchControl}
      onControlApplied={onPreviewSearchControlApplied}
      onStateChange={onPreviewSearchStateChange}
      presentation={previewSearchPresentation}
      controlled={previewSearchControlled}
      onSearchRequest={onPreviewSearchRequest}
      header={
        <>
          {showHeaderRow && (
            <div
              className="flex items-center gap-2 border-b px-3 py-1.5 text-xs"
              data-testid="file-viewer-header"
            >
              {pathSlot !== null ? (
                <div className="flex min-w-0 flex-1 items-center overflow-hidden">
                  {pathSlot}
                  {dirtyMarker}
                </div>
              ) : renderPathBreadcrumb === undefined ? (
                <span className="min-w-0 flex-1 truncate fg-secondary">
                  {preview.path}
                  {dirtyMarker}
                </span>
              ) : (
                // Host-owned name: the dirty dot is still the viewer's, so it
                // stays anchored to the flexible slot.
                <div className="flex min-w-0 flex-1 items-center overflow-hidden">
                  {dirtyMarker}
                </div>
              )}
              {!suppressStatusChrome && (
                <FileStatusActions
                  session={session}
                  editable={editable}
                  onDiscard={() => discardEdits(key)}
                  onSave={() => {
                    void saveFile(key);
                  }}
                />
              )}
              {headerActions}
              {showToggle && (
                <RawPreviewToggle
                  value={effectiveViewMode}
                  previewLabel={isCsv ? 'Table' : 'Preview'}
                  onChange={(next): void => {
                    setViewMode(key, next);
                    onViewModeChange?.(next);
                  }}
                />
              )}
              {trailingHeaderActions}
            </div>
          )}
          {preview.truncated && (
            <div className="border-b bg-warning-subtle px-4 py-2 text-xs fg-warning">
              {`File too large to edit. Showing the first ${formatByteBudget(previewByteBudget)}.`}
            </div>
          )}
        </>
      }
    >
      {body}
    </FilePreviewSearch>
  );
}
