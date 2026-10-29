import type { NavigationPage } from '@canopy/desktop-shared/types';
import { isActivityStatesPageEnabled } from '@/components/sidebar/activity-states-page-flag';
import { isChangeReviewPageEnabled } from '@/components/sidebar/change-review-page-flag';
import { isHeaderStatesPageEnabled } from '@/components/sidebar/header-states-page-flag';
import { isMessageBubbleStatesPageEnabled } from '@/components/sidebar/message-bubble-states-page-flag';
import { isNoticeStatesPageEnabled } from '@/components/sidebar/notice-states-page-flag';
import { isWorktreeStatesPageEnabled } from '@/components/sidebar/worktree-states-page-flag';

export interface DevPageDef {
  readonly page: NavigationPage;
  readonly label: string;
  readonly enabled: () => boolean;
}

/**
 * The development-only reference pages, in tab order. Each keeps its own
 * page id and gate (see the `*-page-flag.ts` files), so deep links and
 * `navigation.go_to_page` still reach them; the sidebar shows one "Dev pages"
 * entry and this shell adds the tabs that switch between them.
 */
const DEV_PAGES: readonly DevPageDef[] = [
  {
    page: 'notice-states',
    label: 'Notice states',
    enabled: isNoticeStatesPageEnabled,
  },
  {
    page: 'header-states',
    label: 'Header states',
    enabled: isHeaderStatesPageEnabled,
  },
  {
    page: 'worktree-states',
    label: 'Worktree states',
    enabled: isWorktreeStatesPageEnabled,
  },
  {
    page: 'activity-states',
    label: 'Activity states',
    enabled: isActivityStatesPageEnabled,
  },
  {
    page: 'message-bubble-states',
    label: 'Message bubbles',
    enabled: isMessageBubbleStatesPageEnabled,
  },
  {
    page: 'change-review',
    label: 'Change review',
    enabled: isChangeReviewPageEnabled,
  },
];

let lastDevPage: NavigationPage | null = null;

export function isDevPage(page: NavigationPage): boolean {
  return DEV_PAGES.some((def) => def.page === page);
}

/**
 * Gate metadata for one dev page, or `undefined` for any other page. The
 * navigation availability policy reads the gates through this registry so it
 * never restates them.
 */
export function getDevPageDef(page: NavigationPage): DevPageDef | undefined {
  return DEV_PAGES.find((def) => def.page === page);
}

/** Dev pages this build shows, in tab order. */
export function enabledDevPages(): readonly DevPageDef[] {
  return DEV_PAGES.filter((def) => def.enabled());
}

/**
 * Where the sidebar's "Dev pages" entry goes: the dev page last open in this
 * session, else the first one this build shows. `null` when none is enabled.
 */
export function devPagesEntryTarget(): NavigationPage | null {
  const enabled = enabledDevPages();
  return (
    enabled.find((def) => def.page === lastDevPage)?.page ??
    enabled[0]?.page ??
    null
  );
}

/** Records the dev page on screen so the More entry can return to it. */
export function rememberDevPage(page: NavigationPage): void {
  lastDevPage = page;
}
