import {
  memo,
  type JSX,
  type MouseEvent,
  type ReactElement,
  type ReactNode,
} from 'react';
import { AgentIcon } from '../icons/AgentIcon';
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
 * action renders a button, and `none` renders a noninteractive group with an
 * optional hint such as "Open on desktop".
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

const TONE_CLASSES: Record<CapabilityTileTone, { pill: string; dot: string }> =
  {
    success: {
      pill: 'ring-line-positive/40 bg-success-subtle fg-primary',
      dot: 'bg-success',
    },
    info: {
      pill: 'ring-fg-info/40 bg-info-subtle fg-primary',
      dot: 'bg-info',
    },
    warning: {
      pill: 'ring-line-attention/40 bg-warning-subtle fg-primary',
      dot: 'bg-warning',
    },
    danger: {
      pill: 'ring-line-destructive/40 bg-destructive-subtle fg-primary',
      dot: 'bg-destructive',
    },
    muted: {
      pill: 'bg-fg-primary/[0.04] fg-secondary',
      dot: 'bg-fg-secondary/70',
    },
  };

const TRIGGER_CLASS =
  'block w-full rounded-lg border bg-card px-3 py-2 text-left no-underline';
const INTERACTIVE_CLASS = `focus-ring ${TRIGGER_CLASS} transition hover:bg-fg-primary/[0.04]`;

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
  hint,
  padForAccessory,
}: {
  model: CapabilityTileModel;
  hint?: string;
  padForAccessory: boolean;
}): JSX.Element {
  const Icon = ICONS[model.iconKind];
  const tone = model.state ? TONE_CLASSES[model.state.tone] : null;
  const detail = model.changeSummary ?? model.summary;
  const footnote = model.removedNote ?? hint;
  return (
    <>
      <span
        className={`flex items-center gap-2 text-xs${padForAccessory ? ' pr-9' : ''}`}
      >
        <span className="shrink-0 fg-secondary" aria-hidden="true">
          <Icon width={14} height={14} />
        </span>
        <span className="truncate fg-secondary">{model.kindLabel}</span>
        {model.external ? (
          <span className="shrink-0 rounded px-1.5 py-0.5 text-3xs font-medium bg-fg-primary/[0.08] fg-secondary">
            External
          </span>
        ) : null}
        <span className="ml-auto shrink-0 rounded-full bg-fg-primary/[0.08] px-2 py-0.5 text-3xs font-medium">
          {model.operationLabel}
        </span>
      </span>
      <span className="mt-1 block truncate text-sm font-medium fg-primary">
        {model.name}
      </span>
      {detail ? (
        <span className="block truncate text-xs fg-secondary">{detail}</span>
      ) : null}
      {model.reason ? (
        <span className="mt-0.5 line-clamp-2 block text-xs fg-secondary">
          {model.reason}
        </span>
      ) : null}
      {model.state || model.sourceLabel || footnote ? (
        <span className="mt-1 flex min-w-0 flex-wrap items-center gap-1 text-3xs">
          {model.state && tone ? (
            <span
              className={`inline-flex shrink-0 items-center gap-1 rounded-full ring-1 ring-inset px-2 py-0.5 font-medium ${tone.pill}`}
              data-testid="capability-tile-state"
            >
              <span
                className={`h-1.5 w-1.5 rounded-full ${tone.dot}`}
                aria-hidden="true"
              />
              {model.state.label}
            </span>
          ) : null}
          {model.sourceLabel ? (
            <span className="truncate fg-secondary">{model.sourceLabel}</span>
          ) : null}
          {footnote ? (
            <span
              className="truncate fg-secondary"
              data-testid="capability-tile-hint"
            >
              {footnote}
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
  const body = (
    <TileBody model={model} hint={hint} padForAccessory={padForAccessory} />
  );
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
    <div className="relative min-w-0" data-capability-tile="">
      {wrapTrigger ? wrapTrigger(trigger) : trigger}
      {accessory ? (
        <div className="absolute right-2 top-1">{accessory}</div>
      ) : null}
    </div>
  );
});
