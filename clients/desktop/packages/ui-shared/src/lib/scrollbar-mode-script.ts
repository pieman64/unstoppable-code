/**
 * The scrollbar-mode probe shared by {@link useScrollbarBehavior} and the web
 * root layout's blocking script. No `'use client'`: the web server layout
 * calls {@link buildScrollbarModeScript} to inline the same detection before
 * the first paint.
 */

/**
 * Marks the throwaway element used to measure native scrollbars. The global
 * `::-webkit-scrollbar` rule in canopy-tokens.css explicitly skips elements
 * carrying this attribute — any `::-webkit-scrollbar` rule matching an
 * element makes Chromium give it a CUSTOM (space-taking) scrollbar, which
 * would make the probe report "always" on every machine.
 */
export const SCROLLBAR_PROBE_ATTRIBUTE = 'data-native-scrollbar-probe';

/** Off-screen, invisible, and forced to reserve a classic scrollbar's width. */
export const SCROLLBAR_PROBE_STYLE =
  'position:absolute;top:-9999px;left:-9999px;width:100px;height:100px;overflow:scroll;visibility:hidden';

/**
 * A blocking inline script that publishes `data-scrollbars` (and the native
 * width) on the document root the way `useScrollbarBehavior` does after
 * hydration, so scrollbar geometry does not change once the app hydrates. An
 * explicit `data-scrollbar-behavior` preference wins, as it does in the hook.
 * It must run inside `<body>`: the probe is appended there.
 */
export function buildScrollbarModeScript(): string {
  return `try{var r=document.documentElement,b=r.dataset.scrollbarBehavior;if(b==='always'||b==='scroll'||b==='hover'||b==='never'){r.dataset.scrollbars=b==='always'?'always':'overlay'}else if(document.body){var p=document.createElement('div');p.setAttribute(${JSON.stringify(
    SCROLLBAR_PROBE_ATTRIBUTE,
  )},'');p.style.cssText=${JSON.stringify(
    SCROLLBAR_PROBE_STYLE,
  )};document.body.appendChild(p);var w=p.offsetWidth-p.clientWidth;p.remove();r.dataset.scrollbars=w>0?'always':'overlay';if(w>0)r.style.setProperty('--canopy-native-scrollbar-width',w+'px')}}catch(e){}`;
}
