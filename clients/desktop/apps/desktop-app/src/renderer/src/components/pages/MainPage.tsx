import type { JSX } from 'react';
import { WorktreeManager } from '../worktree/WorktreeManager';

export function MainPage(): JSX.Element {
  return (
    <div data-testid="page-main" className="h-full">
      <WorktreeManager />
    </div>
  );
}
