import Ajv, { type AnySchema } from 'ajv';
import { z } from 'zod';
import type { AgentJson } from '@canopy/agent-actions';
import {
  canonicalChatWatcherEntrySchema,
  canonicalChatWatcherEntryJsonSchema,
  canonicalChatWatcherEnvelopeSchema,
  canonicalChatWatcherEquivalenceKey,
  canonicalChatWatcherToLegacy,
  legacyChatWatcherToCanonical,
  publicTargetKind,
  storeFor,
  chatWatcherSetupSchema,
  type CanonicalChatWatcherEntry,
  type CanonicalChatWatcherTrigger,
  type ResolvedChatWatcherTarget,
} from '../chat-watcher-contracts';

const entries: CanonicalChatWatcherEntry[] = [
  {
    trigger: 'project_task_chat_completion',
    target: { projectId: 'p', taskId: 't', chatId: 'c' },
  },
  { trigger: 'project_new_chat_started', target: { projectId: 'p' } },
  {
    trigger: 'bot_task_chat_completion',
    target: { botId: 'app_advisor', taskId: 't', chatId: 'c' },
  },
  { trigger: 'bot_new_chat_started', target: { botId: 'app_advisor' } },
];
const forbidden = [
  'unknown',
  'kind',
  'destination',
  'destinationChatId',
  'sessionId',
  'providerSessionId',
  'owner',
  'sourceOwner',
  'accountEpoch',
  'display',
  'title',
  'ui',
];

function asAjvSchema(value: AgentJson): AnySchema {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
    return value;
  }
  throw new Error('Expected the canonical watcher JSON schema to be an object');
}

describe('canonical chat watcher strict contracts', () => {
  it('validates all raw canonical entries before any mixed-batch legacy normalization', () => {
    const normalizeLegacy = jest.fn((entry: unknown) => entry);
    const schema = chatWatcherSetupSchema(
      z.object({ trigger: z.literal('legacy') }),
      normalizeLegacy,
    );
    expect(
      schema.safeParse({
        watchers: [{ trigger: 'legacy' }, { ...entries[0], kind: 'bad' }],
      }).success,
    ).toBe(false);
    expect(normalizeLegacy).not.toHaveBeenCalled();
    expect(
      schema.safeParse({ watchers: [{ trigger: 'legacy' }, entries[0]] })
        .success,
    ).toBe(true);
    expect(normalizeLegacy).toHaveBeenCalledTimes(1);
    expect(normalizeLegacy).toHaveBeenCalledWith({ trigger: 'legacy' });
  });
  const validateJson = new Ajv({
    strict: false,
  }).compile<CanonicalChatWatcherEntry>(
    asAjvSchema(canonicalChatWatcherEntryJsonSchema),
  );
  function expectEntry(value: unknown, valid: boolean): void {
    expect(canonicalChatWatcherEntrySchema.safeParse(value).success).toBe(
      valid,
    );
    expect(validateJson(value)).toBe(valid);
  }
  it.each(entries)(
    'accepts $trigger and its limits with JSON/Zod parity',
    (entry) => {
      expectEntry(entry, true);
      expectEntry(
        {
          ...entry,
          label: 'l'.repeat(160),
          followUpInstruction: 'f'.repeat(8000),
          allowDuplicate: true,
        },
        true,
      );
      expectEntry({ ...entry, label: 'l'.repeat(161) }, false);
      expectEntry({ ...entry, followUpInstruction: 'f'.repeat(8001) }, false);
    },
  );
  it.each(forbidden)('rejects %s at all object levels', (key) => {
    for (const entry of entries) {
      expectEntry({ ...entry, [key]: 'bad' }, false);
      expectEntry(
        { ...entry, target: { ...entry.target, [key]: 'bad' } },
        false,
      );
      expect(
        canonicalChatWatcherEnvelopeSchema.safeParse({
          watchers: [entry],
          [key]: 'bad',
        }).success,
      ).toBe(false);
    }
  });
  it('requires completion parents and forbids cross-domain or scope-only fields', () => {
    for (const trigger of [
      'project_task_chat_completion',
      'bot_task_chat_completion',
    ]) {
      const target = trigger.startsWith('project')
        ? { projectId: 'p', chatId: 'c' }
        : { botId: 'app_advisor', chatId: 'c' };
      expectEntry({ trigger, target }, false);
    }
    for (const entry of entries) {
      const extra =
        'botId' in entry.target ? { projectId: 'p' } : { botId: 'app_advisor' };
      expectEntry({ ...entry, target: { ...entry.target, ...extra } }, false);
      if (entry.trigger.endsWith('started')) {
        expectEntry({ ...entry, armForNextCompletion: false }, false);
        expectEntry(
          { ...entry, target: { ...entry.target, chatId: 'c' } },
          false,
        );
        expectEntry(
          { ...entry, target: { ...entry.target, taskId: 't' } },
          true,
        );
      } else {
        expectEntry({ ...entry, armForNextCompletion: true }, true);
      }
    }
  });
  it('rejects blank IDs and invalid envelopes, and enforces the canonical ten-entry budget', () => {
    expectEntry(
      { trigger: 'project_new_chat_started', target: { projectId: '  ' } },
      false,
    );
    expectEntry(
      {
        trigger: 'project_new_chat_started',
        target: { projectId: 'p'.repeat(513) },
      },
      false,
    );
    for (const value of [
      entries,
      entries[0],
      JSON.stringify({ watchers: entries }),
      { watchers: JSON.stringify(entries) },
      { watchers: [] },
      { watchers: Array(11).fill(entries[0]) },
    ]) {
      expect(canonicalChatWatcherEnvelopeSchema.safeParse(value).success).toBe(
        false,
      );
    }
    expect(
      canonicalChatWatcherEnvelopeSchema.safeParse({
        watchers: Array(10).fill(entries[0]),
      }).success,
    ).toBe(true);
  });
});

describe('chat watcher storage truth table and resolved adapters', () => {
  const rows: Array<{
    trigger: CanonicalChatWatcherTrigger;
    target: ResolvedChatWatcherTarget;
    store: 'v1' | 'sidecar';
    legacy?: string;
  }> = [
    {
      trigger: 'project_task_chat_completion',
      target: {
        kind: 'project',
        projectType: 'code',
        address: { projectId: 'p', taskId: 't', chatId: 'c' },
      },
      store: 'v1',
      legacy: 'worktree_chat_completion',
    },
    {
      trigger: 'project_task_chat_completion',
      target: {
        kind: 'project',
        projectType: 'cowork',
        address: { projectId: 'p', taskId: 'entry', chatId: 'c' },
      },
      store: 'v1',
      legacy: 'standalone_chat_completion',
    },
    {
      trigger: 'project_new_chat_started',
      target: {
        kind: 'project',
        projectType: 'code',
        address: { projectId: 'p', taskId: 't' },
      },
      store: 'v1',
      legacy: 'worktree_new_chat_started',
    },
    {
      trigger: 'project_new_chat_started',
      target: {
        kind: 'project',
        projectType: 'code',
        address: { projectId: 'p' },
      },
      store: 'sidecar',
    },
    {
      trigger: 'project_new_chat_started',
      target: {
        kind: 'project',
        projectType: 'cowork',
        address: { projectId: 'p' },
      },
      store: 'v1',
      legacy: 'standalone_new_chat_started',
    },
    {
      trigger: 'project_new_chat_started',
      target: {
        kind: 'project',
        projectType: 'cowork',
        address: { projectId: 'p', taskId: 'entry' },
      },
      store: 'sidecar',
    },
    {
      trigger: 'bot_task_chat_completion',
      target: {
        kind: 'bot',
        address: { botId: 'app_advisor', taskId: 't', chatId: 'c' },
      },
      store: 'sidecar',
    },
    {
      trigger: 'bot_new_chat_started',
      target: { kind: 'bot', address: { botId: 'app_advisor' } },
      store: 'sidecar',
    },
    {
      trigger: 'bot_new_chat_started',
      target: { kind: 'bot', address: { botId: 'app_advisor', taskId: 't' } },
      store: 'sidecar',
    },
  ];
  it.each(rows)(
    'stores $trigger / $target as $store',
    ({ trigger, target, store, legacy }) => {
      const encoding = storeFor(trigger, target);
      expect(encoding.store).toBe(store);
      if (encoding.store === 'v1') {
        expect(encoding.legacy.trigger).toBe(legacy);
        const resolved = legacyChatWatcherToCanonical(encoding.legacy, target);
        expect(resolved.ok).toBe(true);
        if (resolved.ok) {
          expect(resolved.entry.trigger).toBe(trigger);
          expect(resolved.entry.target).toEqual(target.address);
          expect(canonicalChatWatcherEquivalenceKey(resolved.entry)).toBe(
            canonicalChatWatcherEquivalenceKey(
              canonicalChatWatcherEntrySchema.parse({
                trigger,
                target: target.address,
              }),
            ),
          );
          expect(
            canonicalChatWatcherToLegacy(
              resolved.entry,
              target.kind === 'project' ? target.projectType : 'code',
            ),
          ).toEqual(encoding);
        }
      }
    },
  );
  it('never guesses cowork task = chat, widens a task scope, or accepts conflicting facts', () => {
    const legacy = {
      trigger: 'standalone_chat_completion',
      target: { kind: 'standalone_chat', projectId: 'p', chatId: 'c' },
    } as const;
    expect(
      legacyChatWatcherToCanonical(legacy, {
        kind: 'project',
        projectType: 'cowork',
        address: { projectId: 'p' },
      }),
    ).toEqual({ ok: false, reason: 'migration_required' });
    for (const address of [
      { projectId: 'other', taskId: 'entry', chatId: 'c' },
      { projectId: 'p', taskId: 'entry', chatId: 'other' },
    ]) {
      expect(
        legacyChatWatcherToCanonical(legacy, {
          kind: 'project',
          projectType: 'cowork',
          address,
        }),
      ).toEqual({ ok: false, reason: 'migration_required' });
    }
    expect(
      legacyChatWatcherToCanonical(
        {
          trigger: 'standalone_new_chat_started',
          target: { kind: 'standalone_chat_project', projectId: 'p' },
        },
        {
          kind: 'project',
          projectType: 'cowork',
          address: { projectId: 'p', taskId: 'entry' },
        },
      ),
    ).toEqual({ ok: false, reason: 'migration_required' });
    expect(() =>
      storeFor('bot_new_chat_started', {
        kind: 'project',
        projectType: 'code',
        address: { projectId: 'p' },
      }),
    ).toThrow('mismatch');
  });
  it('dedupes resolved old/new spellings, not recipients, domains, parents or trigger scopes', () => {
    const entry = entries[0];
    const encoded = canonicalChatWatcherToLegacy(entry, 'code');
    expect(encoded.store).toBe('v1');
    if (encoded.store !== 'v1') throw new Error('Expected legacy encoding');
    const resolved = legacyChatWatcherToCanonical(encoded.legacy, {
      kind: 'project',
      projectType: 'code',
      address: { projectId: 'p', taskId: 't', chatId: 'c' },
    });
    if (!resolved.ok) throw new Error('Expected resolved target');
    const key = canonicalChatWatcherEquivalenceKey(entry, 'recipient');
    expect(
      canonicalChatWatcherEquivalenceKey(
        { ...resolved.entry, label: 'different', allowDuplicate: true },
        'recipient',
      ),
    ).toBe(key);
    expect(canonicalChatWatcherEquivalenceKey(entry, 'other')).not.toBe(key);
    expect(
      new Set(entries.map((value) => canonicalChatWatcherEquivalenceKey(value)))
        .size,
    ).toBe(4);
    expect(
      canonicalChatWatcherEquivalenceKey({
        trigger: 'project_new_chat_started',
        target: { projectId: 'p', taskId: 't' },
      }),
    ).not.toBe(canonicalChatWatcherEquivalenceKey(entries[1]));
    expect(entries.map((value) => publicTargetKind(value.trigger))).toEqual([
      'project_task_chat',
      'project_chat_scope',
      'bot_task_chat',
      'bot_chat_scope',
    ]);
  });
});
