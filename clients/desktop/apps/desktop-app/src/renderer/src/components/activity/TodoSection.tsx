import { useMemo, type JSX, type ReactNode } from 'react';
import { useShallow } from 'zustand/shallow';
import { TodoSectionBody } from '@canopy/ui-app';
import { TasksIcon } from '@canopy/ui-shared/icons/AppIcons';
import {
  useActiveChatTabRenderState,
  useChatStore,
  useWorktreeChatRenderState,
} from '@/stores/chatStore';
import type { CollapsedIconColor } from '@/components/shared/panel-section';
import { useEarlyAccessTitle } from '@/lib/earlyAccessTitles';
import { ProgressBar, type SpaceRole } from '@canopy/ui-shared/components';
import { ActivitySection } from './ActivitySection';

// eslint-disable-next-line react-refresh/only-export-components
export function useTodoHeaderChrome(scope?: {
  projectId: string;
  worktreeId: string;
}): {
  subtitle: ReactNode;
  subtitleGap?: SpaceRole;
  collapsedIconColor: CollapsedIconColor;
} {
  // useShallow: the selector builds a fresh {completed,total} object per call;
  // without it every chat-store tick re-renders and, mounted always-on in the
  // shared panel chrome, that fed a setState loop (React #185) that took down
  // the whole renderer window.
  const selectedWorktree = useChatStore((state) => state.selectedWorktree);
  const selection = scope ?? selectedWorktree;
  const counts = useActiveChatTabRenderState(
    selection ? `${selection.projectId}/${selection.worktreeId}` : null,
    useShallow(({ tab }) => {
      const items = [
        ...(tab?.currentTodos ?? []),
        ...(tab?.currentTaskTodos ?? []),
      ];
      return {
        completed: items.filter((item) => item.status === 'completed').length,
        total: items.length,
      };
    }),
  );
  if (counts.total === 0) {
    return { subtitle: 'No agent tasks', collapsedIconColor: 'muted' };
  }
  const percentage = (counts.completed / counts.total) * 100;
  return {
    subtitle: (
      <div className="flex items-center gap-2">
        <ProgressBar
          value={percentage}
          size="compact"
          className="flex-1"
          label={`${counts.completed} of ${counts.total} tasks completed`}
          hideLabel
        />
        <span className="text-2xs fg-secondary">
          {counts.completed}/{counts.total}
        </span>
      </div>
    ),
    subtitleGap: 'inline',
    collapsedIconColor: 'amber',
  };
}

export function TodoSection(): JSX.Element {
  const headerChrome = useTodoHeaderChrome();
  const title = useEarlyAccessTitle('Agent Tasks');
  const sel = useChatStore((s) => s.selectedWorktree);
  const selectedKey = sel ? `${sel.projectId}/${sel.worktreeId}` : null;
  const currentTodos = useActiveChatTabRenderState(
    selectedKey,
    ({ tab }) => tab?.currentTodos,
  );
  const currentTaskTodos = useActiveChatTabRenderState(
    selectedKey,
    ({ tab }) => tab?.currentTaskTodos,
  );
  const activeTabId = useWorktreeChatRenderState(
    selectedKey,
    (wc) => wc?.activeTabId,
  );

  const todos = useMemo(() => {
    const todoItems = (currentTodos ?? []).map((item) => ({
      ...item,
      id: `todo:${item.id}`,
    }));
    const taskItems = currentTaskTodos ?? [];
    if (todoItems.length === 0 && taskItems.length === 0) return undefined;
    return [...todoItems, ...taskItems];
  }, [currentTodos, currentTaskTodos]);

  const hasTodos = todos && todos.length > 0;

  if (!hasTodos) {
    return (
      <ActivitySection
        icon={<TasksIcon />}
        title={title}
        subtitle={headerChrome.subtitle}
        subtitleGap={headerChrome.subtitleGap}
        collapsedIconColor={headerChrome.collapsedIconColor}
      />
    );
  }

  return (
    <ActivitySection
      icon={<TasksIcon />}
      title={title}
      subtitle={headerChrome.subtitle}
      subtitleGap={headerChrome.subtitleGap}
      collapsedIconColor={headerChrome.collapsedIconColor}
    >
      <TodoSectionBody items={todos} resetKey={activeTabId} />
    </ActivitySection>
  );
}
