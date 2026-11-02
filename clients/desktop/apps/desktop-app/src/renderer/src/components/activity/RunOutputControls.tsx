import { type JSX, type ReactNode } from 'react';
import { LoadingSpinner } from '../shared/loading/spinners/LoadingSpinner';
import { AnsiOutput } from './AnsiOutput';
import {
  HeaderActionButton,
  RunningProcessCard,
} from '@canopy/ui-shared/components';
import { ExternalIcon, SettingsIcon } from '@canopy/ui-shared/icons/AppIcons';

/** Thin wrapper around the shared loading-spinner used in both sections. */
export function Spinner(): JSX.Element {
  return <LoadingSpinner />;
}

/** Settings gear button with the activity-row hover-treatment. Used by both
 * the Hooks and Scripts sections to open per-section settings. */
export function SettingsGearButton({
  onClick,
  label,
}: {
  onClick: () => void;
  label: string;
}): JSX.Element {
  return (
    <HeaderActionButton iconOnly onClick={onClick} aria-label={label}>
      <SettingsIcon size={16} />
    </HeaderActionButton>
  );
}

/**
 * The inline live-output ribbon (`max-h-40`, ~12 visible rows) is a tail view:
 * users watch the latest output and open the enlarge modal for full history.
 * Rendering only the last N lines keeps the streaming DOM tiny instead of
 * mounting the store's full 1000-line cap on every flush.
 */
const INLINE_LIVE_OUTPUT_TAIL_LINES = 12;

interface LiveOutputShellProps {
  /** ANSI lines to stream into the embedded `AnsiOutput`. */
  outputLines: string[];
  /** Inline status content rendered to the right of the spinner — typically
   * the running label, e.g. `"Running scriptName…"` or
   * `"Stopping launch…"` for scripts. Hook callers always pass a static
   * label since hooks have no stopping state. */
  statusContent: ReactNode;
  /** Stop-button caption. Scripts swap this between `Stop` and
   * `Stopping…` while a stop is in-flight; hooks always pass `Stop`. */
  stopLabel: ReactNode;
  /** Disable the stop button while a stop is in-flight. Scripts toggle this;
   * hooks leave it false. */
  stopDisabled?: boolean;
  onStop: () => void;
  onEnlarge: () => void;
  /**
   * Optional slot rendered before the Stop button. Scripts pass a
   * {@link DevServerOpenControl} here when at least one dev-server URL has
   * been detected in the streamed output; hooks omit. */
  devServerSlot?: ReactNode;
}

/**
 * Shared sky-tinted live-output container used by both the Hooks and Scripts
 * sections. Owns the enlarge button, spinner, status row, stop control, and
 * embedded ANSI output. Section-specific text (script "stopping" copy, hook
 * pause/resume in the row above) stays in the parent.
 */
export function LiveOutputShell({
  outputLines,
  statusContent,
  stopLabel,
  stopDisabled,
  onStop,
  onEnlarge,
  devServerSlot,
}: LiveOutputShellProps): JSX.Element {
  return (
    <RunningProcessCard
      statusContent={statusContent}
      stopLabel={stopLabel}
      stopDisabled={stopDisabled}
      onStop={onStop}
      spinner={<Spinner />}
      enlargeButton={
        <button
          type="button"
          onClick={onEnlarge}
          className="focus-ring rounded p-0.5 fg-accent/70 transition-colors hover:fg-accent"
          aria-label="Enlarge output"
        >
          <ExternalIcon size={14} />
        </button>
      }
      actionSlot={devServerSlot}
      body={
        <AnsiOutput
          lines={outputLines}
          variant="tail"
          maxRenderLines={INLINE_LIVE_OUTPUT_TAIL_LINES}
          truncateLines
        />
      }
    />
  );
}

/**
 * Visual variants for {@link CompletedRunCard}. The two `stopped-*` variants
 * exist because the Scripts section historically renders manually-stopped
 * runs with the neutral muted treatment while the Hooks section uses amber —
 * collapsing them would change visible behavior, which the cleanup plan
 * forbids.
 */
export type CompletedRunCardKind =
  | 'success'
  | 'failed'
  | 'stopped-muted'
  | 'stopped-amber';

interface CompletedRunCardProps {
  /** Visible label rendered next to the enlarge button. */
  label: string;
  kind: CompletedRunCardKind;
  /** Right-side status text — caller computes "Success" / "Stopped" /
   * "Timed out" / `Exit ${n}` because the script and hook variants encode
   * exit metadata differently. */
  statusText: string;
  /** Run duration in milliseconds — converted to seconds and rounded for the
   * trailing "· N s" segment. */
  durationMs: number;
  onEnlarge: () => void;
}

/**
 * Shared completed-run card used by both Hook and Script entries. The
 * kind → color mapping preserves the previous per-section treatment one
 * variant at a time (no behavior change).
 */
export function CompletedRunCard({
  label,
  kind,
  statusText,
  durationMs,
  onEnlarge,
}: CompletedRunCardProps): JSX.Element {
  const containerClass =
    kind === 'failed'
      ? 'border-fg-destructive-strong/20 bg-fg-destructive-strong/[0.06]'
      : kind === 'stopped-amber'
        ? 'border-line-attention bg-warning/[0.06]'
        : // success and stopped-muted both render with the neutral chrome
          'bg-fg-primary/[0.015]';

  const enlargeButtonClass =
    kind === 'failed'
      ? 'fg-destructive-strong/70 hover:fg-destructive-strong'
      : kind === 'stopped-amber'
        ? 'fg-warning/70 hover:fg-warning'
        : kind === 'stopped-muted'
          ? 'fg-secondary/70 hover:fg-secondary'
          : 'fg-success-strong/70 hover:fg-success-strong';

  const labelClass =
    kind === 'failed'
      ? 'fg-destructive-strong'
      : kind === 'stopped-amber'
        ? 'fg-warning'
        : kind === 'stopped-muted'
          ? 'fg-secondary'
          : 'fg-success-strong';

  return (
    <div className={`rounded-lg border p-2.5 text-xs ${containerClass}`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onEnlarge}
            className={`focus-ring rounded p-0.5 transition-colors ${enlargeButtonClass}`}
            aria-label="Enlarge output"
          >
            <ExternalIcon size={14} />
          </button>
          <span className={`font-medium ${labelClass}`}>{label}</span>
        </div>
        <span className="text-3xs fg-secondary">
          {statusText} · {Math.round(durationMs / 1000)}s
        </span>
      </div>
    </div>
  );
}
