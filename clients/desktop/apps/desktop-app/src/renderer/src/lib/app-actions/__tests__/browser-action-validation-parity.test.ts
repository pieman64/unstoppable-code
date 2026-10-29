/** Keeps the MCP, Advisor, and renderer browser action validators in sync. */
/** @jest-environment jsdom */

// The dispatcher transitively needs TextEncoder for its protocol validators.
class TestTextEncoder {
  encode(value: string): Uint8Array {
    return Uint8Array.from(Array.from(value, (char) => char.charCodeAt(0)));
  }
}
Object.assign(globalThis, { TextEncoder: TestTextEncoder });

import {
  browserActionDecisionTable,
  pointerViewportCorpus,
} from '@canopy/agent-actions/families/browser/__tests__/browser-action-corpus';
import {
  browserActionSchema,
  createDispatchActionInputSchema,
  findBrowserUiOnlyField,
} from '@canopy/agent-actions';
import { appAdvisorActionSchema } from '../../../../../main/app-advisor/definitions';
import { __isValidAppAdvisorActionForTests } from '../dispatcher';

// The MCP route: DispatchAction input for the shared browser family.
const mcpDispatchSchema = createDispatchActionInputSchema(browserActionSchema, {
  findUiOnlyField: findBrowserUiOnlyField,
});

const FORM_BROWSER_ACTION_TYPES: ReadonlySet<string> = new Set([
  'browser.set_checked',
  'browser.select_option',
  'browser.type',
]);

describe('browser action validator parity', () => {
  it('matches the shared post-refactor decisions for every browser action', () => {
    const actual = browserActionDecisionTable.map(({ id, action }) => ({
      id,
      mcp: mcpDispatchSchema.safeParse({ action }).success,
      advisor: appAdvisorActionSchema.safeParse(action).success,
      renderer: action.type.startsWith('browser.profile.')
        ? 'not-handled'
        : __isValidAppAdvisorActionForTests(action),
    }));
    const expected = browserActionDecisionTable.map(({ id, after }) => ({
      id,
      ...after,
    }));

    expect(actual).toEqual(expected);
  });

  it.each(
    browserActionDecisionTable.filter(({ action }) =>
      FORM_BROWSER_ACTION_TYPES.has(action.type),
    ),
  )(
    'matches the shared form action decision for $id on every route',
    ({ action, after }) => {
      expect(mcpDispatchSchema.safeParse({ action }).success).toBe(after.mcp);
      expect(appAdvisorActionSchema.safeParse(action).success).toBe(
        after.advisor,
      );
      expect(__isValidAppAdvisorActionForTests(action)).toBe(after.renderer);
    },
  );
});

describe('frame validation parity', () => {
  it.each(['click', 'fill', 'press', 'focus', 'inspect'])(
    'validates frame targets on browser.%s',
    (kind) => {
      for (const target of [
        { locator: '#ready' },
        { ref: 'r-frame-1' },
        { x: 1, y: 2 },
        {},
      ]) {
        const action = {
          type: `browser.${kind}`,
          expectedRuntimeGeneration: 1,
          frame: 'f-checkout-1',
          text: '',
          key: 'Enter',
          ...target,
        };
        const expected = 'locator' in target;
        expect(mcpDispatchSchema.safeParse({ action }).success).toBe(expected);
        expect(appAdvisorActionSchema.safeParse(action).success).toBe(expected);
        expect(__isValidAppAdvisorActionForTests(action)).toBe(expected);
      }
    },
  );
  it.each([
    { locator: '#ready' },
    { text: 'Ready' },
    { url: '/ready' },
    { loadState: 'load' },
    {},
  ])('validates wait frame %j', (condition) => {
    const action = {
      type: 'browser.wait_for',
      expectedRuntimeGeneration: 1,
      frame: 'f-checkout-1',
      ...condition,
    };
    expect(__isValidAppAdvisorActionForTests(action)).toBe(
      'locator' in condition || 'text' in condition,
    );
  });
});

it.each(pointerViewportCorpus)(
  'validates pointer/viewport $id on every route',
  ({ action, accepted }) => {
    expect(mcpDispatchSchema.safeParse({ action }).success).toBe(accepted);
    expect(appAdvisorActionSchema.safeParse(action).success).toBe(accepted);
    expect(__isValidAppAdvisorActionForTests(action)).toBe(accepted);
  },
);
