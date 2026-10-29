export type ParsedLocator =
  | {
      kind: 'css';
      selector: string;
      explicit: boolean;
      /**
       * A getByTestId(...) found anywhere in the original locator. Today's
       * preload falls back to it when the explicit CSS matches nothing.
       */
      testIdFallback?: string;
    }
  | { kind: 'testId'; value: string }
  | { kind: 'role'; role: string; name?: string }
  | { kind: 'label' | 'placeholder' | 'alt'; value: string }
  | { kind: 'text'; value: string; exact?: true }
  | { kind: 'frame'; frameSelector: string; inner: ParsedLocator };

export const UNSUPPORTED_PLAYWRIGHT_LOCATOR_MESSAGE =
  'Unsupported Playwright-like locator. Supported forms are page.locator(string), page.getByTestId(string), page.getByRole(role, { name: string }), page.getByLabel(string), page.getByPlaceholder(string), page.getByAltText(string), and page.getByText(string, { exact: true }). Use browser.input_snapshot for reusable refs.';

type InvalidLocator = { kind: 'invalid'; message: string };
type SemanticLocator =
  | { kind: 'role'; role: string; name?: string }
  | { kind: 'label' | 'placeholder' | 'alt'; value: string }
  | { kind: 'text'; value: string; exact?: true };

interface FrameSelectorArgument {
  selector: string;
  nextIndex: number;
}

function parsePlaywrightStringArg(
  locator: string,
  name: string,
): string | undefined {
  const match = locator.match(new RegExp(`${name}\\(\\s*['"]([^'"]+)['"]`));
  return match?.[1];
}

function parseRoleLocator(
  locator: string,
): { kind: 'role'; role: string; name?: string } | undefined {
  const role = parsePlaywrightStringArg(locator, 'getByRole');
  if (!role) return undefined;
  const name = locator.match(/name\s*:\s*['"]([^'"]+)['"]/)?.[1];
  return name === undefined
    ? { kind: 'role', role }
    : { kind: 'role', role, name };
}

/**
 * Extracts semantic helpers from the original locator text for the preload's
 * post-CSS fallback. These intentionally retain the legacy unanchored regexes.
 */
export function parseSemanticLocator(
  locator: string,
): SemanticLocator | undefined {
  const trimmed = locator.trim();

  const role = parseRoleLocator(trimmed);
  if (role !== undefined) return role;

  const alt = parsePlaywrightStringArg(trimmed, 'getByAltText');
  if (alt) return { kind: 'alt', value: alt };

  const placeholder = trimmed.match(/getByPlaceholder\(['"](.+?)['"]\)/)?.[1];
  if (placeholder !== undefined)
    return { kind: 'placeholder', value: placeholder };

  const label = trimmed.match(/getByLabel\(['"](.+?)['"]\)/)?.[1];
  if (label !== undefined) return { kind: 'label', value: label };

  const text =
    trimmed.match(/getByText\(['"](.+?)['"]\)/)?.[1] ??
    (trimmed.startsWith('text=') ? trimmed.slice(5) : undefined);
  if (text) return { kind: 'text', value: text };
  // Playwright's options form; exact rules out substring matches.
  const withOptions = trimmed.match(
    /getByText\(['"](.+?)['"]\s*,\s*\{([^}]*)\}\s*\)/,
  );
  if (withOptions?.[1])
    return /\bexact\s*:\s*true\b/.test(withOptions[2] ?? '')
      ? { kind: 'text', value: withOptions[1], exact: true }
      : { kind: 'text', value: withOptions[1] };

  return undefined;
}

/**
 * Extracts the legacy test-id form exactly as the preload resolver does.
 * Deliberately unanchored and strict about the closing parenthesis.
 */
export function parseTestIdLocator(locator: string): string | undefined {
  return locator.match(/getByTestId\(['"](.+?)['"]\)/)?.[1];
}

function invalidLocator(): InvalidLocator {
  return {
    kind: 'invalid',
    message: UNSUPPORTED_PLAYWRIGHT_LOCATOR_MESSAGE,
  };
}

function parseFrameSelectorArgument(
  locator: string,
  startIndex: number,
): FrameSelectorArgument | undefined {
  let cursor = startIndex;
  while (/\s/.test(locator[cursor] ?? '')) cursor += 1;

  const delimiter = locator[cursor];
  if (delimiter !== "'" && delimiter !== '"') return undefined;
  cursor += 1;

  let selector = '';
  while (cursor < locator.length) {
    const character = locator[cursor];
    if (character === undefined) return undefined;

    if (character === '\\') {
      const nextCharacter = locator[cursor + 1];
      if (nextCharacter === undefined) return undefined;
      if (nextCharacter === delimiter || nextCharacter === '\\') {
        selector += nextCharacter;
        cursor += 2;
        continue;
      }
    }

    if (character === delimiter) {
      return { selector, nextIndex: cursor + 1 };
    }

    selector += character;
    cursor += 1;
  }

  return undefined;
}

function parseFrameLocator(
  locator: string,
): ParsedLocator | InvalidLocator | undefined {
  const prefix = locator.startsWith('page.frameLocator(')
    ? 'page.frameLocator('
    : locator.startsWith('frameLocator(')
      ? 'frameLocator('
      : undefined;
  if (prefix === undefined) {
    if (
      locator.startsWith('page.frameLocator') ||
      /^frameLocator\s+\(/.test(locator)
    ) {
      return invalidLocator();
    }
    return undefined;
  }

  const frameArgument = parseFrameSelectorArgument(locator, prefix.length);
  if (frameArgument === undefined) return invalidLocator();

  let cursor = frameArgument.nextIndex;
  while (/\s/.test(locator[cursor] ?? '')) cursor += 1;
  if (locator[cursor] !== ')') return invalidLocator();
  cursor += 1;
  if (locator[cursor] !== '.') return invalidLocator();
  cursor += 1;

  const innerSource = locator.slice(cursor);
  if (!innerSource.trim()) return invalidLocator();

  const inner = parseLocator(innerSource);
  if (inner.kind === 'invalid') return inner;

  return {
    kind: 'frame',
    frameSelector: frameArgument.selector,
    inner,
  };
}

/**
 * The argument of the first `locator(` as a string literal (E5): closed by
 * its own delimiter, with the escapes frame selectors take, so a quoted
 * attribute value inside it is kept. Unchanged from the earlier pattern:
 * the call may appear anywhere and need not be closed. An empty or
 * unterminated literal is no argument.
 */
function parseLocatorCallArgument(locator: string): string | undefined {
  // As before: the first `locator(` whose argument starts with a quote.
  const call = /locator\(\s*(?=['"])/.exec(locator);
  if (!call) return undefined;
  const argument = parseFrameSelectorArgument(
    locator,
    call.index + call[0].length,
  );
  return argument === undefined || argument.selector === ''
    ? undefined
    : argument.selector;
}

export function parseLocator(
  locator: string,
): ParsedLocator | { kind: 'invalid'; message: string } {
  const trimmed = locator.trim();

  const frame = parseFrameLocator(trimmed);
  if (frame !== undefined) return frame;

  const playwrightLocator = parseLocatorCallArgument(trimmed);
  const testIdFallback = parseTestIdLocator(trimmed);
  const fallback = testIdFallback === undefined ? {} : { testIdFallback };
  if (playwrightLocator !== undefined) {
    return {
      kind: 'css',
      selector: playwrightLocator,
      explicit: true,
      ...fallback,
    };
  }
  if (trimmed.startsWith('css=')) {
    return {
      kind: 'css',
      selector: trimmed.slice(4),
      explicit: true,
      ...fallback,
    };
  }

  const testId = parseTestIdLocator(trimmed);
  if (testId !== undefined) return { kind: 'testId', value: testId };

  const semantic = parseSemanticLocator(trimmed);
  if (semantic !== undefined) return semantic;

  if (trimmed.startsWith('page.')) return invalidLocator();

  return { kind: 'css', selector: trimmed, explicit: false };
}
