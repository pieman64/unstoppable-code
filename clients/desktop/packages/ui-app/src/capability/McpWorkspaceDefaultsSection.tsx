'use client';

import { useState, type JSX } from 'react';
import { WORKSPACE_LABEL, WORKSPACE_LABEL_PLURAL } from '@canopy/protocol';
import { Button } from '@canopy/ui-shared';
import {
  MCP_WORKSPACE_DEFAULTS_HINT,
  mcpWorkspaceDefaultsStatus,
  workspaceDefaultMcpLabel,
} from './accountMcpRows';

export interface McpWorkspaceDefaultsChoice {
  readonly id: string;
  readonly name: string;
  /** Whether the project's default plugins include the server; undefined until read. */
  readonly enabled: boolean | undefined;
}

export interface McpWorkspaceDefaultsSectionProps {
  /** Projects the server can be added to. The first one starts selected. */
  readonly workspaces: readonly McpWorkspaceDefaultsChoice[];
  /** True while the projects' default plugins are being read. */
  readonly loading?: boolean;
  readonly onAdd: (workspaceId: string) => Promise<void>;
  readonly onRemove: (workspaceId: string) => Promise<void>;
  readonly testId: string;
}

const SELECT_CLASS =
  'focus-ring min-w-0 max-w-56 truncate rounded-md bg-base px-2 py-1 text-s fg-primary ring-1 ring-inset ring-line-base';

/**
 * Where a signed-in MCP server is on by default. Signing in only makes the
 * server available to the account; chats use it once it is in a project's
 * default plugins or turned on in the chat. Hosts own the reads and writes.
 */
export function McpWorkspaceDefaultsSection({
  workspaces,
  loading = false,
  onAdd,
  onRemove,
  testId,
}: McpWorkspaceDefaultsSectionProps): JSX.Element | null {
  const [targetId, setTargetId] = useState<string | null>(null);
  const [pending, setPending] = useState<'add' | 'remove' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const target =
    workspaces.find((workspace): boolean => workspace.id === targetId) ??
    workspaces[0];
  if (target === undefined) return null;
  const enabledNames = workspaces
    .filter((workspace): boolean => workspace.enabled === true)
    .map((workspace): string => workspace.name);
  const allRead = workspaces.every(
    (workspace): boolean => workspace.enabled !== undefined,
  );
  const inNoProject = !loading && allRead && enabledNames.length === 0;
  const run = async (kind: 'add' | 'remove'): Promise<void> => {
    setPending(kind);
    setError(null);
    try {
      if (kind === 'add') await onAdd(target.id);
      else await onRemove(target.id);
    } catch {
      setError(
        kind === 'add'
          ? `Couldn't add the server to ${target.name}. Try again.`
          : `Couldn't remove the server from ${target.name}. Try again.`,
      );
    } finally {
      setPending(null);
    }
  };
  return (
    <section
      className="flex flex-col gap-2"
      aria-label={`${WORKSPACE_LABEL} defaults`}
      data-testid={testId}
    >
      <p className="text-s" data-testid={`${testId}-status`}>
        {loading ? (
          <span className="fg-secondary">
            {`Checking ${WORKSPACE_LABEL_PLURAL.toLowerCase()}…`}
          </span>
        ) : inNoProject ? (
          <>
            <span className="font-medium fg-primary">
              {mcpWorkspaceDefaultsStatus([])}
            </span>{' '}
            <span className="fg-tertiary">{MCP_WORKSPACE_DEFAULTS_HINT}</span>
          </>
        ) : enabledNames.length > 0 ? (
          <span className="font-medium fg-primary">
            {mcpWorkspaceDefaultsStatus(enabledNames)}
          </span>
        ) : null}
      </p>
      <div className="flex flex-wrap items-center gap-2">
        {workspaces.length > 1 && (
          <select
            aria-label={WORKSPACE_LABEL}
            value={target.id}
            disabled={pending !== null}
            onChange={(event): void => {
              setTargetId(event.target.value);
              setError(null);
            }}
            className={SELECT_CLASS}
            data-testid={`${testId}-select`}
          >
            {workspaces.map((workspace) => (
              <option key={workspace.id} value={workspace.id}>
                {workspace.name}
              </option>
            ))}
          </select>
        )}
        {target.enabled === true ? (
          <Button
            variant="secondary"
            size="sm"
            disabled={pending !== null}
            aria-label={`Remove from ${target.name}`}
            onClick={(): void => void run('remove')}
            data-testid={`${testId}-remove`}
          >
            {pending === 'remove' ? 'Removing…' : 'Remove'}
          </Button>
        ) : (
          <Button
            variant="primary"
            size="sm"
            disabled={pending !== null || loading}
            onClick={(): void => void run('add')}
            data-testid={`${testId}-add`}
          >
            {pending === 'add'
              ? 'Adding…'
              : workspaceDefaultMcpLabel(target.name)}
          </Button>
        )}
      </div>
      {error && (
        <p
          role="status"
          className="text-xs fg-destructive"
          data-testid={`${testId}-error`}
        >
          {error}
        </p>
      )}
    </section>
  );
}
