'use client';

import type { JSX } from 'react';
import {
  Button,
  type ButtonSize,
  MCP_SIGN_IN_WAITING_LABEL,
} from '@canopy/ui-shared/components';
import {
  mcpConnectActionLabel,
  mcpConnectToAccountActionLabel,
  mcpUseAccountConnectionActionLabel,
} from './mcpConnectionCopy';

/**
 * What the primary MCP connection action does. `connect-to-account` and
 * `use-account` move a desktop sign-in to the account; only a host that has
 * device servers offers them.
 */
export type McpConnectAction =
  | 'add'
  | 'enable'
  | 'connect'
  | 'reconnect'
  | 'connect-to-account'
  | 'use-account';

/** Where the action is: idle, saving, or waiting on the browser sign-in. */
export type McpConnectActionPhase = 'idle' | 'connecting' | 'waiting';

export function mcpConnectActionButtonLabel(
  action: McpConnectAction,
  phase: McpConnectActionPhase,
  serviceName?: string,
): string {
  if (phase === 'waiting') return `${MCP_SIGN_IN_WAITING_LABEL}…`;
  if (phase === 'connecting') return 'Connecting…';
  switch (action) {
    case 'add':
      return 'Add';
    case 'enable':
      return 'Enable';
    case 'connect':
    case 'reconnect':
      return serviceName !== undefined
        ? mcpConnectActionLabel(serviceName, action === 'reconnect')
        : action === 'reconnect'
          ? 'Reconnect'
          : 'Sign in';
    case 'connect-to-account':
      return serviceName !== undefined
        ? mcpConnectToAccountActionLabel(serviceName)
        : 'Connect to your account';
    case 'use-account':
      return serviceName !== undefined
        ? mcpUseAccountConnectionActionLabel(serviceName)
        : 'Use from your account';
  }
}

export interface McpConnectActionButtonProps {
  readonly action: McpConnectAction;
  readonly phase?: McpConnectActionPhase;
  readonly serviceName?: string;
  /** Replaces the idle label, e.g. **Connect** where sign-in is not known. */
  readonly label?: string;
  readonly size?: ButtonSize;
  /** `secondary` when a host primary, such as Try it, owns the accent. */
  readonly variant?: 'primary' | 'secondary';
  readonly disabled?: boolean;
  readonly onClick: () => void;
  readonly 'data-testid'?: string;
}

/** The primary MCP connection action, shared by the desktop and the web. */
export function McpConnectActionButton({
  action,
  phase = 'idle',
  serviceName,
  label,
  size,
  variant = 'primary',
  disabled = false,
  onClick,
  'data-testid': testId,
}: McpConnectActionButtonProps): JSX.Element {
  return (
    <Button
      variant={variant}
      size={size}
      disabled={disabled || phase !== 'idle'}
      onClick={onClick}
      data-testid={testId}
    >
      {phase === 'idle' && label !== undefined
        ? label
        : mcpConnectActionButtonLabel(action, phase, serviceName)}
    </Button>
  );
}
