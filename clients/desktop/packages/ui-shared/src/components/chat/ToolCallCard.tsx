import { useState, type JSX, type ReactNode } from 'react';
import { MinusIcon, PlusIcon } from '../../icons';
import { StepTenseProvider, useCleanChatLook } from '../chat-look';
import {
  containsTensedVerb,
  hasTensedStepLabel,
  readableToolInput,
} from './tool-display';
import { STEP_ROW_BODY_CLASS, StepRow } from './StepRow';
import {
  getToolFamilyIcon,
  type PortalChatToolFamily,
} from './tool-display-info';

/** Command and output under an opened clean step: quiet, borderless code. */
const CLEAN_OUTPUT_CLASS =
  'max-h-75 overflow-auto whitespace-pre-wrap break-words rounded-md bg-fg-primary/[0.04] px-2.5 py-1.5 font-mono text-xs fg-secondary';

/**
 * Result shape carried by a tool call. Mirrors the desktop `ToolResult` shape
 * (output + isError) but uses the kind-based discriminator preferred by the
 * web portal so both sides can share this primitive.
 */
export interface ToolCallResult {
  kind: 'text' | 'error';
  content: string;
}

/** Decode live objects and JSON-serialized persisted results for the same card. */
export function readToolCallResult(value: unknown): ToolCallResult | null {
  let result: unknown = value;
  if (typeof result === 'string') {
    try {
      result = JSON.parse(result);
    } catch {
      return null;
    }
  }
  if (result === null || typeof result !== 'object' || Array.isArray(result)) {
    return null;
  }
  const output =
    'output' in result && typeof result.output === 'string'
      ? result.output
      : 'content' in result && typeof result.content === 'string'
        ? result.content
        : 'text' in result && typeof result.text === 'string'
          ? result.text
          : null;
  if (output === null) return null;
  return {
    kind: 'isError' in result && result.isError === true ? 'error' : 'text',
    content: output,
  };
}

export interface ToolCallCardProps {
  /**
   * Tool family used to dispatch the leading icon. When omitted the renderer
   * falls back to the generic wrench icon (treated as `unknown`).
   */
  toolFamily?: PortalChatToolFamily;
  /** Raw tool name string. Used as the default label when `label` is unset. */
  toolName: string;
  /**
   * Optional rich label rendered to the right of the icon. Hosts can pass a
   * pre-formatted React element (e.g. "Read foo.ts" with code chunks) so the
   * desktop's existing `ToolDisplayInfo` table can keep producing inline
   * filename/command chunks.
   */
  label?: ReactNode;
  /**
   * Optional call-specific icon. Hosts use this when the raw tool name is not
   * enough to choose the right icon, such as Codex `file_change` delete rows.
   */
  icon?: ReactNode;
  /**
   * Optional host-provided branded app icon. Used for the `canopy`/app family
   * because this shared package cannot know the active product brand.
   */
  appIcon?: ReactNode;
  /**
   * Raw tool input. Rendered inside the expanded panel as a preformatted
   * block. Hosts can omit when the input is empty.
   */
  input?: string;
  /** Resolved tool result. Renders below `input` inside the expanded panel. */
  result?: ToolCallResult | null;
  /**
   * Tool execution status. Controls the pending spinner + error badge.
   * Defaults to `'success'` when `result` is set without `error`, `'error'`
   * when the result is an error, and `'pending'` when no result is set.
   */
  status?: 'pending' | 'success' | 'error';
  /** Whether the body starts collapsed. Defaults to `true`. */
  defaultCollapsed?: boolean;
  /** Reveal a search target without changing the saved collapse state. */
  forceExpanded?: boolean;
  /** Optional pending-spinner slot. Hosts pass their own animated dots. */
  pendingSpinner?: ReactNode;
  /** Custom expanded-panel slot. When supplied, replaces input/result chrome. */
  expandedSlot?: ReactNode;
  /**
   * Test ID hook for automation. Independent of this hook, the card root
   * always exposes nonvisual `data-tool-name` (raw canonical tool name) and
   * `data-tool-status` (`pending` | `success` | `error`) attributes.
   */
  dataTestId?: string;
}

/**
 * Pure display tool-call card. Renders an icon + label row that toggles a
 * preformatted input/result panel when clicked. Hosts wrap this with the
 * stateful concerns they need (copy buttons, restore-on-expand persistence)
 * — this primitive only owns the visual chrome + the local expand toggle.
 */
export function ToolCallCard({
  toolFamily,
  toolName,
  label,
  icon,
  appIcon,
  input,
  result,
  status,
  defaultCollapsed = true,
  forceExpanded = false,
  pendingSpinner,
  expandedSlot,
  dataTestId,
}: ToolCallCardProps): JSX.Element {
  const [open, setIsOpen] = useState(!defaultCollapsed);
  const isOpen = forceExpanded || open;
  const Icon = getToolFamilyIcon(toolFamily);
  const renderedIcon =
    icon ?? (toolFamily === 'canopy' && appIcon != null ? appIcon : <Icon />);

  const resolvedStatus: 'pending' | 'success' | 'error' =
    status ??
    (result == null
      ? 'pending'
      : result.kind === 'error'
        ? 'error'
        : 'success');
  const isPending = resolvedStatus === 'pending';
  const isError = resolvedStatus === 'error';
  // Clean chat look: the shared step row, with readable details when opened.
  const clean = useCleanChatLook();
  if (clean) {
    const shownInput =
      input != null ? readableToolInput(toolName, input) : undefined;
    return (
      <div
        data-testid={dataTestId}
        data-tool-name={toolName}
        data-tool-status={resolvedStatus}
      >
        <StepTenseProvider
          value={isPending ? 'running' : isError ? 'failed' : 'done'}
        >
          <StepRow
            icon={renderedIcon}
            label={label ?? toolName}
            running={isPending}
            // The label on screen may carry the verb even when a host passes
            // it ready-made without the input (large-output steps).
            failed={
              isError &&
              !containsTensedVerb(label) &&
              !hasTensedStepLabel(toolName, input ?? '')
            }
            expandable
            isOpen={isOpen}
            onToggle={(): void => setIsOpen((prev) => !prev)}
          />
        </StepTenseProvider>
        {isOpen && (
          <div className={STEP_ROW_BODY_CLASS}>
            {expandedSlot ?? (
              <div className="space-y-1">
                {shownInput != null && shownInput.length > 0 && (
                  <pre className={CLEAN_OUTPUT_CLASS}>{shownInput}</pre>
                )}
                {result && result.content.length > 0 && (
                  <pre className={CLEAN_OUTPUT_CLASS}>{result.content}</pre>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  return (
    <div
      data-testid={dataTestId}
      data-tool-name={toolName}
      data-tool-status={resolvedStatus}
    >
      <button
        type="button"
        onClick={(): void => setIsOpen((prev) => !prev)}
        className="group flex w-full items-center gap-2 py-1 text-xs fg-secondary transition"
        aria-expanded={isOpen}
        data-tool-family={toolFamily ?? 'unknown'}
      >
        {/*
          Fixed 14px (h-3.5 w-3.5) slot that centers whichever icon is shown
          and clamps every descendant SVG to the same size. The leading icon
          swaps to a plus/minus glyph on hover; without a fixed slot a taller
          icon (e.g. a brand logo) would shrink the row when the swap happens,
          jittering the layout. Normalizing the SVG size keeps the canopy/brand
          logo the correct size instead of overflowing the row.
        */}
        <span
          className={`flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center [&_svg]:h-3.5 [&_svg]:w-3.5 [&_svg]:shrink-0 ${
            isError ? 'fg-destructive' : ''
          }`}
        >
          <span className="flex group-hover:hidden">{renderedIcon}</span>
          <span className="hidden group-hover:flex">
            {isOpen ? <MinusIcon /> : <PlusIcon />}
          </span>
        </span>
        <span className="min-w-0 truncate">{label ?? toolName}</span>
        {isPending && pendingSpinner != null && (
          <span className="ml-1 inline-flex -translate-y-px flex-shrink-0 fg-accent">
            {pendingSpinner}
          </span>
        )}
      </button>
      {isOpen && (
        <div className="ml-5.5 mt-1 overflow-hidden rounded border bg-fg-primary/[0.02]">
          {expandedSlot ?? (
            <>
              {input != null && input.length > 0 && (
                <pre className="max-h-50 overflow-auto whitespace-pre-wrap break-all px-2.5 py-2 text-xs fg-secondary">
                  {input}
                </pre>
              )}
              {result && (
                <>
                  <div className="border-t px-2.5 py-1 text-3xs font-medium fg-secondary">
                    {result.kind === 'error' ? 'Error' : 'Result'}
                  </div>
                  <pre
                    className={`max-h-75 overflow-auto whitespace-pre-wrap break-all px-2.5 py-2 text-xs ${
                      result.kind === 'error'
                        ? 'fg-destructive/80'
                        : 'fg-secondary'
                    }`}
                  >
                    {result.content}
                  </pre>
                </>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
