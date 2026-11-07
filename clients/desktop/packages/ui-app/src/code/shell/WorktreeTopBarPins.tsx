'use client';

import type { JSX } from 'react';
import {
  HeaderActionButton,
  LoadingSpinner,
} from '@canopy/ui-shared/components';
import { PlayIcon } from '@canopy/ui-shared/icons/AppIcons';
import { REPLAY_BLOCK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import { HEADER_PRIORITY } from '../pull-requests/PullRequestActions';

/**
 * One pinned script in the worktree top bar. Hosts pass only actions they can
 * run now (approved, available, with a terminal); the bar renders, the host
 * executes.
 */
export interface WorktreeTopBarPinnedAction {
  readonly id: string;
  /** Visible label and accessible name, e.g. `dev`. */
  readonly label: string;
  /** First line of the command, shown in the tooltip. */
  readonly command: string;
  /** Where it runs, e.g. `canopy/apps/web`. */
  readonly target: string;
  /** Platform display string for its shortcut, e.g. `⌘⇧D`. */
  readonly shortcut?: string;
  /** Its terminal reports a running command; a click shows that terminal. */
  readonly running: boolean;
  /** A run is being started. */
  readonly pending?: boolean;
  readonly onRun: () => void;
}

function PinTooltip({ pin }: { pin: WorktreeTopBarPinnedAction }): JSX.Element {
  return (
    <span className="flex flex-col gap-0.5">
      <span>
        {pin.running ? `${pin.label} is running` : `Run ${pin.label}`}
      </span>
      <code className={`${REPLAY_BLOCK_CLASS} font-mono fg-secondary`}>
        {pin.command}
      </code>
      <span className="fg-secondary">Runs in {pin.target}</span>
      {pin.shortcut !== undefined && (
        <span className="fg-secondary">Shortcut {pin.shortcut}</span>
      )}
    </span>
  );
}

function pinAccessibleName(pin: WorktreeTopBarPinnedAction): string {
  return pin.running ? `Show running ${pin.label}` : `Run ${pin.label}`;
}

function PinGlyph({ pin }: { pin: WorktreeTopBarPinnedAction }): JSX.Element {
  return pin.running || pin.pending === true ? (
    <LoadingSpinner decorative className="shrink-0" />
  ) : (
    <PlayIcon size="sm" className="shrink-0" aria-hidden="true" />
  );
}

/**
 * The pinned-script run in the top bar's action cluster. Labels shed first
 * (`HEADER_PRIORITY.pinLabels`), then the whole run drops
 * (`HEADER_PRIORITY.pins`) before the launch cluster does. Each pin renders a
 * labelled and a compact button; container queries show exactly one, so the
 * hidden one is out of the accessibility tree.
 */
export function WorktreeTopBarPins({
  pins,
}: {
  pins: readonly WorktreeTopBarPinnedAction[];
}): JSX.Element | null {
  if (pins.length === 0) return null;
  return (
    <div
      data-testid="worktree-top-pins"
      className={`${HEADER_PRIORITY.pins} electron-no-drag items-center gap-1`}
    >
      {pins.map((pin) => {
        const state = pin.running
          ? 'running'
          : pin.pending === true
            ? 'pending'
            : 'idle';
        const run = (): void => {
          if (pin.pending !== true) pin.onRun();
        };
        return (
          <div
            key={pin.id}
            data-testid="worktree-top-pin"
            data-pin-id={pin.id}
            data-state={state}
            className="electron-no-drag flex items-center"
          >
            <span
              data-pin-variant="labelled"
              className={HEADER_PRIORITY.pinLabels}
            >
              <HeaderActionButton
                tone="neutral"
                data-testid="worktree-top-pin-labelled"
                aria-label={pinAccessibleName(pin)}
                aria-busy={pin.pending === true}
                tooltipLabel={<PinTooltip pin={pin} />}
                onClick={run}
              >
                <PinGlyph pin={pin} />
                <span className="max-w-32 truncate">{pin.label}</span>
              </HeaderActionButton>
            </span>
            <span
              data-pin-variant="compact"
              className={HEADER_PRIORITY.pinCompact}
            >
              <HeaderActionButton
                tone="neutral"
                iconOnly
                data-testid="worktree-top-pin-compact"
                aria-label={pinAccessibleName(pin)}
                aria-busy={pin.pending === true}
                tooltipLabel={<PinTooltip pin={pin} />}
                onClick={run}
              >
                <PinGlyph pin={pin} />
              </HeaderActionButton>
            </span>
          </div>
        );
      })}
    </div>
  );
}
