import { type JSX, type ReactNode, useEffect } from 'react';
import type { NavigationPage } from '@/stores/navigationStore';
import { enabledDevPages, rememberDevPage } from './dev-pages';

function tabClassName(active: boolean): string {
  return active
    ? 'rounded-full bg-secondary px-3 py-1 text-s font-medium fg-primary'
    : 'rounded-full px-3 py-1 text-s fg-secondary hover:fg-primary';
}

interface DevPagesShellProps {
  readonly page: NavigationPage;
  readonly onNavigate: (page: NavigationPage) => void;
  readonly children: ReactNode;
}

/** One tabbed surface over every dev reference page. */
export function DevPagesShell({
  page,
  onNavigate,
  children,
}: DevPagesShellProps): JSX.Element {
  useEffect(() => {
    rememberDevPage(page);
  }, [page]);
  return (
    <div className="flex h-full flex-col bg-base" data-testid="dev-pages">
      <div
        role="tablist"
        aria-label="Dev pages"
        className="flex shrink-0 flex-wrap gap-1 px-8 pt-6"
      >
        {enabledDevPages().map((def) => (
          <button
            key={def.page}
            type="button"
            role="tab"
            aria-selected={def.page === page}
            data-testid={`dev-pages-tab-${def.page}`}
            className={tabClassName(def.page === page)}
            onClick={(): void => {
              if (def.page !== page) onNavigate(def.page);
            }}
          >
            {def.label}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}
