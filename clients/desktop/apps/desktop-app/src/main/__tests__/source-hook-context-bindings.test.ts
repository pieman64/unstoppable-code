import type {
  ChatHookAction,
  HookOverrides,
} from '@canopy/desktop-shared/hooks';
import { addOrganizationSourceHookBindings } from '../lib/source-hook-context-bindings';

const organizationId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const context = `org:${organizationId}`;
const chatHook: ChatHookAction = {
  type: 'chat',
  prompt: 'Review the PR',
  model: 'gpt-6-sol',
};
const source: HookOverrides = {
  'pr:create': [
    {
      type: 'pipeline',
      source: 'bundled',
      id: 'review',
      inputs: { version: 'new' },
    },
    chatHook,
  ],
};

it('creates binding-only overlays and keeps source definitions portable', () => {
  const before = JSON.stringify(source);
  const result = addOrganizationSourceHookBindings(
    source,
    undefined,
    organizationId,
  );
  expect(result).toEqual({
    'pr:create': [
      {
        type: 'pipeline',
        source: 'bundled',
        id: 'review',
        executionContext: context,
        localExecutionContextOverlay: true,
      },
      {
        type: 'chat',
        prompt: 'Review the PR',
        executionContext: context,
        localExecutionContextOverlay: true,
      },
    ],
  });
  expect(JSON.stringify(source)).toBe(before);
  expect(
    addOrganizationSourceHookBindings(source, result, organizationId),
  ).toBe(result);
});

it.each<HookOverrides[string]>([
  null,
  [{ type: 'command', command: 'echo custom' }],
  [{ type: 'pipeline', source: 'local', id: 'custom' }],
  [
    {
      type: 'chat',
      prompt: 'Review the PR',
      localPluginSelectionOverlay: true,
      pluginSelections: { collectionIds: [], skillRefs: [], pluginRefs: [] },
    },
  ],
])('preserves disabled hooks and local action overrides: %j', (actions) => {
  const local: HookOverrides = { 'pr:create': actions };
  expect(addOrganizationSourceHookBindings(source, local, organizationId)).toBe(
    local,
  );
});

it.each(['personal', 'org:bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'])(
  'preserves the explicit %s binding',
  (executionContext) => {
    const local: HookOverrides = {
      'pr:create': [
        {
          type: 'pipeline',
          source: 'bundled',
          id: 'review',
          executionContext,
          localExecutionContextOverlay: true,
        },
        {
          type: 'chat',
          prompt: 'Review the PR',
          executionContext,
          localExecutionContextOverlay: true,
        },
      ],
    };
    expect(
      addOrganizationSourceHookBindings(source, local, organizationId),
    ).toBe(local);
  },
);

it('retains plugin-selection overlays and bindings for removed source actions', () => {
  const local: HookOverrides = {
    'pr:create': [
      {
        type: 'chat',
        prompt: 'Review the PR',
        localPluginSelectionOverlay: true,
        localPluginSelectionOverlayKey: 'chat:Review the PR',
        pluginSelections: { collectionIds: [], skillRefs: [], pluginRefs: [] },
      },
      {
        type: 'pipeline',
        source: 'bundled',
        id: 'removed',
        executionContext: 'personal',
        localExecutionContextOverlay: true,
      },
    ],
  };
  const result = addOrganizationSourceHookBindings(
    source,
    local,
    organizationId,
  );
  expect(result?.['pr:create']).toContainEqual(
    expect.objectContaining({
      type: 'chat',
      pluginSelections: { collectionIds: [], skillRefs: [], pluginRefs: [] },
      executionContext: context,
    }),
  );
  expect(result?.['pr:create']).toContainEqual(local['pr:create']?.[1]);
});

it('does not bind ambiguous source or local-overlay identities', () => {
  const ambiguous: HookOverrides = {
    'pr:create': [
      { type: 'chat', prompt: 'same', model: 'one' },
      { type: 'chat', prompt: 'same', model: 'two' },
    ],
  };
  expect(
    addOrganizationSourceHookBindings(ambiguous, undefined, organizationId),
  ).toBeUndefined();
  const local: HookOverrides = {
    'pr:create': [
      {
        type: 'chat',
        prompt: 'Review the PR',
        localExecutionContextOverlay: true,
      },
      {
        type: 'chat',
        prompt: 'Review the PR',
        localExecutionContextOverlay: true,
      },
    ],
  };
  expect(
    addOrganizationSourceHookBindings(
      { 'pr:create': [chatHook] },
      local,
      organizationId,
    ),
  ).toBe(local);
});

it('does not copy a context supplied by a source-controlled action into local storage', () => {
  expect(
    addOrganizationSourceHookBindings(
      {
        'pr:create': [
          {
            type: 'pipeline',
            source: 'bundled',
            id: 'review',
            executionContext: 'personal',
          },
        ],
      },
      undefined,
      organizationId,
    ),
  ).toBeUndefined();
});

it('handles a trigger whose name is an inherited object property', () => {
  const inherited: HookOverrides = {
    toString: [{ type: 'pipeline', source: 'bundled', id: 'review' }],
  };
  expect(
    addOrganizationSourceHookBindings(
      inherited,
      { unrelated: null },
      organizationId,
    ),
  ).toHaveProperty('toString', [
    {
      type: 'pipeline',
      source: 'bundled',
      id: 'review',
      executionContext: context,
      localExecutionContextOverlay: true,
    },
  ]);
});
