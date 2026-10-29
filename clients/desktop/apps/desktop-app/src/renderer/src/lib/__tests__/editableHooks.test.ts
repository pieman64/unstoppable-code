import type { HookOverrides } from '@canopy/desktop-shared/hooks';
import {
  addEditableHookAction,
  createEditableHooks,
  getEditableHookActions,
  isEditableHookDisabled,
  moveEditableHookAction,
  removeEditableHookAction,
  serializeHooks,
  setEditableHookActions,
  setEditableHookDisabled,
  toHookInputMap,
  updateEditableHookAction,
  type EditableHooks,
} from '../editableHooks';

function stripActionUiId(
  action: { uiId: string } & Record<string, unknown>,
): Record<string, unknown> {
  const { uiId, ...rest } = action;
  void uiId;
  return rest;
}

function stripUiIds(hooks: EditableHooks): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(hooks).map(([triggerName, value]) => [
      triggerName,
      value === null ? null : value.map((action) => stripActionUiId(action)),
    ]),
  );
}

describe('createEditableHooks', () => {
  it('round-trips composer references and explicit chat settings', () => {
    const action = {
      type: 'chat' as const,
      prompt: 'Read @README.md',
      promptReferences: [
        {
          kind: 'file' as const,
          root: { kind: 'workspace' as const },
          relativePath: 'README.md',
          displayText: '@README.md',
          textStart: 5,
        },
      ],
      planMode: false,
      approvalMode: 'full-access' as const,
    };
    expect(
      toHookInputMap(createEditableHooks({ 'pr:create': [action] })),
    ).toEqual({ 'pr:create': [action] });
  });

  it('extracts runnable hooks and disabled tombstones', () => {
    const overrides: HookOverrides = {
      'pr:create': [
        { type: 'command', command: 'echo hello', interactive: true },
      ],
      'pr:merged': null,
      'pr:closed': [
        { type: 'command', command: 'cmd1' },
        {
          type: 'chat',
          prompt: 'Review comments',
          model: 'gpt-6-sol',
          modelConfig: { thinkingLevel: 'medium' },
          'if-command': 'test -f "$CANOPY_PR_CURRENT_FILE"',
        },
      ],
    };

    expect(stripUiIds(createEditableHooks(overrides))).toEqual({
      'pr:create': [
        { type: 'command', command: 'echo hello', interactive: true },
      ],
      'pr:merged': null,
      'pr:closed': [
        { type: 'command', command: 'cmd1' },
        {
          type: 'chat',
          prompt: 'Review comments',
          model: 'gpt-6-sol',
          modelConfig: { thinkingLevel: 'medium' },
          'if-command': 'test -f "$CANOPY_PR_CURRENT_FILE"',
        },
      ],
    });
  });
});

describe('getEditableHookActions', () => {
  it('returns the actions for a given trigger', () => {
    const hooks = createEditableHooks({
      'pr:create': [
        { type: 'command', command: 'cmd1' },
        { type: 'chat', prompt: 'Review' },
      ],
    });

    expect(
      getEditableHookActions(hooks, 'pr:create').map((action) =>
        stripActionUiId(action),
      ),
    ).toEqual([
      { type: 'command', command: 'cmd1' },
      { type: 'chat', prompt: 'Review' },
    ]);
  });

  it('returns empty array for missing or disabled triggers', () => {
    expect(getEditableHookActions({}, 'pr:create')).toEqual([]);
    expect(getEditableHookActions({ 'pr:create': null }, 'pr:create')).toEqual(
      [],
    );
  });
});

describe('action updates', () => {
  it('replaces the action list for a trigger', () => {
    const hooks: EditableHooks = {
      'pr:create':
        createEditableHooks({
          'pr:create': [{ type: 'command', command: 'old' }],
        })['pr:create'] ?? [],
    };

    expect(
      stripUiIds(
        setEditableHookActions(hooks, 'pr:create', [
          { type: 'chat', prompt: 'new' },
        ]),
      ),
    ).toEqual({
      'pr:create': [{ type: 'chat', prompt: 'new' }],
    });
  });

  it('adds, updates, removes, and moves actions', () => {
    const added = addEditableHookAction({}, 'pr:create', {
      type: 'command',
      command: 'cmd1',
    });
    const withChat = addEditableHookAction(added, 'pr:create', {
      type: 'chat',
      prompt: 'Review changes',
    });
    const updated = updateEditableHookAction(withChat, 'pr:create', 1, {
      type: 'chat',
      prompt: 'Review changes',
      model: 'gpt-6-sol',
      thinking: 'medium',
      'if-command': 'test -f "$CANOPY_PR_CURRENT_FILE"',
    });
    const moved = moveEditableHookAction(updated, 'pr:create', 1, 0);
    const removed = removeEditableHookAction(moved, 'pr:create', 1);

    const movedActions = moved['pr:create'];
    const removedActions = removed['pr:create'];

    expect(
      Array.isArray(movedActions)
        ? movedActions.map((action) => stripActionUiId(action))
        : movedActions,
    ).toEqual([
      {
        type: 'chat',
        prompt: 'Review changes',
        model: 'gpt-6-sol',
        modelConfig: { thinkingLevel: 'medium' },
        'if-command': 'test -f "$CANOPY_PR_CURRENT_FILE"',
      },
      { type: 'command', command: 'cmd1' },
    ]);
    expect(
      Array.isArray(removedActions)
        ? removedActions.map((action) => stripActionUiId(action))
        : removedActions,
    ).toEqual([
      {
        type: 'chat',
        prompt: 'Review changes',
        model: 'gpt-6-sol',
        modelConfig: { thinkingLevel: 'medium' },
        'if-command': 'test -f "$CANOPY_PR_CURRENT_FILE"',
      },
    ]);
  });

  it('preserves ui ids when updating an existing action', () => {
    const hooks = addEditableHookAction({}, 'pr:create', {
      type: 'chat',
      prompt: 'Review changes',
    });
    const originalAction = getEditableHookActions(hooks, 'pr:create')[0];
    if (!originalAction) {
      throw new Error('Expected original action');
    }

    const updatedHooks = updateEditableHookAction(hooks, 'pr:create', 0, {
      type: 'chat',
      prompt: 'Updated prompt',
      model: 'gpt-6-sol',
    });
    const updatedAction = getEditableHookActions(updatedHooks, 'pr:create')[0];

    expect(updatedAction?.uiId).toBe(originalAction.uiId);
  });
});

describe('disabled triggers', () => {
  it('tracks null sentinels', () => {
    expect(isEditableHookDisabled({ 'pr:create': null }, 'pr:create')).toBe(
      true,
    );
    expect(
      isEditableHookDisabled(
        createEditableHooks({
          'pr:create': [{ type: 'command', command: 'cmd' }],
        }),
        'pr:create',
      ),
    ).toBe(false);
  });

  it('writes and clears disabled sentinels', () => {
    const hooks = createEditableHooks({
      'pr:create': [{ type: 'command', command: 'cmd' }],
    });

    expect(setEditableHookDisabled(hooks, 'pr:create', true)).toEqual({
      'pr:create': null,
    });
    expect(
      setEditableHookDisabled({ 'pr:create': null }, 'pr:create', false),
    ).toEqual({});
  });
});

describe('toHookInputMap', () => {
  it('round-trips mixed command and chat actions', () => {
    const hooks = createEditableHooks({
      'pr:create': [
        { type: 'command', command: 'echo ok', interactive: true },
        {
          type: 'chat',
          prompt: 'Review the PR',
          model: 'gpt-6-sol',
          modelConfig: { thinkingLevel: 'medium' },
          'if-command': 'test -f "$CANOPY_PR_CURRENT_FILE"',
        },
      ],
    });

    expect(toHookInputMap(hooks)).toEqual({
      'pr:create': [
        { type: 'command', command: 'echo ok', interactive: true },
        {
          type: 'chat',
          prompt: 'Review the PR',
          model: 'gpt-6-sol',
          modelConfig: { thinkingLevel: 'medium' },
          'if-command': 'test -f "$CANOPY_PR_CURRENT_FILE"',
        },
      ],
    });
  });

  it('preserves null tombstones and filters blank actions', () => {
    const hooks = createEditableHooks({
      'pr:create': [
        { type: 'command', command: '  ' },
        { type: 'chat', prompt: 'Review' },
      ],
      'pr:merged': null,
    });
    const rawOverrides: HookOverrides = {
      'pr:closed': null,
    };

    expect(toHookInputMap(hooks, rawOverrides)).toEqual({
      'pr:create': [{ type: 'chat', prompt: 'Review' }],
      'pr:merged': null,
      'pr:closed': null,
    });
  });

  it('omits disabled sentinels when requested', () => {
    expect(toHookInputMap({ 'pr:create': null }, undefined, false)).toEqual({});
  });

  it('round-trips allowChatConcurrency=true through createEditableHooks → toHookInputMap', () => {
    const hooks = createEditableHooks({
      'pr:create': [
        {
          type: 'chat',
          prompt: 'Review',
          allowChatConcurrency: true,
        },
      ],
    });
    expect(toHookInputMap(hooks)).toEqual({
      'pr:create': [
        {
          type: 'chat',
          prompt: 'Review',
          allowChatConcurrency: true,
        },
      ],
    });
  });

  it('omits allowChatConcurrency when absent or false', () => {
    const hooks = createEditableHooks({
      'pr:create': [
        {
          type: 'chat',
          prompt: 'Review',
        },
      ],
    });
    expect(toHookInputMap(hooks)).toEqual({
      'pr:create': [{ type: 'chat', prompt: 'Review' }],
    });
  });
});

describe('serializeHooks', () => {
  it('produces deterministic output', () => {
    const a = createEditableHooks({
      'pr:closed': [{ type: 'command', command: 'b' }],
      'pr:create': [{ type: 'chat', prompt: 'a' }],
    });
    const b = createEditableHooks({
      'pr:create': [{ type: 'chat', prompt: 'a' }],
      'pr:closed': [{ type: 'command', command: 'b' }],
    });

    expect(serializeHooks(a)).toBe(serializeHooks(b));
  });
});

describe('chat action plugin refs', () => {
  it('preserves plugin refs through createEditableHooks → toHookInputMap', () => {
    const overrides: HookOverrides = {
      'pr:create': [
        {
          type: 'chat',
          prompt: 'Review',
          plugins: [
            {
              type: 'skill',
              source: { type: 'github', repo: 'acme/skills' },
              skill_name: 'commit-messages',
            },
            {
              type: 'plugin',
              marketplace: { type: 'github', repo: 'acme/marketplace' },
              plugin_name: 'dynamic-browser',
            },
            {
              type: 'claude_plugin',
              marketplace: { type: 'github', repo: 'acme/marketplace' },
              plugin_name: 'browser',
            },
            {
              type: 'claude_plugin',
              marketplace: { type: 'builtin', id: 'app' },
              plugin_name: 'commit-helper',
            },
            {
              type: 'codex_plugin',
              marketplace: { type: 'codex-builtin', id: 'openai-curated' },
              plugin_name: 'codex-security',
            },
          ],
        },
      ],
    };

    const hooks = createEditableHooks(overrides);
    const action = getEditableHookActions(hooks, 'pr:create')[0];
    expect(action?.type).toBe('chat');
    if (action?.type !== 'chat') {
      throw new Error('Expected chat action');
    }
    expect(action.plugins).toEqual([
      {
        type: 'skill',
        source: { type: 'github', repo: 'acme/skills' },
        skill_name: 'commit-messages',
      },
      {
        type: 'plugin',
        marketplace: { type: 'github', repo: 'acme/marketplace' },
        plugin_name: 'dynamic-browser',
      },
      {
        type: 'claude_plugin',
        marketplace: { type: 'github', repo: 'acme/marketplace' },
        plugin_name: 'browser',
      },
      {
        type: 'claude_plugin',
        marketplace: { type: 'builtin', id: 'app' },
        plugin_name: 'commit-helper',
      },
      {
        type: 'codex_plugin',
        marketplace: { type: 'codex-builtin', id: 'openai-curated' },
        plugin_name: 'codex-security',
      },
    ]);

    expect(toHookInputMap(hooks)).toEqual({
      'pr:create': [
        {
          type: 'chat',
          prompt: 'Review',
          plugins: [
            {
              type: 'skill',
              source: { type: 'github', repo: 'acme/skills' },
              skill_name: 'commit-messages',
            },
            {
              type: 'plugin',
              marketplace: { type: 'github', repo: 'acme/marketplace' },
              plugin_name: 'dynamic-browser',
            },
            {
              type: 'claude_plugin',
              marketplace: { type: 'github', repo: 'acme/marketplace' },
              plugin_name: 'browser',
            },
            {
              type: 'claude_plugin',
              marketplace: { type: 'builtin', id: 'app' },
              plugin_name: 'commit-helper',
            },
            {
              type: 'codex_plugin',
              marketplace: { type: 'codex-builtin', id: 'openai-curated' },
              plugin_name: 'codex-security',
            },
          ],
        },
      ],
    });
  });

  it('omits plugins from serialization when empty', () => {
    const hooks = createEditableHooks({
      'pr:create': [{ type: 'chat', prompt: 'Review' }],
    });
    expect(serializeHooks(hooks)).not.toContain('plugins');
    expect(JSON.stringify(toHookInputMap(hooks))).not.toContain('plugins');
  });
});
