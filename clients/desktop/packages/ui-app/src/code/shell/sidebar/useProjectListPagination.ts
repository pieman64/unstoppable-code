'use client';

import { useState } from 'react';

const PROJECT_PAGE_SIZE = 10;

/** Limits mounted project rows without changing their order or stored visibility. */
export function useProjectListPagination<T>(
  projects: readonly T[],
  getId: (project: T) => string,
  retainedIds: readonly (string | null | undefined)[],
  scopeKey: string,
  enabled = true,
): {
  projects: readonly T[];
  remainingCount: number;
  expanded: boolean;
  showMore: () => void;
  showLess: () => void;
} {
  const [page, setPage] = useState({ scopeKey, limit: PROJECT_PAGE_SIZE });
  // Reset before children render in another Personal/organization context.
  // Selection changes do not expand the intervening hundreds of projects.
  if (page.scopeKey !== scopeKey) {
    setPage({ scopeKey, limit: PROJECT_PAGE_SIZE });
  }
  const limit = page.scopeKey === scopeKey ? page.limit : PROJECT_PAGE_SIZE;
  const visible = enabled
    ? projects.filter(
        (project, index) =>
          index < limit || retainedIds.includes(getId(project)),
      )
    : projects;
  return {
    projects: visible,
    remainingCount: projects.length - visible.length,
    expanded:
      enabled &&
      limit > PROJECT_PAGE_SIZE &&
      projects.length > PROJECT_PAGE_SIZE,
    showMore: (): void => {
      let nextLimit = limit;
      let added = 0;
      while (nextLimit < projects.length && added < PROJECT_PAGE_SIZE) {
        // Retained rows are already visible and do not consume this batch.
        if (!retainedIds.includes(getId(projects[nextLimit]))) added++;
        nextLimit++;
      }
      setPage({ scopeKey, limit: nextLimit });
    },
    showLess: () => setPage({ scopeKey, limit: PROJECT_PAGE_SIZE }),
  };
}
