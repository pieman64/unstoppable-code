import {
  parseLocator,
  UNSUPPORTED_PLAYWRIGHT_LOCATOR_MESSAGE,
  type ParsedLocator,
} from '@canopy/desktop-shared/browser/locator-grammar';
import type { NodeIdentity } from './frame-registry';
import {
  evaluateLocator,
  framesForFrameSelector,
  isInvalidSelectorError,
  type LocatorEvaluationDeps,
} from './locators';
import type { BrowserPageModel, PageModelFrame } from './model-types';

/**
 * Agent locator requests over the model, with the top-level semantics of
 * the deleted preload's `resolveLocatorMatches`: `target` is its action
 * resolution (`allMatches: false`), `wait` its `wait-for-probe`
 * (`allMatches: true`, `rejectInvalidCss: true`). Evaluation itself is `evaluateLocator`'s, so
 * frames, shadow roots and frame locators work in both.
 */
export type LocatorMode = 'target' | 'wait';

export class LocatorRequestError extends Error {
  public constructor(
    public readonly kind: 'invalid_css' | 'unsupported',
    message: string,
  ) {
    super(message);
    this.name = 'LocatorRequestError';
  }
}

const FRAME_REF = /^f-[0-9a-f-]{36}-\d+$/;
const EMPTY_PLAYWRIGHT_LOCATOR = /^page\.locator\(\s*(['"])\s*\1\s*\)$/;

function invalidCss(locator: string): LocatorRequestError {
  return new LocatorRequestError(
    'invalid_css',
    /:(?:has-)?text(?:-is|-matches)?\(/.test(locator)
      ? `Invalid CSS locator ${JSON.stringify(locator)}: :has-text(), :text(), :text-is() and :text-matches() are Playwright-only. Use page.getByText('text', { exact: true }) or page.getByRole(role, { name: 'text' }).`
      : locator.includes('>>')
        ? `Invalid CSS locator ${JSON.stringify(locator)}: Playwright selector chains (>>) are not supported. Use one CSS selector (for example with :nth-of-type), a supported locator form, or a ref from browser.input_snapshot.`
        : `Invalid CSS locator ${JSON.stringify(locator)}: the selector could not be parsed. Use a CSS selector, a supported locator form, or a ref from browser.input_snapshot.`,
  );
}

/**
 * The frames a `frame` field selects: a `frameRef` of a frame in the model
 * whose document is still current, or a CSS selector for iframe elements
 * (as `page.frameLocator(css)`). Undefined when it selects none: unknown,
 * stale, omitted from the model, or an unparsable selector.
 */
export async function resolveFrameScope(
  model: BrowserPageModel,
  deps: LocatorEvaluationDeps,
  frame: string,
  options: { strict?: boolean } = {},
): Promise<PageModelFrame[] | undefined> {
  const trimmed = frame.trim();
  if (FRAME_REF.test(trimmed)) {
    const found = model.frames.find(
      (candidate) => candidate.frameRef === trimmed,
    );
    const current = found ? model.registry.getFrame(found.frameId) : undefined;
    return found &&
      current?.loaderId === found.loaderId &&
      current.sessionId === found.sessionId
      ? [found]
      : undefined;
  }
  if (!trimmed) return undefined;
  try {
    const frames = await framesForFrameSelector(
      model,
      deps,
      trimmed,
      model.frames,
      options.strict === true,
    );
    return frames.length > 0 ? frames : undefined;
  } catch (error) {
    if (isInvalidSelectorError(error) && options.strict !== true)
      return undefined;
    throw error;
  }
}

/** The locator a chain of `frameLocator(...)` calls ends in. */
function innermost(parsed: ParsedLocator): ParsedLocator {
  let current = parsed;
  while (current.kind === 'frame') current = current.inner;
  return current;
}

/**
 * The preload's single-match rule for alt text and labels, kept within one
 * frame: the first match of each frame, so matches in several frames stay
 * several and the caller reports them as ambiguous.
 */
function firstPerFrame(matches: NodeIdentity[]): NodeIdentity[] {
  const seen = new Set<string>();
  const firsts: NodeIdentity[] = [];
  for (const match of matches) {
    const frame = `${match.sessionId}\u0000${match.frameId}`;
    if (seen.has(frame)) continue;
    seen.add(frame);
    firsts.push(match);
  }
  return firsts;
}

/**
 * Matches a locator string in `frames`, in model order, for existence:
 * CSS also matches elements under a secret select. In `target` mode,
 * alt-text and label locators give the first match of each frame, as the
 * preload's single-match path does within its one document; the caller
 * decides ambiguity. Every CSS selector, nested ones included, is parsed
 * strictly: an unparsable one throws `LocatorRequestError` in `wait` mode
 * and, in `target` mode, falls back to a test id it names, is unsupported
 * for `page.` forms and when nested in a frame locator, and is otherwise
 * invalid CSS: a silent miss read as "not found" sends agents to re-snapshot.
 */
export async function matchLocator(
  model: BrowserPageModel,
  deps: LocatorEvaluationDeps,
  locator: string,
  frames: PageModelFrame[],
  mode: LocatorMode,
): Promise<NodeIdentity[]> {
  const trimmed = locator.trim();
  if (!trimmed) return [];
  if (mode === 'wait' && EMPTY_PLAYWRIGHT_LOCATOR.test(trimmed)) return [];
  const parsed = parseLocator(trimmed);
  if (parsed.kind === 'invalid') {
    throw new LocatorRequestError('unsupported', parsed.message);
  }
  if (parsed.kind === 'css' && parsed.explicit && !parsed.selector.trim()) {
    return [];
  }
  let matches: NodeIdentity[];
  try {
    matches = await evaluateLocator(
      model,
      deps,
      parsed,
      { frames },
      { strictCss: true, existence: true },
    );
  } catch (error) {
    if (!isInvalidSelectorError(error)) throw error;
    if (mode === 'wait') throw invalidCss(trimmed);
    if (parsed.kind !== 'css') {
      throw new LocatorRequestError(
        'unsupported',
        `Invalid CSS locator ${JSON.stringify(trimmed)}: a selector could not be parsed.`,
      );
    }
    // As the preload, an unparsable selector falls back to its test id.
    if (parsed.testIdFallback !== undefined) {
      return evaluateLocator(
        model,
        deps,
        { kind: 'testId', value: parsed.testIdFallback },
        { frames },
      );
    }
    if (trimmed.startsWith('page.')) {
      throw new LocatorRequestError(
        'unsupported',
        UNSUPPORTED_PLAYWRIGHT_LOCATOR_MESSAGE,
      );
    }
    throw invalidCss(trimmed);
  }
  const kind = innermost(parsed).kind;
  if (mode === 'target' && (kind === 'alt' || kind === 'label')) {
    return firstPerFrame(matches);
  }
  return matches;
}
