import { type JSX, type ReactNode, useEffect } from 'react';
import { TabBar } from '@canopy/ui-shared/components';
import type { NavigationPage } from '@/stores/navigationStore';
import { enabledDevPages, rememberDevPage } from './dev-pages';

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
      <div className="shrink-0 px-8 pt-6">
        <TabBar
          items={enabledDevPages().map((def) => ({
            id: def.page,
            label: def.label,
            dataTestId: `dev-pages-tab-${def.page}`,
          }))}
          value={page}
          onChange={(next): void => {
            if (next !== page) onNavigate(next);
          }}
          label="Dev pages"
          scrollable
        />
      </div>
      <div className="min-h-0 flex-1">{children}</div>
    </div>
  );
}
