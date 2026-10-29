import type { TodoItem } from '../types';

function isTodoStatus(value: unknown): value is TodoItem['status'] {
  return (
    value === 'pending' || value === 'in_progress' || value === 'completed'
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function normalizeTaskId(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return '';
}

export function parseTodoItems(input: string): TodoItem[] {
  try {
    const parsed: unknown = JSON.parse(input);
    if (!isRecord(parsed)) return [];
    const todos = parsed.todos;
    if (!Array.isArray(todos)) return [];
    return todos
      .filter(
        (
          item,
        ): item is {
          id?: unknown;
          content: string;
          status: TodoItem['status'];
        } =>
          isRecord(item) &&
          typeof item.content === 'string' &&
          isTodoStatus(item.status),
      )
      .map(
        (item, i): TodoItem => ({
          id: typeof item.id === 'string' ? item.id : `_idx:${i}`,
          content: item.content,
          status: item.status,
        }),
      );
  } catch {
    return [];
  }
}

export function parseTaskCreateItem(
  input: string,
  fallbackId: string,
): TodoItem | null {
  try {
    const parsed: unknown = JSON.parse(input);
    if (!isRecord(parsed)) return null;
    const rawId = parsed.taskId ?? parsed.task_id ?? parsed.id ?? fallbackId;
    const id = normalizeTaskId(rawId);
    const content =
      typeof parsed.subject === 'string' && parsed.subject.trim().length > 0
        ? parsed.subject.trim()
        : typeof parsed.description === 'string' &&
            parsed.description.trim().length > 0
          ? parsed.description.trim()
          : '';
    if (!id || !content) return null;
    return {
      id: `task:${id}`,
      content,
      status: isTodoStatus(parsed.status) ? parsed.status : 'pending',
    };
  } catch {
    return null;
  }
}

export function applyTaskUpdateItem(
  items: TodoItem[] | undefined,
  input: string,
): TodoItem[] | undefined {
  try {
    const parsed: unknown = JSON.parse(input);
    if (!isRecord(parsed)) return items;
    const rawId = parsed.taskId ?? parsed.task_id ?? parsed.id;
    const taskId = normalizeTaskId(rawId);
    if (!taskId) return items;
    const id = `task:${taskId}`;
    const status = isTodoStatus(parsed.status) ? parsed.status : undefined;
    const content =
      typeof parsed.subject === 'string' && parsed.subject.trim().length > 0
        ? parsed.subject.trim()
        : typeof parsed.description === 'string' &&
            parsed.description.trim().length > 0
          ? parsed.description.trim()
          : undefined;
    if (!status && !content) return items;

    const existing = items ?? [];
    const index = existing.findIndex((item) => item.id === id);
    if (index < 0) {
      return [
        ...existing,
        {
          id,
          content: content ?? `Task ${taskId}`,
          status: status ?? 'pending',
        },
      ];
    }

    const next = existing.slice();
    next[index] = {
      ...next[index],
      ...(content ? { content } : {}),
      ...(status ? { status } : {}),
    };
    return next;
  } catch {
    return items;
  }
}
