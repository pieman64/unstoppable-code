import { lazy, Suspense, type JSX } from 'react';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import type { FileDiffImagePreview } from '@canopy/desktop-shared/types';
import type { ReactDiffViewerProps } from 'react-diff-viewer-continued';
import { DiffBinaryState, DiffBoundNotice } from '@canopy/ui-shared/components';
import { LoadingSpinner } from '../shared/loading/spinners/LoadingSpinner';

/**
 * `react-diff-viewer-continued` loads on first use instead of at window
 * startup. While it loads, the view shows the same state it shows while the
 * diff itself loads.
 */
const LineDiffViewer = lazy(async () => {
  const { default: ReactDiffViewer, DiffMethod } =
    await import('react-diff-viewer-continued');
  function LoadedLineDiffViewer(
    props: Omit<ReactDiffViewerProps, 'compareMethod'>,
  ): JSX.Element {
    return <ReactDiffViewer {...props} compareMethod={DiffMethod.LINES} />;
  }
  return { default: LoadedLineDiffViewer };
});

interface DiffContentViewProps {
  oldValue: string;
  newValue: string;
  viewMode: 'unified' | 'split';
  loading: boolean;
  truncated: boolean;
  binary: boolean;
  imagePreview?: FileDiffImagePreview;
}

const DIFF_THEME_VARS = {
  diffViewerBackground: 'transparent',
  diffViewerColor: 'var(--fg-primary)',
  addedBackground: 'color-mix(in srgb, var(--fg-success) 8%, transparent)',
  addedColor: 'var(--fg-success)',
  removedBackground:
    'color-mix(in srgb, var(--fg-destructive) 8%, transparent)',
  removedColor: 'var(--fg-destructive)',
  wordAddedBackground: 'color-mix(in srgb, var(--fg-success) 22%, transparent)',
  wordRemovedBackground:
    'color-mix(in srgb, var(--fg-destructive) 22%, transparent)',
  addedGutterBackground:
    'color-mix(in srgb, var(--fg-success) 8%, transparent)',
  removedGutterBackground:
    'color-mix(in srgb, var(--fg-destructive) 8%, transparent)',
  gutterBackground: 'transparent',
  gutterBackgroundDark: 'transparent',
  highlightBackground: 'color-mix(in srgb, var(--fg-info) 6%, transparent)',
  highlightGutterBackground:
    'color-mix(in srgb, var(--fg-info) 6%, transparent)',
  codeFoldGutterBackground:
    'color-mix(in srgb, var(--fg-primary) 2%, transparent)',
  codeFoldBackground: 'color-mix(in srgb, var(--fg-primary) 2%, transparent)',
  emptyLineBackground: 'color-mix(in srgb, var(--fg-primary) 2%, transparent)',
  gutterColor: 'var(--fg-secondary)',
  addedGutterColor: 'var(--fg-success)',
  removedGutterColor: 'var(--fg-destructive)',
  codeFoldContentColor: 'var(--fg-secondary)',
};

export const DIFF_STYLES = {
  variables: {
    dark: DIFF_THEME_VARS,
    light: DIFF_THEME_VARS,
  },
  line: {
    fontSize: '12px',
    fontFamily: 'var(--font-mono)',
  },
  gutter: {
    fontSize: '12px',
    fontFamily: 'var(--font-mono)',
    minWidth: '40px',
  },
  codeFold: {
    fontSize: '11px',
    fontFamily: 'var(--font-mono)',
  },
  // The library styles these two spans with a generic `monospace` UNDER the
  // `line` / `gutter` overrides above, so without them the diff text itself
  // still fell through to the system mono.
  contentText: {
    fontFamily: 'var(--font-mono)',
  },
  lineNumber: {
    fontFamily: 'var(--font-mono)',
  },
} as const;

export function renderFoldMessage(totalFoldedLines: number): JSX.Element {
  return (
    <span className="cursor-pointer text-2xs fg-secondary hover:fg-primary/80">
      Expand {totalFoldedLines} hidden lines…
    </span>
  );
}

function ImagePreviewPanel({
  label,
  src,
}: {
  label: string;
  src?: string;
}): JSX.Element {
  return (
    <div className="flex min-w-0 flex-1 flex-col overflow-hidden bg-fg-primary/[0.02]">
      <div className="shrink-0 border-b px-3 py-1.5 text-2xs font-medium fg-secondary">
        {label}
      </div>
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-4">
        {src ? (
          <img
            src={src}
            alt={label}
            className="max-h-full max-w-full object-contain"
          />
        ) : (
          <span className="text-s fg-secondary">Image unavailable</span>
        )}
      </div>
    </div>
  );
}

function ImageDiffPreview({
  imagePreview,
  viewMode,
}: {
  imagePreview: FileDiffImagePreview;
  viewMode: 'unified' | 'split';
}): JSX.Element {
  if (viewMode === 'split') {
    return (
      <div
        className={`${POSTHOG_REPLAY_BLOCK_CLASS} flex min-h-0 flex-1 overflow-hidden`}
      >
        <ImagePreviewPanel label="Previous" src={imagePreview.oldDataUrl} />
        <div className="w-px shrink-0 bg-line-base" />
        <ImagePreviewPanel label="Current" src={imagePreview.newDataUrl} />
      </div>
    );
  }

  const unifiedSrc = imagePreview.newDataUrl ?? imagePreview.oldDataUrl;
  const unifiedLabel = imagePreview.newDataUrl ? 'Current' : 'Previous';

  return (
    <div
      className={`${POSTHOG_REPLAY_BLOCK_CLASS} flex min-h-0 flex-1 overflow-hidden`}
    >
      <ImagePreviewPanel label={unifiedLabel} src={unifiedSrc} />
    </div>
  );
}

function DiffLoadingState(): JSX.Element {
  return (
    <div
      className={`${POSTHOG_REPLAY_BLOCK_CLASS} flex flex-1 items-center justify-center fg-secondary`}
    >
      <div className="flex items-center gap-3">
        <LoadingSpinner tone="secondary" />
        <span className="text-s">Loading diff…</span>
      </div>
    </div>
  );
}

export function DiffContentView({
  oldValue,
  newValue,
  viewMode,
  loading,
  truncated,
  binary,
  imagePreview,
}: DiffContentViewProps): JSX.Element {
  // Every state shares the block: React reuses the root div when a loading,
  // binary, or empty state turns into the diff, and the recorder ignores a
  // block class added to an element it already recorded.
  if (loading) {
    return <DiffLoadingState />;
  }

  if (imagePreview) {
    return <ImageDiffPreview imagePreview={imagePreview} viewMode={viewMode} />;
  }

  if (binary) {
    // The shared binary state, worded and styled as on the web (REG-3024).
    return (
      <div
        className={`${POSTHOG_REPLAY_BLOCK_CLASS} flex min-h-0 flex-1 flex-col`}
      >
        <DiffBinaryState />
      </div>
    );
  }

  if (!oldValue && !newValue) {
    return (
      <div
        className={`${POSTHOG_REPLAY_BLOCK_CLASS} flex flex-1 items-center justify-center fg-secondary`}
      >
        <span className="text-s">No changes in this file</span>
      </div>
    );
  }

  const lineDiff = (
    <div
      className={`${POSTHOG_REPLAY_BLOCK_CLASS} diff-content-view flex-1 overflow-auto`}
    >
      <LineDiffViewer
        oldValue={oldValue}
        newValue={newValue}
        splitView={viewMode === 'split'}
        useDarkTheme={document.documentElement.classList.contains('dark')}
        showDiffOnly
        extraLinesSurroundingDiff={3}
        styles={DIFF_STYLES}
        codeFoldMessageRenderer={renderFoldMessage}
      />
    </div>
  );

  return (
    <Suspense fallback={<DiffLoadingState />}>
      {truncated ? (
        // The shared notice above the cut diff, as on the web (REG-3024).
        <div
          className={`${POSTHOG_REPLAY_BLOCK_CLASS} flex min-h-0 flex-1 flex-col`}
        >
          <DiffBoundNotice kind="oversized" className="m-2 shrink-0" />
          {lineDiff}
        </div>
      ) : (
        lineDiff
      )}
    </Suspense>
  );
}
