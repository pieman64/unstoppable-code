import type { MergeQueueAgentHandling } from '@canopy/desktop-shared/types/github';
import { describeMergeButton, resolvePrMergeRoute } from '../mergeButtonRoute';

const QUEUE = { mergeQueue: { required: true, inQueue: false } } as const;

describe('resolvePrMergeRoute', () => {
  it.each<[MergeQueueAgentHandling, boolean, 'chat' | 'queue']>([
    ['always', false, 'chat'],
    ['always', true, 'chat'],
    ['when_hook_absent', false, 'chat'],
    ['when_hook_absent', true, 'queue'],
    ['never', false, 'queue'],
    ['never', true, 'queue'],
  ])(
    'routes a merge queue PR with %s (hook active: %s) to %s',
    (handling, queueRemovedHookActive, route) => {
      expect(
        resolvePrMergeRoute({
          status: QUEUE,
          handling,
          queueRemovedHookActive,
        }),
      ).toBe(route);
    },
  );

  it.each([{}, { mergeQueue: { required: false, inQueue: false } }])(
    'merges directly when the merge queue is not required or unknown',
    (status) => {
      expect(
        resolvePrMergeRoute({
          status,
          handling: 'always',
          queueRemovedHookActive: false,
        }),
      ).toBe('direct');
    },
  );
});

describe('describeMergeButton', () => {
  it.each([
    [['direct'], 'direct', 'Merge the pull request'],
    [
      ['chat'],
      'chat',
      'Start a chat that adds this pull request to the merge queue and watches it until it merges',
    ],
    [['queue'], 'queue', 'Add this pull request to the merge queue'],
    [
      ['direct', 'chat'],
      'chat',
      'Merge the pull requests. A chat handles any that use a merge queue',
    ],
    [
      ['direct', 'queue'],
      'queue',
      'Merge the pull requests. Any that use a merge queue are added to it',
    ],
    [
      ['queue', 'chat'],
      'chat',
      'Merge the pull requests. Those on a merge queue are added to it, and a chat oversees the ones with no merge queue hook',
    ],
    [['direct', 'direct'], 'direct', 'Merge the pull request'],
  ] as const)('describes routes %j', (routes, via, help) => {
    expect(describeMergeButton({ routes, warning: false })).toEqual({
      via,
      help,
    });
  });

  it('keeps the route glyph but replaces the help with the comments warning', () => {
    expect(describeMergeButton({ routes: ['queue'], warning: true })).toEqual({
      via: 'queue',
      help: 'This PR has unresolved comments or an unknown review thread state',
    });
  });
});
