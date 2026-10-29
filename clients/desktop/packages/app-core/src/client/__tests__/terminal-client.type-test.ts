import type {
  CanopyClient,
  TerminalClient,
  TerminalCommandName,
  TerminalEventName,
  TerminalQueryName,
} from '@canopy/app-core/client';

declare const canopyClient: CanopyClient;
declare const terminalClient: TerminalClient;

const assignableFromFullClient: TerminalClient = canopyClient;
const queryName: TerminalQueryName = 'terminal.list';
const commandName: TerminalCommandName = 'terminal.spawn';
const eventName: TerminalEventName = 'terminal.output';

void assignableFromFullClient;
void queryName;
void commandName;
void eventName;

void terminalClient.query('terminal.list', {
  projectId: 'project-1',
  worktreeId: 'worktree-1',
});
void terminalClient.command('terminal.spawn', {
  projectId: 'project-1',
  worktreeId: 'worktree-1',
  cols: 80,
  rows: 24,
});
terminalClient.subscribe('terminal.output', () => {});

// @ts-expect-error TerminalClient excludes non-terminal queries.
void terminalClient.query('session.snapshot', {});
// @ts-expect-error TerminalClient excludes non-terminal commands.
void terminalClient.command('session.end', {});
// @ts-expect-error TerminalClient excludes non-terminal events.
terminalClient.subscribe('connection.status', () => {});

void terminalClient.command('terminal.spawn', {
  projectId: 'project-1',
  worktreeId: 'worktree-1',
  cols: 80,
  rows: 24,
  // @ts-expect-error Managed commands remain host-only.
  managedCommand: {
    executable: '/usr/bin/env',
    args: ['true'],
    kind: 'worker',
  },
});
