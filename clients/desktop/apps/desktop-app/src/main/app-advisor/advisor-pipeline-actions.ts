import path from 'node:path';
import { clampLimit } from '@canopy/desktop-shared/lib/app-advisor-chat-reads';
import type {
  AppAdvisorAction,
  AppAdvisorActionResponse,
  AppAdvisorJson,
} from '@canopy/desktop-shared/types';
import type { ExecutionState } from '@canopy/execution-engine/types/pipeline';
import { isRecord } from '../lib/type-guards';
import { validateId } from '../lib/validation';

export const ADVISOR_PIPELINE_ACTION_TYPES = [
  'pipeline.debug_run',
  'pipeline.execution_read_plan',
  'pipeline.execution_read_report',
  'pipeline.execution_start_over',
  'pipeline.execution_send_plan_to_chat',
  'pipeline.execution_send_report_to_chat',
] as const;

export type AdvisorPipelineAction = Extract<
  AppAdvisorAction,
  { type: (typeof ADVISOR_PIPELINE_ACTION_TYPES)[number] }
>;

export function isAdvisorPipelineAction(
  action: AppAdvisorAction,
): action is AdvisorPipelineAction {
  return ADVISOR_PIPELINE_ACTION_TYPES.some((type) => type === action.type);
}

export interface ChatTarget {
  projectId: string;
  worktreeId: string;
  chatId: string;
}

/** The main owners App Advisor's pipeline actions use (CAN-6001). */
export interface AdvisorPipelineActionHost {
  loadExecution(executionId: string): Promise<ExecutionState | null>;
  /** The report or plan, only from the path the state records and inside its allowed directories. */
  readArtifact(
    state: ExecutionState,
    artifact: { kind: 'report'; format?: 'text' | 'json' } | { kind: 'plan' },
  ): Promise<{ filePath: string; content: string } | null>;
  statFile(
    filePath: string,
  ): Promise<{ sizeBytes: number; modifiedAtMs: number } | null>;
  /** Reruns the execution from the start through main's pipeline handlers. */
  rerun(executionId: string): Promise<AppAdvisorJson>;
  /** The worktree's stored chat tabs, with its stored active tab. */
  readTabs(
    projectId: string,
    worktreeId: string,
  ): Promise<{
    activeTabId?: string;
    tabs: ReadonlyArray<{ id: string; kind?: string }>;
  } | null>;
  /** Sends to the chat through the owner behind worktree-chat.send_message. */
  sendToChat(target: ChatTarget, text: string): Promise<void>;
  /** Best effort: shows the chat in the main window when its lease is live. */
  revealChat(target: ChatTarget): Promise<void>;
  /** The failure debug prompt main builds for a failed execution. */
  debugPrompt(executionId: string): Promise<string>;
  /** Creates an App Advisor work entry and chat that receives `text` first. */
  createAdvisorChat(request: {
    title: string;
    text: string;
  }): Promise<{ workEntryId: string; chatId: string }>;
}

type Response = Omit<AppAdvisorActionResponse, 'requestId'>;

/** The renderer dispatcher's read limits, which App Advisor answered with before. */
const PIPELINE_CONTENT_DEFAULT_MAX_CHARS = 60_000;
const PIPELINE_CONTENT_MAX_CHARS = 500_000;

function failure(
  code: 'invalid_target' | 'not_found' | 'execution_failed',
  message: string,
): Response {
  return { ok: false, error: { code, message } };
}

function truncateContent(
  content: string,
  maxChars: number | undefined,
): { content: string; truncated: boolean; originalLength: number } {
  const limit = clampLimit(
    maxChars,
    PIPELINE_CONTENT_DEFAULT_MAX_CHARS,
    PIPELINE_CONTENT_MAX_CHARS,
  );
  return content.length <= limit
    ? { content, truncated: false, originalLength: content.length }
    : {
        content: content.slice(0, limit),
        truncated: true,
        originalLength: content.length,
      };
}

async function loadExecution(
  executionId: string,
  host: AdvisorPipelineActionHost,
): Promise<{ state: ExecutionState } | { response: Response }> {
  try {
    validateId(executionId, 'executionId');
  } catch {
    return { response: failure('invalid_target', 'Invalid execution id.') };
  }
  const state = await host.loadExecution(executionId);
  return state
    ? { state }
    : {
        response: failure(
          'not_found',
          `Pipeline execution ${executionId} was not found.`,
        ),
      };
}

const DEFAULT_DEBUG_TITLE = 'Debug workflow';

function debugTitle(state: ExecutionState, prompt: string): string {
  const name = state.pipeline_snapshot?.name?.trim();
  if (name) return `Debug ${name}`;
  const firstLine = prompt
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!firstLine) return DEFAULT_DEBUG_TITLE;
  return firstLine.length > 40 ? `${firstLine.slice(0, 37)}...` : firstLine;
}

async function run(
  action: AdvisorPipelineAction,
  host: AdvisorPipelineActionHost,
): Promise<Response> {
  const loaded = await loadExecution(action.executionId, host);
  if ('response' in loaded) return loaded.response;
  const { state } = loaded;
  switch (action.type) {
    case 'pipeline.execution_read_report': {
      const kind = action.kind ?? 'text';
      const report = await host.readArtifact(state, {
        kind: 'report',
        format: kind,
      });
      if (!report)
        return failure('not_found', 'Pipeline execution report was not found.');
      return {
        ok: true,
        result: {
          executionId: state.id,
          kind,
          filePath: report.filePath,
          ...truncateContent(report.content, action.maxChars),
        },
      };
    }
    case 'pipeline.execution_read_plan': {
      const plan = await host.readArtifact(state, { kind: 'plan' });
      if (!plan)
        return failure(
          'not_found',
          'This pipeline execution does not have a saved plan file.',
        );
      const stat = await host.statFile(plan.filePath);
      return {
        ok: true,
        result: {
          executionId: state.id,
          filePath: plan.filePath,
          filename: path.basename(plan.filePath),
          ...(stat
            ? { sizeBytes: stat.sizeBytes, modifiedAtMs: stat.modifiedAtMs }
            : {}),
          planModified: state.plan_hash_before !== state.plan_hash_after,
          ...truncateContent(plan.content, action.maxChars),
        },
      };
    }
    case 'pipeline.execution_start_over': {
      const rerun = await host.rerun(state.id);
      // The rerun owner reports a refusal as success: false, never by throwing.
      if (!isRecord(rerun) || rerun.success !== true)
        return failure(
          'execution_failed',
          isRecord(rerun) && typeof rerun.error === 'string'
            ? rerun.error
            : 'Failed to start over pipeline execution.',
        );
      return { ok: true, result: rerun };
    }
    case 'pipeline.execution_send_report_to_chat':
    case 'pipeline.execution_send_plan_to_chat': {
      const report = action.type === 'pipeline.execution_send_report_to_chat';
      if (!state.project_id || !state.worktree_id)
        return failure(
          'invalid_target',
          'This pipeline execution is not linked to a worktree chat.',
        );
      if (action.chatId !== undefined) {
        try {
          validateId(action.chatId, 'chatId');
        } catch {
          return failure('invalid_target', 'Invalid chat id.');
        }
      }
      // Only the path main read for this execution reaches the chat.
      const artifact = await host.readArtifact(
        state,
        report ? { kind: 'report' } : { kind: 'plan' },
      );
      if (!artifact)
        return failure(
          'not_found',
          report
            ? 'This pipeline execution does not have a saved report file.'
            : 'This pipeline execution does not have a saved plan file.',
        );
      const stored = await host.readTabs(state.project_id, state.worktree_id);
      if (!stored)
        return failure(
          'not_found',
          `No chat state found for worktree ${state.project_id}/${state.worktree_id}.`,
        );
      const chatId = action.chatId ?? stored.activeTabId;
      const tab = stored.tabs.find((candidate) => candidate.id === chatId);
      if (!chatId || !tab)
        return failure(
          'not_found',
          `Chat tab ${chatId || '(active)'} was not found.`,
        );
      if (tab.kind === 'file')
        return failure(
          'invalid_target',
          'The target tab is a file tab, not a chat transcript.',
        );
      const target = {
        projectId: state.project_id,
        worktreeId: state.worktree_id,
        chatId,
      };
      const line = `${report ? 'Review this report:' : 'Review this plan:'} ${artifact.filePath}`;
      const prompt = action.prompt?.trim();
      await host.sendToChat(target, prompt ? `${prompt}\n\n${line}` : line);
      await host.revealChat(target).catch(() => undefined);
      return { ok: true, result: { ...target, path: artifact.filePath } };
    }
    case 'pipeline.debug_run': {
      if (state.status !== 'failure')
        return failure(
          'invalid_target',
          `Pipeline execution ${state.id} not found or not failed.`,
        );
      const prompt = await host.debugPrompt(state.id);
      if (!prompt.trim())
        return failure(
          'execution_failed',
          'Failed to build pipeline-debug prompt.',
        );
      const created = await host.createAdvisorChat({
        title: debugTitle(state, prompt),
        text: prompt,
      });
      return {
        ok: true,
        result: { chatId: created.chatId, workEntryId: created.workEntryId },
      };
    }
  }
}

/**
 * App Advisor's remaining pipeline actions in Electron main (CAN-6001). Each
 * reads only the execution main resolves by id: its report and plan come
 * from the paths its state records, inside its directories; a send names
 * only that path; start over reruns only that execution; a debug run's
 * prompt and title come only from it, in a new App Advisor chat.
 */
export async function dispatchAdvisorPipelineAction(
  action: AdvisorPipelineAction,
  host: AdvisorPipelineActionHost,
): Promise<Response> {
  try {
    return await run(action, host);
  } catch (error) {
    return failure(
      'execution_failed',
      error instanceof Error ? error.message : String(error),
    );
  }
}
