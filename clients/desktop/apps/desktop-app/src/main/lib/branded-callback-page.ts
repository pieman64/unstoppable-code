import type { ServerResponse } from 'node:http';
import { BRAND } from '@canopy/brand/current';

/**
 * Shared renderer for the local loopback HTML pages the desktop app serves at
 * the end of an OAuth handshake (cloud sign-in and MCP server authorization).
 *
 * These pages render in the user's real browser, not in Electron, so they
 * cannot use the renderer's Tailwind/theme pipeline. Instead they inline the
 * fully-resolved semantic tokens that `BRAND.theme.default.light/dark` already
 * ships into the main process, which is what lets the page match the hosted
 * consent screen without a theme engine or a network round trip.
 */

/**
 * `neutral` is for pages that deliberately do not restate an outcome — a
 * duplicate callback, or one arriving after the login already settled. Styling
 * those as `success` would show a green check for a sign-in that may have
 * failed.
 */
export type CallbackPageTone = 'success' | 'error' | 'neutral';

/**
 * One run of body text. `emphasis: true` renders the segment inside `<strong>`.
 * Callers assemble the sentence from ordered segments so the emphasized span is
 * positional rather than matched by value — a substring search would bold the
 * wrong run for short values (an account name of `in` inside "signed in as in").
 */
export interface CallbackMessageSegment {
  text: string;
  emphasis?: boolean;
}

export interface BrandedCallbackPageOptions {
  tone: CallbackPageTone;
  /** h1, e.g. 'Desktop connected'. */
  title: string;
  /**
   * Body sentence. Either plain text, or ordered segments when part of the
   * sentence needs emphasis. Every segment is escaped independently, so a
   * value such as `39` can never be confused with the `&#39;` entity emitted
   * for an apostrophe elsewhere in the sentence.
   */
  message: string | readonly CallbackMessageSegment[];
  /** Optional secondary explanation line (error reason). */
  detail?: string;
  /** Closing line under the divider. Defaults to 'You can close this tab.' */
  hint?: string;
  /** Strip `?code=…&state=…` from the address bar via history.replaceState. */
  scrubQuery?: boolean;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const DEFAULT_HINT = 'You can close this tab.';

const GLYPHS = '{}[]()<>/$#%*+=;:.|~^';

/**
 * Same deterministic LCG as `apps/web/src/components/glyph-field.tsx` so the
 * backdrop is byte-identical to the consent screen the user just left.
 */
function seededRandom(seed: number): () => number {
  let state = seed % 2147483647;
  if (state <= 0) state += 2147483646;
  return (): number => {
    state = (state * 16807) % 2147483647;
    return (state - 1) / 2147483646;
  };
}

/**
 * Renders the glyph field markup. This is ~50KB of spans, which would be
 * unacceptable for a hosted page but is fine for a one-shot response served
 * from loopback that the user closes seconds later.
 */
function renderGlyphBackdrop(): string {
  const rand = seededRandom(1337);
  const rows: string[] = [];
  for (let row = 0; row < 20; row++) {
    const chunks: string[] = [];
    for (let chunk = 0; chunk < 36; chunk++) {
      let text = '';
      for (let i = 0; i < 12; i++) {
        text +=
          rand() < 0.78 ? ' ' : GLYPHS[Math.floor(rand() * GLYPHS.length)];
      }
      const delay = (rand() * 8).toFixed(2);
      const duration = (4 + rand() * 7).toFixed(2);
      chunks.push(
        `<span class="glyph-twinkle" style="animation-delay:${delay}s;animation-duration:${duration}s">${escapeHtml(
          text,
        )}</span>`,
      );
    }
    rows.push(`<div class="glyph-row">${chunks.join('')}</div>`);
  }
  return `<div class="backdrop" aria-hidden="true"><div class="glyphs">${rows.join(
    '',
  )}</div></div>`;
}

/**
 * The generator is seeded from a constant, so the markup is byte-identical on
 * every call and can be cached. This is populated lazily rather than at module
 * load: both importers sit on the Electron main startup graph, and the vast
 * majority of launches never serve a callback page, so building it eagerly
 * would add ~8.6k LCG iterations and a permanently resident ~55KB string to
 * every start for nothing.
 */
let glyphBackdrop: string | null = null;

function getGlyphBackdrop(): string {
  glyphBackdrop ??= renderGlyphBackdrop();
  return glyphBackdrop;
}

function renderThemeBlock(
  selector: string,
  tokens: (typeof BRAND)['theme']['default']['light'],
): string {
  return [
    `${selector}{`,
    `--bg-base:${tokens.bgBase};`,
    `--bg-card:${tokens.bgCard};`,
    `--bg-accent:${tokens.bgAccent};`,
    `--bg-accent-subtle:${tokens.bgAccentSubtle};`,
    `--bg-destructive:${tokens.bgDestructive};`,
    `--bg-destructive-subtle:${tokens.bgDestructiveSubtle};`,
    `--fg-primary:${tokens.fgPrimary};`,
    `--fg-secondary:${tokens.fgSecondary};`,
    `--border:${tokens.border};`,
    `--shadow-md:${tokens.shadowMd};`,
    `--radius:${tokens.radius};`,
    `}`,
  ].join('');
}

const SUCCESS_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';

const ERROR_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m10.29 3.86-8.18 14a2 2 0 0 0 1.71 3h16.36a2 2 0 0 0 1.71-3l-8.18-14a2 2 0 0 0-3.44 0Z"/><path d="M12 9v4"/><path d="M12 17h.01"/></svg>';

const NEUTRAL_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>';

/**
 * Escapes each segment independently and wraps emphasized runs in `<strong>`.
 * Because emphasis is positional, no substring matching happens here and the
 * escaped output can never be re-scanned for the emphasized value.
 */
function renderMessage(
  message: string | readonly CallbackMessageSegment[],
): string {
  if (typeof message === 'string') {
    return escapeHtml(message);
  }
  return message
    .map((segment) =>
      segment.emphasis
        ? `<strong>${escapeHtml(segment.text)}</strong>`
        : escapeHtml(segment.text),
    )
    .join('');
}

export function renderBrandedCallbackPage(
  options: BrandedCallbackPageOptions,
): string {
  const theme = BRAND.theme.default;
  const isError = options.tone === 'error';
  const isNeutral = options.tone === 'neutral';
  const toneVar = isError ? 'destructive' : 'accent';
  // Neutral gets a muted treatment rather than a tone color, so it cannot be
  // read as either a success or a failure.
  const statusStyle = isNeutral
    ? `background:var(--border);color:var(--fg-secondary)`
    : `background:var(--bg-${toneVar}-subtle);color:var(--bg-${toneVar})`;
  const title = escapeHtml(options.title);
  const hint = escapeHtml(options.hint ?? DEFAULT_HINT);

  const styles = [
    renderThemeBlock(':root', theme.light),
    `@media (prefers-color-scheme: dark){${renderThemeBlock(
      ':root',
      theme.dark,
    )}}`,
    `*,*::before,*::after{box-sizing:border-box}`,
    `html,body{margin:0;padding:0}`,
    `body{min-height:100vh;display:grid;place-items:center;padding:24px;`,
    `background:var(--bg-base);color:var(--fg-primary);`,
    `font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;`,
    `font-size:14px;line-height:1.5;-webkit-font-smoothing:antialiased}`,
    `.backdrop{position:fixed;inset:0;pointer-events:none;user-select:none;overflow:hidden}`,
    `.glyphs{position:absolute;inset:0;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;`,
    `font-size:12px;line-height:24px;color:var(--fg-primary);opacity:.09;`,
    `-webkit-mask-image:linear-gradient(to bottom,black 0%,transparent 70%);`,
    `mask-image:linear-gradient(to bottom,black 0%,transparent 70%)}`,
    `.glyph-row{white-space:pre}`,
    `.glyph-twinkle{animation-name:glyph-twinkle;animation-timing-function:ease-in-out;animation-iteration-count:infinite}`,
    `@keyframes glyph-twinkle{0%,100%{opacity:.25}50%{opacity:1}}`,
    `@media (prefers-reduced-motion: reduce){.glyph-twinkle{animation:none}}`,
    `.card{position:relative;width:100%;max-width:28rem;background:var(--bg-card);`,
    `border:1px solid var(--border);border-radius:var(--radius);box-shadow:var(--shadow-md);padding:2rem}`,
    `.lockup{display:flex;align-items:center;gap:.5rem;margin-bottom:1.75rem}`,
    `.logo{display:flex;color:var(--bg-accent)}`,
    `.logo svg{width:20px;height:20px;display:block}`,
    `.brand-name{font-size:15px;font-weight:600;letter-spacing:-.01em}`,
    `.status{width:40px;height:40px;border-radius:9999px;display:grid;place-items:center;margin-bottom:1rem;`,
    `${statusStyle}}`,
    `.status svg{width:20px;height:20px;display:block}`,
    `h1{margin:0 0 .5rem;font-size:20px;font-weight:600;letter-spacing:-.01em}`,
    `.message{margin:0;color:var(--fg-secondary)}`,
    `.message strong{font-weight:500;color:var(--fg-primary)}`,
    `.detail{margin:.5rem 0 0;color:var(--fg-secondary)}`,
    `.divider{margin:1.5rem 0 1rem;border-top:1px solid var(--border)}`,
    `.hint{margin:0;font-size:13px;color:var(--fg-secondary)}`,
  ].join('');

  const detail = options.detail
    ? `<p class="detail">${escapeHtml(options.detail)}</p>`
    : '';

  // Brand-owned inline SVG; not user input, so it is intentionally not escaped.
  const logo = BRAND.assets.logoSvg;

  const script = options.scrubQuery
    ? `<script>try{history.replaceState({}, '', location.pathname)}catch(e){}</script>`
    : '';

  return [
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<meta name="color-scheme" content="light dark">',
    `<title>${title}</title>`,
    `<style>${styles}</style>`,
    '</head>',
    '<body>',
    getGlyphBackdrop(),
    '<main class="card">',
    `<div class="lockup"><span class="logo">${logo}</span><span class="brand-name">${escapeHtml(
      BRAND.displayName,
    )}</span></div>`,
    `<div class="status">${
      isNeutral ? NEUTRAL_ICON : isError ? ERROR_ICON : SUCCESS_ICON
    }</div>`,
    `<h1>${title}</h1>`,
    `<p class="message">${renderMessage(options.message)}</p>`,
    detail,
    '<div class="divider"></div>',
    `<p class="hint">${hint}</p>`,
    '</main>',
    script,
    '</body>',
    '</html>',
  ].join('');
}

export function writeBrandedCallbackPage(
  response: ServerResponse,
  statusCode: number,
  options: BrandedCallbackPageOptions,
): void {
  // The URL of this page carries an authorization code, so it must not be
  // cached and must not leak through `Referer`.
  //
  // The page is fully self-contained: one inline <style>, one optional inline
  // <script> that scrubs the query string, and no network-loaded subresources.
  // `default-src 'none'` therefore blocks every fetch, form post, and frame,
  // which is the meaningful protection for a page holding an auth code. The
  // 'unsafe-inline' allowances are scoped to style/script only.
  response.writeHead(statusCode, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy':
      "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  });
  response.end(renderBrandedCallbackPage(options));
}
