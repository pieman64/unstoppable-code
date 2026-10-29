/**
 * The renderer's HTML pages, one per window. Each page has its own entry
 * module, so a window loads only its own app (see the renderer `input` in
 * `electron.vite.config.ts`).
 */
export const MAIN_WINDOW_RENDERER_PAGE = 'index.html';
export const APP_ADVISOR_RENDERER_PAGE = 'app-advisor.html';

/**
 * The App Advisor page keeps the query that renderer modules, IPC window
 * labels and test helpers use to recognize that window.
 */
export const APP_ADVISOR_RENDERER_SEARCH = '?surface=app-advisor';

/** The App Advisor page on the development server. */
export function appAdvisorDevServerUrl(devServerUrl: string): string {
  const url = new URL(APP_ADVISOR_RENDERER_PAGE, devServerUrl);
  url.search = APP_ADVISOR_RENDERER_SEARCH;
  return url.toString();
}
