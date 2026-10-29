import { useSidebarStore } from '@/stores/sidebarStore';

/**
 * Left padding for a page top bar's leading breadcrumb.
 *
 * In the early-access inset layout the panel cards start at the top bar's
 * left edge and their first tab sits 4px in, so the breadcrumb pill takes the
 * same 4px and lines up with that tab. With the sidebar hidden the pill
 * follows the titlebar corner instead, which no tab lines up with, so it keeps
 * the 9px it has everywhere else.
 */
export function useTopBarLeadingInsetClassName(): 'pl-1' | 'pl-2.25' {
  const sidebarHidden = useSidebarStore((s) => s.hidden);
  return !sidebarHidden ? 'pl-1' : 'pl-2.25';
}
