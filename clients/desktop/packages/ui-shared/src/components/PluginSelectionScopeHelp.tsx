import type { JSX } from 'react';
import { InfoIcon } from '../icons/InfoIcon';
import { RichHoverTooltip } from './RichHoverTooltip';

const SCOPE_GUIDANCE = [
  'This list comes from your available skills, plugin marketplaces, collections, and configured MCP servers.',
  'Source shows where each item comes from.',
  'Selections apply to every chat in this project, including existing chats, from their next message.',
  'A chat can still turn a default off.',
  'Selections do not install plugins.',
  'Chats can also inherit global defaults and account-managed connectors.',
] as const;

/**
 * Catalog provenance and scope shared by desktop project settings surfaces:
 * one line, with the full guidance behind an info button.
 */
export function PluginSelectionScopeHelp(): JSX.Element {
  return (
    <div
      data-testid="workspace-plugin-scope-help"
      className="flex min-w-0 items-center gap-1 text-xs fg-secondary"
    >
      <span className="min-w-0 truncate">
        Defaults for every chat in this project. A chat can still turn one off.
      </span>
      <RichHoverTooltip
        dataTestId="workspace-plugin-scope-help-details"
        surfacePadding="card"
        surfaceClassName="w-80"
        dismissOnEscape
        content={
          <div className="flex flex-col gap-1 text-xs">
            <p className="font-medium fg-primary">How project defaults work</p>
            <ul className="list-disc space-y-0.5 pl-4 fg-secondary">
              {SCOPE_GUIDANCE.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </div>
        }
      >
        <button
          type="button"
          aria-label="How project defaults work"
          className="focus-ring shrink-0 rounded p-0.5 fg-secondary transition-colors hover:fg-primary"
        >
          <InfoIcon aria-hidden="true" />
        </button>
      </RichHoverTooltip>
    </div>
  );
}
