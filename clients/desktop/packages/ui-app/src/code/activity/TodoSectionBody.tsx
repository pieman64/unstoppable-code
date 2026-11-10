'use client';

import { useEffect, useState, type JSX } from 'react';
import { Stack, Disclosure, StatusGlyph } from '@canopy/ui-shared/components';
import type { StatusGlyphState } from '@canopy/ui-shared/lib';
import { Surface } from '@canopy/ui-shared/components';

export interface TodoSectionBodyItem {
  readonly id: string;
  readonly content: string;
  readonly status: 'pending' | 'in_progress' | 'completed';
}

export interface TodoSectionBodyProps {
  readonly items: readonly TodoSectionBodyItem[];
  readonly resetKey?: string;
}

export function TodoSectionBody({
  items,
  resetKey,
}: TodoSectionBodyProps): JSX.Element | null {
  const [showCompleted, setShowCompleted] = useState(false);

  useEffect(() => {
    setShowCompleted(false);
  }, [resetKey]);

  // Explicit empty contract: hosts (desktop wrapper today) guard before
  // mounting, but a props-only shared body must not render an empty
  // container if a future host forgets to.
  if (items.length === 0) {
    return null;
  }

  const completed = items.filter((t) => t.status === 'completed');
  const active = items.filter((t) => t.status === 'in_progress');
  const pending = items.filter((t) => t.status === 'pending');
  const completedCount = completed.length;
  return (
    <Stack gap="inline" data-testid="activity-todo-body">
      {/* Active tasks */}
      {active.map((item) => (
        <TodoItemRow key={item.id} item={item} />
      ))}

      {/* Pending tasks */}
      {pending.map((item) => (
        <TodoItemRow key={item.id} item={item} />
      ))}

      {/* Completed tasks (collapsible) */}
      {completedCount > 0 && (
        <div className="pt-1">
          <Disclosure
            label={`Completed (${completedCount})`}
            open={showCompleted}
            onOpenChange={setShowCompleted}
            dataTestId="activity-todo-completed"
            toggleTestId="activity-todo-completed-toggle"
          >
            <div className="flex flex-col gap-1.5">
              {completed.map((item) => (
                <TodoItemRow key={item.id} item={item} />
              ))}
            </div>
          </Disclosure>
        </div>
      )}
    </Stack>
  );
}

function TodoItemRow({ item }: { item: TodoSectionBodyItem }): JSX.Element {
  const isCompleted = item.status === 'completed';
  const isActive = item.status === 'in_progress';

  return (
    <Surface variant="group">
      <div
        className="flex items-center gap-2.5 px-3 py-2"
        data-testid="activity-todo-item"
      >
        <StatusGlyph state={TODO_STATES[item.status]} />
        <span
          className={`text-xs ${
            isCompleted
              ? 'fg-secondary/60 line-through'
              : isActive
                ? 'font-medium fg-primary/80'
                : 'fg-secondary'
          }`}
        >
          {item.content}
        </span>
      </div>
    </Surface>
  );
}

const TODO_STATES: Readonly<
  Record<TodoSectionBodyItem['status'], StatusGlyphState>
> = {
  completed: 'done',
  in_progress: 'running',
  pending: 'queued',
};
