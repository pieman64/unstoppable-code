import { getObservabilityService } from '../observability';
import type { HostedClaudeProcessDiagnostic } from './claude-process-host-runner';
import type { HostedClaudeProcessRecord } from './claude-process-registry';
import { parseChatSessionKey } from './session-key';

interface HostedClaudeProcessContext {
  sessionKey: string;
  sessionInstanceId?: string;
  delegationId?: string;
  providerType: 'claude' | 'ollama' | 'unknown';
}

const NO_CHAT_IDS = { projectId: '', worktreeId: '', chatId: '' };

function chatIds(sessionKey: string): typeof NO_CHAT_IDS {
  try {
    return parseChatSessionKey(sessionKey);
  } catch {
    // A malformed key must not drop the record: the PID still names the CLI.
    return NO_CHAT_IDS;
  }
}

function recordSessionScoped(
  context: HostedClaudeProcessContext,
  diagnostic: HostedClaudeProcessDiagnostic,
  untrackedReason: 'owner_unregistered' | 'previous_run',
): void {
  getObservabilityService().recordSessionDiagnostic({
    version: 1,
    timestamp: new Date().toISOString(),
    kind: diagnostic.kind,
    sessionKey: context.sessionKey,
    ...chatIds(context.sessionKey),
    providerType: context.providerType,
    ...(context.sessionInstanceId !== undefined
      ? { sessionInstanceId: context.sessionInstanceId }
      : {}),
    ...(context.delegationId !== undefined
      ? { delegationId: context.delegationId }
      : {}),
    ...(diagnostic.pid !== undefined ? { pid: diagnostic.pid } : {}),
    ...(diagnostic.kind === 'claude_process_exited'
      ? {
          exitCode: diagnostic.exitCode,
          signal: diagnostic.signal,
          uptimeMs: diagnostic.uptimeMs,
        }
      : {}),
    ...(diagnostic.kind === 'claude_process_untracked'
      ? {
          claudeProcessUntrackedReason: untrackedReason,
          ...(diagnostic.uptimeMs !== undefined
            ? { uptimeMs: diagnostic.uptimeMs }
            : {}),
        }
      : {}),
  });
}

/** Records a chat's or delegated run's hosted CLI lifecycle. */
export function recordHostedClaudeProcessDiagnostic(
  context: HostedClaudeProcessContext,
  diagnostic: HostedClaudeProcessDiagnostic,
): void {
  recordSessionScoped(context, diagnostic, 'owner_unregistered');
}

/**
 * Records a CLI the startup sweep reaped from a previous run: a session
 * diagnostic when the file named its chat, otherwise a global app diagnostic
 * that carries only the PID and uptime.
 */
export function recordReapedClaudeProcessDiagnostic(
  record: HostedClaudeProcessRecord,
): void {
  const uptimeMs = Math.max(0, Date.now() - record.startedAtMs);
  if (record.sessionKey === undefined) {
    getObservabilityService().recordAppDiagnostic({
      version: 1,
      timestamp: new Date().toISOString(),
      kind: 'claude_process_untracked',
      reason: 'previous_run',
      claudeProcessId: record.pid,
      processUptimeMs: uptimeMs,
    });
    return;
  }
  recordSessionScoped(
    {
      sessionKey: record.sessionKey,
      ...(record.sessionInstanceId !== undefined
        ? { sessionInstanceId: record.sessionInstanceId }
        : {}),
      ...(record.delegationId !== undefined
        ? { delegationId: record.delegationId }
        : {}),
      providerType: 'unknown',
    },
    { kind: 'claude_process_untracked', pid: record.pid, uptimeMs },
    'previous_run',
  );
}
