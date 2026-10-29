import { z } from 'zod';
import {
  IPC_CHANNELS,
  type NativeSubagentInterruptRequest,
  type NativeSubagentInterruptResult,
} from '@canopy/desktop-shared/types';
import {
  getClaudeNativeSubagentTaskForSession,
  getCodexNativeSubagentInterruptState,
} from '../agents/session-manager';
import { validateId, validateMessageAnchorId } from '../lib/validation';
import { registerIpcHandler } from './register';

const requestSchema = z
  .object({
    projectId: z.string(),
    worktreeId: z.string(),
    chatId: z.string(),
    subagentKind: z.enum(['claude-native', 'codex-native']),
    subagentId: z.string(),
  })
  .strict();

function parseRequest(raw: unknown): NativeSubagentInterruptRequest {
  const parsed = requestSchema.safeParse(raw);
  if (!parsed.success) throw new Error('Invalid native subagent request');
  const { projectId, worktreeId, chatId, subagentKind, subagentId } =
    parsed.data;
  validateId(projectId, 'projectId');
  validateId(worktreeId, 'worktreeId');
  validateId(chatId, 'chatId');
  // Claude Task tool_use ids include provider characters such as `_`; Codex
  // receiver thread ids are UUID-like. The bounded transcript-anchor validator
  // accepts both formats while rejecting paths, whitespace and controls.
  validateMessageAnchorId(subagentId, 'subagentId');
  return { projectId, worktreeId, chatId, subagentKind, subagentId };
}

function failure(
  code: Extract<NativeSubagentInterruptResult, { ok: false }>['code'],
  error: string,
): NativeSubagentInterruptResult {
  return { ok: false, code, error };
}

/** Interrupt a provider child without widening the request to its root chat. */
export async function interruptNativeSubagent(
  raw: unknown,
): Promise<NativeSubagentInterruptResult> {
  let request: NativeSubagentInterruptRequest;
  try {
    request = parseRequest(raw);
  } catch {
    return failure('failed', 'Invalid native subagent request.');
  }

  if (request.subagentKind === 'codex-native') {
    const state = getCodexNativeSubagentInterruptState(
      request.projectId,
      request.worktreeId,
      request.chatId,
      request.subagentId,
    );
    if (state === 'not_found') {
      return failure(
        'not_found',
        'Native subagent was not found in this chat.',
      );
    }
    if (state === 'not_running') {
      return failure('not_running', 'Native subagent is no longer running.');
    }
    // CodexRuntimeService currently exposes only root-turn interruption, which
    // also invalidates root approvals and questions. Never use it for a child.
    return failure(
      'unsupported',
      "Couldn't interrupt this Codex subagent safely.",
    );
  }

  const task = getClaudeNativeSubagentTaskForSession(
    request.projectId,
    request.worktreeId,
    request.chatId,
    request.subagentId,
  );
  if (!task) {
    return failure('not_found', 'Native subagent was not found in this chat.');
  }

  try {
    const { stopNativeSubagentForClaudeSession } =
      await import('../agents/claude-session');
    const outcome = await stopNativeSubagentForClaudeSession(
      request.projectId,
      request.worktreeId,
      request.chatId,
      request.subagentId,
      task.taskId,
      task.backgrounded,
    );
    if (outcome === 'stopped') return { ok: true };
    if (outcome === 'unsupported')
      return failure(
        'unsupported',
        "Couldn't safely background this Claude subagent.",
      );
    if (outcome === 'not_running') {
      return failure('not_running', 'Native subagent is no longer running.');
    }
    return failure('failed', "Couldn't interrupt the Claude subagent.");
  } catch {
    return failure('failed', "Couldn't interrupt the Claude subagent.");
  }
}

export function registerNativeSubagentHandlers(): void {
  registerIpcHandler<[unknown], NativeSubagentInterruptResult>(
    IPC_CHANNELS.nativeSubagentInterrupt,
    (_event, raw): Promise<NativeSubagentInterruptResult> =>
      interruptNativeSubagent(raw),
  );
}
