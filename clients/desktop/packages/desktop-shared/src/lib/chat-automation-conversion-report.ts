/**
 * What the chat automation migration (CAN-5479) would do with a stored
 * automations file, read only: each automation either converts, already runs
 * a workflow, isn't a chat automation, or stays native for a named reason.
 * The shapes carry field names and flags only, never values, so they can be
 * shared to characterize real stores without personal data.
 */
import type { ScheduledActivity } from '../types';
import {
  convertibleChatAutomation,
  type ChatAutomationConversionRefusal,
} from './chat-automation-conversion';

export type ChatAutomationConversionVerdict =
  | 'converts'
  | 'workflow'
  | 'not_chat'
  | `stays_native:${ChatAutomationConversionRefusal}`;

/** An automation's shape: which fields it sets, never what they hold. */
export interface ChatAutomationShape {
  actionType: string;
  enabled: boolean;
  scheduleKind: string;
  /** Names of the action's set fields, sorted. */
  actionFields: string[];
  /** Activity-level facts that decide conversion. */
  flags: string[];
  verdict: ChatAutomationConversionVerdict;
}

export interface ChatAutomationConversionReportEntry {
  id: string;
  name: string;
  shape: ChatAutomationShape;
}

export interface ChatAutomationConversionReport {
  entries: ChatAutomationConversionReportEntry[];
  /** How many automations reached each verdict. */
  totals: Partial<Record<ChatAutomationConversionVerdict, number>>;
}

function verdictOf(
  activity: ScheduledActivity,
): ChatAutomationConversionVerdict {
  if (activity.action.type === 'worktree_pipeline') return 'workflow';
  const verdict = convertibleChatAutomation(activity);
  if (verdict.convertible) return 'converts';
  return verdict.reason === 'not_a_chat_action'
    ? 'not_chat'
    : `stays_native:${verdict.reason}`;
}

function flagsOf(activity: ScheduledActivity): string[] {
  const flags: string[] = [];
  const { installedFrom } = activity;
  if (installedFrom) {
    flags.push(`installed:${installedFrom.sourceKind ?? 'shared'}`);
    if (installedFrom.capabilityPackage) flags.push('capability_package');
  }
  if (activity.agentAuthor) flags.push('agent_author');
  if (activity.agentScheduledSend) flags.push('agent_scheduled_send');
  if (activity.targetRequirement) flags.push('target_requirement');
  if (activity.ifCommand) flags.push('gate_command');
  return flags;
}

function shapeOf(activity: ScheduledActivity): ChatAutomationShape {
  return {
    actionType: activity.action.type,
    enabled: activity.enabled,
    scheduleKind: activity.schedule.kind,
    actionFields: Object.entries(activity.action)
      .filter(([key, value]) => key !== 'type' && value !== undefined)
      .map(([key]) => key)
      .sort(),
    flags: flagsOf(activity),
    verdict: verdictOf(activity),
  };
}

export function chatAutomationConversionReport(
  activities: readonly ScheduledActivity[],
): ChatAutomationConversionReport {
  const entries = activities.map((activity) => ({
    id: activity.id,
    name: activity.name,
    shape: shapeOf(activity),
  }));
  const totals: ChatAutomationConversionReport['totals'] = {};
  for (const { shape } of entries)
    totals[shape.verdict] = (totals[shape.verdict] ?? 0) + 1;
  return { entries, totals };
}
