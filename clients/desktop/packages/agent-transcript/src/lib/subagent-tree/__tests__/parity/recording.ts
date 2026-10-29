/** Shared shapes of the CAN-4051 parity recordings. */

export const PARITY_T0 = Date.parse('2026-10-16T12:00:00.000Z');

export const PARITY_PROJECT_ID = 'parity-project';
export const PARITY_WORKTREE_ID = 'parity-worktree';

export function isoAt(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

/**
 * One event as the desktop chat store receives it: a provider event (`data`)
 * or a line batch from the background output poller (`output`).
 */
export type DesktopRecordedEvent =
  | { readonly at: number; readonly data: Readonly<Record<string, unknown>> }
  | {
      readonly at: number;
      readonly output: {
        readonly taskId: string;
        readonly outputFile: string;
        readonly lines: readonly string[];
      };
    };

/** One row of Agentic Core's durable client event log. */
export interface CoreRecordedEvent {
  readonly seq: string;
  readonly type: string;
  readonly occurredAt: string;
  readonly taskId?: string;
  readonly payload: Readonly<Record<string, unknown>>;
}

/** One Agentic Core conversation message row. */
export interface CoreMessageRow {
  readonly id: string;
  readonly turnId: string;
  readonly taskId?: string;
  readonly role: 'USER' | 'ASSISTANT';
  readonly sourceKey?: string;
  readonly content: string;
  readonly contentBlocks?: readonly (
    | { readonly type: 'text'; readonly text: string }
    | {
        readonly type: 'tool_call';
        readonly toolCallId: string;
        readonly toolName: string;
      }
  )[];
  readonly createdAt: string;
}

/** Everything Agentic Core holds for one recorded chat. */
export interface CloudRecording {
  readonly events: readonly CoreRecordedEvent[];
  readonly messages: readonly CoreMessageRow[];
  /** The latest row of every task, as Core's task reads return them. */
  readonly tasks: readonly Readonly<Record<string, unknown>>[];
}
