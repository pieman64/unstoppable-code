import type { Query } from '@anthropic-ai/claude-agent-sdk';
import { setTimeout as delay } from 'node:timers/promises';
import type { ProviderMcpSession } from './provider-session-availability';
import type { McpActivationHandoff } from './activation-handoff';

export async function refreshClaudeMcpAvailability(
  query: Pick<Query, 'mcpServerStatus'>,
  session: ProviderMcpSession,
  signal?: AbortSignal,
): Promise<void> {
  const binding = session.binding;
  if (!binding) return;
  const deadline = AbortSignal.any([
    AbortSignal.timeout(5000),
    ...(signal ? [signal] : []),
  ]);
  deadline.throwIfAborted();
  let onAbort = (): void => {};
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = (): void => reject(new Error('MCP status check was interrupted'));
    deadline.addEventListener('abort', onAbort, { once: true });
  });
  const statuses = await Promise.race([
    query.mcpServerStatus(),
    aborted,
  ]).finally(() => deadline.removeEventListener('abort', onAbort));
  deadline.throwIfAborted();
  for (const status of statuses) {
    if (status.status === 'connected' && status.tools !== undefined)
      session.observe(binding, status.name, {
        kind: 'tools',
        initialized: true,
        complete: true,
        toolCount: status.tools.length,
      });
    else if (status.status === 'needs-auth')
      session.observe(binding, status.name, { kind: 'auth_required' });
    else if (status.status === 'pending')
      session.observe(binding, status.name, { kind: 'connecting' });
    else if (status.status === 'failed' || status.status === 'disabled')
      session.observe(binding, status.name, {
        kind: 'unavailable',
        reasonCode: status.status === 'disabled' ? 'removed' : 'startup_failed',
      });
  }
}

/** Query control runs before the prompt; only activation-required targets gate admission. */
export async function prepareClaudeMcpActivation(
  query: Pick<Query, 'mcpServerStatus'>,
  session: ProviderMcpSession,
  handoff: McpActivationHandoff,
  userMessageId: string | undefined,
): Promise<void> {
  const finished = new AbortController();
  const signal = AbortSignal.any([handoff.signal, finished.signal]);
  const refresh = async (): Promise<void> => {
    while (!signal.aborted) {
      await refreshClaudeMcpAvailability(query, session, signal);
      await delay(250, undefined, { signal });
    }
  };
  void refresh().catch(() => {
    if (!signal.aborted) handoff.failed();
  });
  try {
    await handoff.beforePrompt(userMessageId);
  } finally {
    finished.abort();
  }
}
