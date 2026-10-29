/**
 * The small set of DOM queries, events and matchers the External agents page
 * tests use, written against the plain DOM so the package needs no Testing
 * Library dependency.
 */
import { act } from 'react';

type TextMatch = string | RegExp;

function normalize(text: string | null): string {
  return (text ?? '').replace(/\s+/g, ' ').trim();
}

function ownText(element: Element): string {
  return normalize(
    Array.from(element.childNodes)
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.textContent ?? '')
      .join(''),
  );
}

function matches(text: string, match: TextMatch): boolean {
  return typeof match === 'string' ? text === match : match.test(text);
}

function accessibleName(element: Element): string {
  const label = element.getAttribute('aria-label');
  if (label !== null) return normalize(label);
  const labelledBy = element.getAttribute('aria-labelledby');
  if (labelledBy !== null) {
    return normalize(
      labelledBy
        .split(/\s+/)
        .map((id) => element.ownerDocument.getElementById(id)?.textContent)
        .join(' '),
    );
  }
  return normalize(element.textContent);
}

const ROLE_SELECTORS: Record<string, string> = {
  button: 'button, [role="button"], input[type="button"], input[type="submit"]',
  heading: 'h1, h2, h3, h4, h5, h6, [role="heading"]',
};

function headingLevel(element: Element): number | null {
  const aria = element.getAttribute('aria-level');
  if (aria !== null) return Number(aria);
  const tag = /^H([1-6])$/.exec(element.tagName);
  return tag === null ? null : Number(tag[1]);
}

type RoleOptions = { name?: TextMatch; level?: number };

function single<T extends Element>(found: T[], description: string): T {
  if (found.length === 0) throw new Error(`Unable to find ${description}`);
  if (found.length > 1) {
    throw new Error(`Found ${found.length} elements for ${description}`);
  }
  return found[0];
}

async function settle(): Promise<void> {
  await act(async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
}

async function eventually<T>(read: () => T): Promise<T> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      return read();
    } catch (error) {
      lastError = error;
      await settle();
    }
  }
  throw lastError;
}

export interface Queries {
  getByTestId(id: string): HTMLElement;
  queryByTestId(id: string): HTMLElement | null;
  findByTestId(id: string): Promise<HTMLElement>;
  findAllByTestId(id: string): Promise<HTMLElement[]>;
  getByText(match: TextMatch): HTMLElement;
  findByText(match: TextMatch): Promise<HTMLElement>;
  getByRole(role: 'button' | 'heading', options?: RoleOptions): HTMLElement;
}

export function within(root: ParentNode): Queries {
  const allByTestId = (id: string): HTMLElement[] =>
    Array.from(root.querySelectorAll<HTMLElement>('[data-testid]')).filter(
      (element) => element.getAttribute('data-testid') === id,
    );
  const allByText = (match: TextMatch): HTMLElement[] =>
    Array.from(root.querySelectorAll<HTMLElement>('*')).filter(
      (element) =>
        element.tagName !== 'SCRIPT' &&
        element.tagName !== 'STYLE' &&
        matches(ownText(element), match),
    );
  const queries: Queries = {
    getByTestId: (id) => single(allByTestId(id), `test ID "${id}"`),
    queryByTestId: (id) => allByTestId(id)[0] ?? null,
    findByTestId: (id) => eventually(() => queries.getByTestId(id)),
    findAllByTestId: (id) =>
      eventually(() => {
        const found = allByTestId(id);
        if (found.length === 0) throw new Error(`Unable to find "${id}"`);
        return found;
      }),
    getByText: (match) => single(allByText(match), `text ${String(match)}`),
    findByText: (match) => eventually(() => queries.getByText(match)),
    getByRole: (role, options = {}) =>
      single(
        Array.from(
          root.querySelectorAll<HTMLElement>(ROLE_SELECTORS[role]),
        ).filter(
          (element) =>
            (options.name === undefined ||
              matches(accessibleName(element), options.name)) &&
            (options.level === undefined ||
              headingLevel(element) === options.level),
        ),
        `role "${role}" ${String(options.name ?? '')}`,
      ),
  };
  return queries;
}

export const screen: Queries = {
  getByTestId: (id) => within(document.body).getByTestId(id),
  queryByTestId: (id) => within(document.body).queryByTestId(id),
  findByTestId: (id) => within(document.body).findByTestId(id),
  findAllByTestId: (id) => within(document.body).findAllByTestId(id),
  getByText: (match) => within(document.body).getByText(match),
  findByText: (match) => within(document.body).findByText(match),
  getByRole: (role, options) => within(document.body).getByRole(role, options),
};

/** Raw DOM events; callers wrap them in `act`. */
export const domFireEvent = {
  click(target: Element): void {
    target.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }),
    );
  },
  change(target: Element, options: { target: { value: string } }): void {
    // Set the value through the native setter so React sees the change.
    const prototype =
      target instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : target instanceof HTMLTextAreaElement
          ? HTMLTextAreaElement.prototype
          : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, 'value')?.set?.call(
      target,
      options.target.value,
    );
    target.dispatchEvent(new Event('input', { bubbles: true }));
    target.dispatchEvent(new Event('change', { bubbles: true }));
  },
};

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace jest {
    interface Matchers<R> {
      toBeInTheDocument(): R;
      toHaveTextContent(expected: TextMatch): R;
      toHaveAccessibleName(expected: TextMatch): R;
      toBeDisabled(): R;
      toHaveAttribute(name: string, value?: string): R;
    }
  }
}

function asElement(received: unknown): Element | null {
  return received instanceof Element ? received : null;
}

expect.extend({
  toBeInTheDocument(received: unknown): jest.CustomMatcherResult {
    const element = asElement(received);
    const pass = element !== null && element.ownerDocument.contains(element);
    return { pass, message: () => `expected element to be in the document` };
  },
  toHaveTextContent(
    received: unknown,
    expected: TextMatch,
  ): jest.CustomMatcherResult {
    const text = normalize(asElement(received)?.textContent ?? null);
    const pass =
      typeof expected === 'string'
        ? text.includes(expected)
        : expected.test(text);
    return {
      pass,
      message: () => `expected "${text}" to contain ${String(expected)}`,
    };
  },
  toHaveAccessibleName(
    received: unknown,
    expected: TextMatch,
  ): jest.CustomMatcherResult {
    const element = asElement(received);
    const name = element === null ? '' : accessibleName(element);
    return {
      pass: element !== null && matches(name, expected),
      message: () =>
        `expected accessible name "${name}" to be ${String(expected)}`,
    };
  },
  toBeDisabled(received: unknown): jest.CustomMatcherResult {
    const element = asElement(received);
    return {
      pass: element !== null && element.matches(':disabled'),
      message: () => `expected element to be disabled`,
    };
  },
  toHaveAttribute(
    received: unknown,
    name: string,
    value?: string,
  ): jest.CustomMatcherResult {
    const actual = asElement(received)?.getAttribute(name) ?? null;
    const pass = actual !== null && (value === undefined || actual === value);
    return {
      pass,
      message: () =>
        `expected attribute ${name}${value === undefined ? '' : `="${value}"`}, got ${String(actual)}`,
    };
  },
});
