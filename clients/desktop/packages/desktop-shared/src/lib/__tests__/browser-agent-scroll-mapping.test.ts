import type { BrowserAgentToolArguments } from '@canopy/protocol/delegation/browser-agent';
import { mapBrowserAgentScroll } from '../browser-agent-scroll-mapping';

it.each([
  { amount: 'half_page', pages: 0.5 },
  { amount: 'page', pages: 1 },
  { amount: 'to_edge', pages: 10 },
] as const)(
  'maps specialist $amount without wiring a repeat controller',
  ({ amount, pages }) => {
    for (const direction of ['up', 'down', 'left', 'right'] as const) {
      const args: BrowserAgentToolArguments<'scroll'> = {
        to: { kind: 'page', amount, direction },
      };
      expect(
        mapBrowserAgentScroll(args, () => {
          throw new Error('No element');
        }),
      ).toEqual({
        command: { kind: 'scroll', direction, pages },
        ...(amount === 'to_edge'
          ? {
              stopAt:
                direction === 'up' || direction === 'left'
                  ? 'atStart'
                  : 'atEnd',
            }
          : {}),
      });
    }
  },
);
it('maps omitted amount, container, element and text; resolves specialist observations through the supplied boundary', () => {
  const target = { observationId: 'o', ref: 'r' };
  const resolve = jest.fn(() => ({ locator: '#list', frame: 'f' }));
  expect(
    mapBrowserAgentScroll(
      { to: { kind: 'container', target, direction: 'down' } },
      resolve,
    ),
  ).toEqual({
    command: {
      kind: 'scroll',
      direction: 'down',
      pages: 1,
      locator: '#list',
      frame: 'f',
    },
  });
  expect(resolve).toHaveBeenCalledWith(target);
  expect(
    mapBrowserAgentScroll({ to: { kind: 'element', target } }, resolve),
  ).toEqual({
    command: { kind: 'scroll', intoView: true, locator: '#list', frame: 'f' },
  });
  expect(
    mapBrowserAgentScroll({ to: { kind: 'text', text: 'Ready' } }, resolve),
  ).toEqual({ command: { kind: 'scroll', toText: 'Ready' } });
});
