'use client';

import { useEffect, useState, type JSX } from 'react';
import { Disclosure } from '@canopy/ui-shared/components';
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
    <div className="space-y-2" data-testid="activity-todo-body">
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
            <div className="space-y-1.5">
              {completed.map((item) => (
                <TodoItemRow key={item.id} item={item} />
              ))}
            </div>
          </Disclosure>
        </div>
      )}
    </div>
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
        <TodoStatusIcon status={item.status} />
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

function TodoStatusIcon({
  status,
}: {
  status: TodoSectionBodyItem['status'];
}): JSX.Element {
  if (status === 'completed') {
    return (
      <svg
        width="14"
        height="14"
        viewBox="0 0 16 16"
        fill="none"
        className="shrink-0"
      >
        <circle
          cx="8"
          cy="8"
          r="7"
          stroke="currentColor"
          strokeWidth="1.5"
          className="fg-success-strong/70"
        />
        <path
          d="M5 8l2 2 4-4"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
          className="fg-success-strong/70"
        />
      </svg>
    );
  }
  if (status === 'in_progress') {
    return (
      <svg
        width="14"
        height="14"
        viewBox="0 0 16 16"
        fill="none"
        className="shrink-0"
      >
        <circle
          cx="8"
          cy="8"
          r="7"
          stroke="currentColor"
          strokeWidth="1.5"
          className="fg-info"
        />
        <circle cx="8" cy="8" r="2.5" fill="currentColor" className="fg-info" />
      </svg>
    );
  }
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      className="shrink-0"
    >
      <circle
        cx="8"
        cy="8"
        r="7"
        stroke="currentColor"
        strokeWidth="1.5"
        className="fg-secondary/60"
      />
    </svg>
  );
}
