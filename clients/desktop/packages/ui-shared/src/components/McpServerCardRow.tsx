import type { JSX, ReactNode } from 'react';
import { COMPACT_ACTIVITY_ITEM_CLASS_NAME } from './activity-item-density';
import { Button, buttonClassName } from './Button';

/** Hosts resolve identities; the shared row only renders the supplied control. */
export type McpRowDestination =
  | { readonly kind: 'button'; readonly onActivate: () => void }
  | { readonly kind: 'link'; readonly href: string };

export function McpRowSettings({
  destination,
  name,
}: {
  readonly destination?: McpRowDestination;
  readonly name: string;
}): JSX.Element | null {
  if (!destination) return null;
  return (
    <div className="mt-1.5 text-2xs">
      {destination.kind === 'button' ? (
        <Button
          variant="link"
          onClick={destination.onActivate}
          aria-label={`Open MCP settings for ${name}`}
          data-testid="mcp-servers-card-settings"
        >
          Open MCP settings
        </Button>
      ) : (
        <a
          className={buttonClassName({ variant: 'link' })}
          href={destination.href}
          target="_blank"
          rel="noopener"
          aria-label={`Open MCP settings for ${name} (opens in a new tab)`}
          data-testid="mcp-servers-card-settings"
        >
          Open MCP settings
        </a>
      )}
    </div>
  );
}

export interface McpServerCardRowProps {
  readonly name: string;
  readonly enabled: boolean;
  readonly destination?: McpRowDestination;
  readonly compact?: boolean;
  readonly alignActions?: 'start' | 'center';
  readonly metadata?: ReactNode;
  readonly status?: ReactNode;
  readonly children?: ReactNode;
  readonly actions?: ReactNode;
}

export function McpServerCardRow({
  name,
  enabled,
  destination,
  compact = false,
  alignActions = 'start',
  metadata,
  status,
  children,
  actions,
}: McpServerCardRowProps): JSX.Element {
  const nameClass = compact
    ? 'min-w-0 break-words fg-primary'
    : 'min-w-0 break-words text-s font-medium fg-primary';
  const controlClass = `focus-ring rounded text-left hover:underline ${nameClass}`;
  return (
    <li
      className={
        compact
          ? `group/mcp-row flex flex-wrap ${COMPACT_ACTIVITY_ITEM_CLASS_NAME}`
          : alignActions === 'center'
            ? 'flex flex-wrap items-center justify-between gap-2 px-2.5 py-2'
            : 'flex flex-wrap items-start justify-between gap-2 px-2.5 py-2'
      }
      data-testid="mcp-servers-card-row"
      data-enabled={enabled ? 'true' : 'false'}
    >
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          {destination === undefined ? (
            <span className={nameClass} data-testid="mcp-servers-card-name">
              {name}
            </span>
          ) : destination.kind === 'button' ? (
            <button
              type="button"
              className={controlClass}
              onClick={destination.onActivate}
              data-testid="mcp-servers-card-name"
            >
              {name}
            </button>
          ) : (
            <a
              className={controlClass}
              href={destination.href}
              target="_blank"
              rel="noopener"
              aria-label={`${name} (opens in a new tab)`}
              data-testid="mcp-servers-card-name"
            >
              {name}
            </a>
          )}
          {metadata}
          {status}
        </div>
        {children}
      </div>
      <div className="flex max-w-full shrink-0 flex-wrap items-center gap-1.5">
        {actions}
      </div>
    </li>
  );
}
