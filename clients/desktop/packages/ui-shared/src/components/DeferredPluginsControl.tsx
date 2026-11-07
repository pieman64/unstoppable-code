import type { JSX } from 'react';
import { CognitionIcon } from '../icons/CognitionIcon';
import { ActionTooltip } from './ActionTooltip';

export interface DeferredPluginsControlProps {
  allowed: boolean;
  disabled?: boolean;
  onChange: (allowed: boolean) => void;
}

/** One policy control for chats that support deferred capability loading. */
export function DeferredPluginsControl({
  allowed,
  disabled = false,
  onChange,
}: DeferredPluginsControlProps): JSX.Element {
  return (
    <div className="flex min-w-0 items-center gap-2">
      <ActionTooltip
        title="Deferred plugins"
        description={
          allowed
            ? 'Allow this chat to discover and enable missing skills, plugins, and MCP servers.'
            : 'Prevent this chat from discovering or enabling deferred skills, plugins, and MCP servers.'
        }
      >
        <button
          type="button"
          role="switch"
          aria-checked={allowed}
          aria-label="Allow deferred plugins for this chat"
          onClick={() => onChange(!allowed)}
          disabled={disabled}
          data-testid="chat-plugins-deferred-tools-toggle"
          data-active={allowed ? 'true' : 'false'}
          className={`focus-ring inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border transition-colors ${
            allowed
              ? 'border-fg-info/30 bg-info-subtle fg-info hover:bg-info-subtle/80'
              : 'bg-popover fg-secondary hover:bg-fg-primary/[0.06] hover:fg-primary'
          }`}
        >
          <CognitionIcon size="sm" aria-hidden="true" />
        </button>
      </ActionTooltip>
      <span
        className="truncate text-2xs fg-secondary"
        data-testid="chat-plugins-deferred-tools-state"
      >
        {allowed ? 'Deferred plugins allowed' : 'Deferred plugins not allowed'}
      </span>
    </div>
  );
}
