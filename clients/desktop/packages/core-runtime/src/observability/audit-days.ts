// Audit day files, retention cutoffs and entry ordering. Day files are named
// by UTC day (`YYYY-MM-DD.jsonl`).
import type { AgentAuditEntry } from '@canopy/protocol/observability';

export interface AuditDayWindow {
  startDay?: string;
  endDay?: string;
}

export function toIsoDay(value: string | Date): string {
  const date = typeof value === 'string' ? new Date(value) : value;
  return date.toISOString().slice(0, 10);
}

function readIsoDayPrefix(value: string | undefined): string | undefined {
  if (!value || value.length < 10) {
    return undefined;
  }

  const day = value.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) {
    return undefined;
  }

  const timestamp = Date.parse(`${day}T00:00:00.000Z`);
  return Number.isFinite(timestamp) ? day : undefined;
}

/**
 * The start of the day a retention file or directory is named for, or null
 * when the name is not a calendar date. Retention never deletes such a name.
 */
export function retainedDayStartTime(day: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
  const time = Date.parse(`${day}T00:00:00.000Z`);
  return Number.isFinite(time) &&
    new Date(time).toISOString().slice(0, 10) === day
    ? time
    : null;
}

function shiftIsoDay(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function buildAuditDayWindow(
  startDate: string | undefined,
  endDate: string | undefined,
): AuditDayWindow {
  const window: AuditDayWindow = {};
  const startDay = readIsoDayPrefix(startDate);
  const endDay = readIsoDayPrefix(endDate);

  if (startDay) {
    window.startDay = shiftIsoDay(startDay, -1);
  }
  if (endDay) {
    window.endDay = shiftIsoDay(endDay, 1);
  }

  return window;
}

function readAuditFilenameDay(filename: string): string | undefined {
  const match = /^(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(filename);
  if (!match) {
    return undefined;
  }
  return readIsoDayPrefix(match[1]);
}

export function isAuditFileInsideWindow(
  filename: string,
  window: AuditDayWindow,
): boolean {
  const day = readAuditFilenameDay(filename);
  if (!day) {
    return false;
  }

  if (window.startDay && day < window.startDay) {
    return false;
  }
  if (window.endDay && day > window.endDay) {
    return false;
  }
  return true;
}

export function isStartedAtInsideRange(
  startedAt: string,
  startDate: string | undefined,
  endDate: string | undefined,
): boolean {
  const startedAtTime = Date.parse(startedAt);
  if (!Number.isFinite(startedAtTime)) {
    return false;
  }

  if (startDate) {
    const startTime = Date.parse(startDate);
    if (Number.isFinite(startTime) && startedAtTime < startTime) {
      return false;
    }
  }

  if (endDate) {
    const endTime = Date.parse(endDate);
    if (Number.isFinite(endTime) && startedAtTime >= endTime) {
      return false;
    }
  }

  return true;
}

export function getRetentionCutoffTime(retentionDays: number): number {
  const cutoff = new Date();
  cutoff.setUTCHours(0, 0, 0, 0);
  cutoff.setUTCDate(cutoff.getUTCDate() - retentionDays);
  return cutoff.getTime();
}

export function compareEntries(
  left: AgentAuditEntry,
  right: AgentAuditEntry,
): number {
  const timeDiff =
    new Date(right.startedAt).getTime() - new Date(left.startedAt).getTime();
  if (timeDiff !== 0) {
    return timeDiff;
  }
  return right.id.localeCompare(left.id);
}
