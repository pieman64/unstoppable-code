import {
  memo,
  type JSX,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import { AgentIcon } from '../icons/AgentIcon';
import { ArrowUpRightIcon } from '../icons/AppIcons';
import { AutomationsIcon } from '../icons/AutomationsIcon';
import { FolderIcon } from '../icons/FolderIcon';
import { McpServerIcon } from '../icons/McpServerIcon';
import { PipelineIcon } from '../icons/PipelineIcon';
import { PluginsIcon } from '../icons/PluginsIcon';
import { SkillIcon } from '../icons/SkillIcon';
import type { TooltipTriggerProps } from './RichHoverTooltip';
import type {
  CapabilityTileIconKind,
  CapabilityTileModel,
  CapabilityTileTone,
} from './capability-tile-model';

/**
 * How the host lets a tile open its item. A link renders a native anchor, an
 * action renders a button, and `none` renders a noninteractive group. Its
 * optional hint, such as "Open on desktop", is read out with the tile's
 * accessible name and never drawn as a line on the card.
 */
export type CapabilityTileAction =
  | {
      kind: 'link';
      href: string;
      external?: boolean;
      /**
       * Client-side routing for an in-app href. Modified clicks (new tab or
       * window) still fall through to the browser.
       */
      onNavigate?: (href: string) => void;
    }
  | { kind: 'action'; onActivate: () => void }
  | { kind: 'none'; hint?: string };

export interface CapabilityTileProps {
  model: CapabilityTileModel;
  action: CapabilityTileAction;
  /** Kept per receipt kind by the host, e.g. `agent-artifact-automation_run`. */
  testId: string;
  /** Wraps only the tile's trigger, e.g. in a hover tooltip. */
  wrapTrigger?: (trigger: ReactElement<TooltipTriggerProps>) => ReactNode;
  /**
   * A separate control such as Share. It renders beside the trigger, never
   * inside the anchor or button.
   */
  accessory?: ReactNode;
}

const ICONS: Record<
  CapabilityTileIconKind,
  (props: { width: number; height: number }) => JSX.Element
> = {
  pipeline: PipelineIcon,
  skill: SkillIcon,
  automation: AutomationsIcon,
  agent: AgentIcon,
  plugin: PluginsIcon,
  'mcp-server': McpServerIcon,
  collection: FolderIcon,
};

/** State text takes the intent's ink; routine states stay neutral. */
const TONE_INK: Record<CapabilityTileTone, string> = {
  success: 'fg-success-strong',
  info: 'fg-info',
  warning: 'fg-warning-strong',
  danger: 'fg-destructive-strong',
  muted: 'fg-secondary',
};

/**
 * Passes the Agent activity grid's rows through a tile: the tile spans two
 * row tracks, its body and its footer, so every footer hairline in a row
 * sits at the same height. Every element between the grid and the tile's
 * trigger takes this class, as the tile's own root and trigger do. Without
 * subgrid support the card just fills its cell and the footer sits at the
 * bottom of the card.
 */
export const CAPABILITY_TILE_CELL_CLASS =
  'h-full w-full supports-[grid-template-rows:subgrid]:row-span-2 supports-[grid-template-rows:subgrid]:grid supports-[grid-template-rows:subgrid]:grid-rows-subgrid';

// The 12px card radius shared with the other Agent activity cards; the
// Agent activity box's 20px corners nest it at the box's 8px inset. 16px
// padding at the sides and bottom; 13px at the top puts the leading icon's
// drawn ink as far from the top edge as from the left. The card
// fills its grid cell so every card in a row is as tall as the tallest; its
// content stays at the top (a block button would centre it vertically). As
// a subgrid its one column spans the card, so short content still runs to
// the right padding.
const TRIGGER_CLASS = `flex flex-col rounded-lg border bg-card px-4 pt-3.25 pb-4 text-left no-underline supports-[grid-template-rows:subgrid]:grid-cols-1 supports-[grid-template-rows:subgrid]:gap-y-0 ${CAPABILITY_TILE_CELL_CLASS}`;
const INTERACTIVE_CLASS = `focus-ring ${TRIGGER_CLASS} transition-colors hover:bg-fg-primary/[0.04]`;

function isPlainClick(event: MouseEvent<HTMLAnchorElement>): boolean {
  return (
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey
  );
}

function accessibleName(
  model: CapabilityTileModel,
  hint: string | undefined,
): string {
  return [
    model.name,
    model.kindLabel,
    model.operationLabel,
    model.state?.label,
    model.external ? 'External' : undefined,
    model.removedNote,
    hint,
  ]
    .filter((part): part is string => typeof part === 'string' && part !== '')
    .join(', ');
}

function TileBody({
  model,
  padForAccessory,
}: {
  model: CapabilityTileModel;
  padForAccessory: boolean;
}): JSX.Element {
  const Icon = ICONS[model.iconKind];
  // Under the name, one line says what the item is and where it comes from;
  // the agent's reason, when there is one, sits below a hairline in the
  // footer. The state says once, at the end of the name, whether it is ready
  // to use. Nothing is cut short: every line
  // wraps, breaking a long unbroken name only where it has no other break,
  // and the grid stretches the row's other cards to match. The footer takes
  // the row's shared footer track, so hairlines line up across a row; without
  // subgrid it sits at the bottom of the card. Pretty wrapping keeps a lone
  // word off the last line.
  const detail = [
    model.kindPhrase,
    model.sourceLabel,
    model.changeSummary ?? model.summary,
  ]
    .filter((part): part is string => typeof part === 'string' && part !== '')
    .join(' · ');
  return (
    <>
      <span className="flex min-w-0 gap-2">
        <span
          className="flex h-5 shrink-0 items-center fg-secondary"
          aria-hidden="true"
        >
          <Icon width={14} height={14} />
        </span>
        <span className="min-w-0 flex-1">
          <span
            className={`flex min-w-0 items-baseline gap-1${padForAccessory ? ' pr-7' : ''}`}
          >
            <span className="min-w-0 wrap-anywhere text-pretty text-sm font-medium fg-primary">
              {model.name}
            </span>
            {model.external ? (
              <span
                className="flex h-5 shrink-0 items-center self-start fg-secondary"
                aria-hidden="true"
              >
                <ArrowUpRightIcon width={14} height={14} />
              </span>
            ) : null}
            {model.state ? (
              <span
                className={`ml-auto shrink-0 pl-2 text-xs ${TONE_INK[model.state.tone]}`}
                data-testid="capability-tile-state"
              >
                {model.state.label}
              </span>
            ) : null}
          </span>
          <span className="mt-1 block wrap-anywhere text-pretty text-xs fg-tertiary">
            {detail}
          </span>
        </span>
      </span>
      {/* The footer, hairline included, starts where the name does (14px
          icon + 8px gap) and runs to the card's right padding. Measured on
          drawn ink, the text sits about 12px above the hairline and the
          reason about 12px below it. A card
          with nothing to say there has no footer. */}
      {model.reason || model.removedNote ? (
        <span className="mt-auto block pt-2.75 pl-5.5 supports-[grid-template-rows:subgrid]:mt-0">
          <span className="block border-t" aria-hidden="true" />
          {model.reason ? (
            <span className="mt-2 block wrap-anywhere text-pretty text-xs fg-secondary">
              {model.reason}
            </span>
          ) : null}
          {model.removedNote ? (
            <span
              className={`block wrap-anywhere text-pretty text-xs fg-tertiary ${model.reason ? 'mt-0.5' : 'mt-2'}`}
            >
              {model.removedNote}
            </span>
          ) : null}
        </span>
      ) : null}
    </>
  );
}

/**
 * Compact, display-only tile for a capability a chat turn created, changed,
 * ran, found or recommended. Hosts supply navigation; a removed item renders
 * without any active control.
 */
export const CapabilityTile = memo(function CapabilityTile({
  model,
  action: requestedAction,
  testId,
  wrapTrigger,
  accessory,
}: CapabilityTileProps): JSX.Element {
  const action: CapabilityTileAction = model.removed
    ? { kind: 'none' }
    : requestedAction;
  const hint = action.kind === 'none' ? action.hint : undefined;
  const label = accessibleName(model, hint);
  const padForAccessory = Boolean(accessory);
  const body = <TileBody model={model} padForAccessory={padForAccessory} />;
  let trigger: ReactElement<TooltipTriggerProps>;
  if (action.kind === 'link') {
    const { href, onNavigate } = action;
    trigger = (
      <a
        href={href}
        aria-label={label}
        onClick={
          onNavigate && !action.external
            ? (event): void => {
                if (!isPlainClick(event)) return;
                event.preventDefault();
                onNavigate(href);
              }
            : undefined
        }
        className={INTERACTIVE_CLASS}
        data-testid={testId}
        {...(action.external
          ? { target: '_blank', rel: 'noopener noreferrer' }
          : {})}
      >
        {body}
      </a>
    );
  } else if (action.kind === 'action') {
    trigger = (
      <button
        type="button"
        aria-label={label}
        onClick={action.onActivate}
        onKeyDown={(event): void => {
          // Activate on keydown, as the desktop artifact cards always have.
          if (event.key !== 'Enter' && event.key !== ' ') return;
          event.preventDefault();
          action.onActivate();
        }}
        className={INTERACTIVE_CLASS}
        data-testid={testId}
      >
        {body}
      </button>
    );
  } else {
    trigger = (
      <div
        role="group"
        aria-label={label}
        className={`${TRIGGER_CLASS}${model.removed ? ' opacity-70' : ''}`}
        data-testid={testId}
        data-unavailable={model.removed ? 'true' : undefined}
      >
        {body}
      </div>
    );
  }
  return (
    <div
      className={`relative min-w-0 ${CAPABILITY_TILE_CELL_CLASS}`}
      data-capability-tile=""
    >
      {wrapTrigger ? wrapTrigger(trigger) : trigger}
      {accessory ? (
        // Measured on drawn ink: 10px from the right puts the Share glyph as
        // far from the right edge as the leading icon is from the left
        // (18px), and 10px from the top centres it on the name line. The
        // button keeps its size; its hover and pressed fill is a circle.
        <div
          className="absolute right-2.5 top-2.5 [&_button]:rounded-full"
          data-capability-tile-accessory=""
        >
          {accessory}
        </div>
      ) : null}
    </div>
  );
});
