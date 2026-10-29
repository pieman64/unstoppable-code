import type { InvocableInventoryEntry } from '@canopy/desktop-shared/types';
import type { ChatMessage } from '@/stores/chat/types';
import { collectChatSkillUsage } from '../chatSkillUsage';
import {
  buildInvocableMentionIndex,
  findInvocableMentionTarget,
} from '../invocableMentionIndex';

function entry(
  options: Pick<
    InvocableInventoryEntry,
    'id' | 'provider' | 'kind' | 'name'
  > & {
    displayName: string;
  },
): InvocableInventoryEntry {
  return {
    ...options,
    description: '',
    insertText: `${options.displayName} `,
    invocationKey: options.displayName,
    enableRef:
      options.kind === 'skill'
        ? { kind: 'skill', sourceId: 'custom:app', skillName: options.name }
        : { kind: 'plugin', marketplaceId: 'market', pluginName: 'tools' },
  };
}

const index = buildInvocableMentionIndex([
  entry({
    id: 'claude-notes',
    provider: 'claude',
    kind: 'skill',
    name: 'release-notes',
    displayName: '/release-notes',
  }),
  entry({
    id: 'codex-notes',
    provider: 'codex',
    kind: 'skill',
    name: 'release-notes',
    displayName: '$release-notes',
  }),
  entry({
    id: 'claude-review',
    provider: 'claude',
    kind: 'plugin_command',
    name: 'review',
    displayName: '/tools:review',
  }),
  entry({
    id: 'codex-only',
    provider: 'codex',
    kind: 'skill',
    name: 'triage',
    displayName: '$triage',
  }),
]);

function message(
  role: 'user' | 'assistant',
  blocks: ChatMessage['blocks'],
): ChatMessage {
  return {
    id: `${role}-${String(Math.random())}`,
    role,
    blocks,
  } as ChatMessage;
}

const text = (value: string): ChatMessage['blocks'][number] =>
  ({ type: 'text', text: value }) as ChatMessage['blocks'][number];
const skillCall = (input: string): ChatMessage['blocks'][number] =>
  ({
    type: 'tool_use',
    toolName: 'Skill',
    input,
  }) as ChatMessage['blocks'][number];

describe('findInvocableMentionTarget', () => {
  it('resolves the supplied alias, then the slash form, then the dollar form', () => {
    expect(findInvocableMentionTarget(index, '$release-notes')?.entry.id).toBe(
      'codex-notes',
    );
    expect(findInvocableMentionTarget(index, 'release-notes')?.entry.id).toBe(
      'claude-notes',
    );
    expect(findInvocableMentionTarget(index, 'triage')?.entry.id).toBe(
      'codex-only',
    );
    expect(findInvocableMentionTarget(index, 'tools:review')?.entry.id).toBe(
      'claude-review',
    );
  });

  it('does not guess an unknown name or search without an index', () => {
    expect(findInvocableMentionTarget(index, 'unknown')).toBeNull();
    expect(findInvocableMentionTarget(index, '/unknown')).toBeNull();
    expect(findInvocableMentionTarget(index, '   ')).toBeNull();
    expect(findInvocableMentionTarget(null, 'release-notes')).toBeNull();
  });
});

describe('collectChatSkillUsage', () => {
  const ids = (messages: ChatMessage[]): string[] =>
    collectChatSkillUsage(messages, index).map((target) => target.entry.id);

  it('collects Skill tool calls and user mentions in first-use order, once each', () => {
    expect(
      ids([
        message('user', [text('Run /tools:review then /release-notes')]),
        message('assistant', [
          skillCall(JSON.stringify({ skill: 'triage' })),
          skillCall(JSON.stringify({ skill: 'release-notes' })),
        ]),
        message('user', [text('/tools:review again')]),
      ]),
    ).toEqual(['claude-review', 'claude-notes', 'codex-only']);
  });

  it('ignores assistant prose, malformed input and unresolved names', () => {
    expect(
      ids([
        message('assistant', [
          text('You could try /release-notes next.'),
          skillCall('{not json'),
          skillCall(JSON.stringify({ skill: 42 })),
          skillCall(JSON.stringify({ skill: 'not-installed' })),
          skillCall('"release-notes"'),
        ]),
      ]),
    ).toEqual([]);
  });

  it('counts a Skill call that also carries a raw command', () => {
    expect(
      ids([
        message('assistant', [
          skillCall(
            JSON.stringify({ skill: 'triage', raw_command: '$triage now' }),
          ),
        ]),
      ]),
    ).toEqual(['codex-only']);
  });

  it('returns nothing without an index or messages, and reuses a settled answer', () => {
    const messages = [message('user', [text('/release-notes')])];
    expect(collectChatSkillUsage(messages, null)).toEqual([]);
    expect(collectChatSkillUsage([], index)).toEqual([]);
    expect(collectChatSkillUsage(messages, index)).toBe(
      collectChatSkillUsage(messages, index),
    );
  });
});
