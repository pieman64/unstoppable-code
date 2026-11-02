import type { Descendant } from 'slate';
import type { TryItCapability } from '@canopy/protocol/try-it';
import {
  appendTryItStarter,
  chooseTryItStageTarget,
  mergeTryItSelections,
  tryItProviderSupported,
  type TryItStageCandidateTab,
} from '../tryItStage';

const always = (): boolean => true;

describe('chooseTryItStageTarget', () => {
  const chat: TryItStageCandidateTab = { id: 'chat' };
  const file: TryItStageCandidateTab = { id: 'file', kind: 'file' };

  it('uses the active editable chat', () => {
    expect(
      chooseTryItStageTarget(
        {
          worktreeSelected: true,
          tabs: [chat, { id: 'other' }],
          activeTabId: 'chat',
          lastActiveEditableChatId: 'other',
        },
        always,
      ),
    ).toEqual({ kind: 'existing', tabId: 'chat' });
  });

  it('uses the remembered chat behind a file tab', () => {
    expect(
      chooseTryItStageTarget(
        {
          worktreeSelected: true,
          tabs: [chat, file],
          activeTabId: 'file',
          lastActiveEditableChatId: 'chat',
        },
        always,
      ),
    ).toEqual({ kind: 'existing', tabId: 'chat' });
  });

  it.each([
    ['no editable tab', [file], 'file', undefined],
    ['a read-only chat', [{ id: 'chat', readOnly: true }], 'chat', undefined],
    ['a stale remembered chat', [file], 'file', 'deleted'],
    [
      'a chat still being created',
      [{ id: 'chat', pendingInitialCreation: true }],
      'chat',
      undefined,
    ],
  ])('creates a chat in the worktree for %s', (_, tabs, activeTabId, last) => {
    expect(
      chooseTryItStageTarget(
        {
          worktreeSelected: true,
          tabs,
          activeTabId,
          lastActiveEditableChatId: last,
        },
        always,
      ),
    ).toEqual({ kind: 'new-tab' });
  });

  it('creates a compatible chat beside an incompatible one', () => {
    expect(
      chooseTryItStageTarget(
        {
          worktreeSelected: true,
          tabs: [chat],
          activeTabId: 'chat',
          lastActiveEditableChatId: 'chat',
        },
        () => false,
      ),
    ).toEqual({ kind: 'new-tab' });
  });

  it('falls back to a standalone chat only without a worktree', () => {
    expect(
      chooseTryItStageTarget(
        {
          worktreeSelected: false,
          tabs: [],
          activeTabId: undefined,
          lastActiveEditableChatId: undefined,
        },
        always,
      ),
    ).toEqual({ kind: 'standalone' });
  });
});

describe('tryItProviderSupported', () => {
  const codexOnly = { claude: false, codex: true, cursor: false };

  it('checks the chat provider, not the viewer default', () => {
    expect(tryItProviderSupported('claude', codexOnly)).toBe(false);
    expect(tryItProviderSupported('codex', codexOnly)).toBe(true);
    expect(tryItProviderSupported('opencode', codexOnly)).toBe(false);
  });

  it('creates a compatible chat when the existing provider is unresolved', () => {
    expect(
      chooseTryItStageTarget(
        {
          worktreeSelected: true,
          tabs: [{ id: 'legacy-chat' }],
          activeTabId: 'legacy-chat',
          lastActiveEditableChatId: undefined,
        },
        () => tryItProviderSupported(undefined, codexOnly),
      ),
    ).toEqual({ kind: 'new-tab' });
    expect(tryItProviderSupported(undefined, undefined)).toBe(true);
  });

  it('accepts every provider without harness rows', () => {
    expect(tryItProviderSupported('claude', undefined)).toBe(true);
  });

  it.each(['copilot', 'opencode'] as const)(
    'keeps a compatible %s chat using the Cursor facet',
    (provider) => {
      const target = {
        worktreeSelected: true,
        tabs: [{ id: 'current' }],
        activeTabId: 'current',
        lastActiveEditableChatId: undefined,
      };
      const support = { claude: false, codex: true, cursor: true };
      expect(
        chooseTryItStageTarget(target, () =>
          tryItProviderSupported(provider, support),
        ),
      ).toEqual({ kind: 'existing', tabId: 'current' });
      expect(
        chooseTryItStageTarget(target, () =>
          tryItProviderSupported(provider, { ...support, cursor: false }),
        ),
      ).toEqual({ kind: 'new-tab' });
    },
  );
});

describe('appendTryItStarter', () => {
  const prompt = 'Triage this incident.\nStart with the error rate.';

  it('turns an empty draft into the starter, one paragraph per line', () => {
    expect(
      appendTryItStarter(
        [{ type: 'paragraph', children: [{ text: '  ' }] }],
        prompt,
      ),
    ).toEqual([
      { type: 'paragraph', children: [{ text: 'Triage this incident.' }] },
      { type: 'paragraph', children: [{ text: 'Start with the error rate.' }] },
    ]);
  });

  it('appends after a blank line and keeps the existing nodes unmutated', () => {
    const draft: Descendant[] = [
      {
        type: 'paragraph',
        children: [
          { text: 'p95 is up ' },
          {
            type: 'file-reference',
            displayPath: 'src/checkout.ts',
            absolutePath: '/repo/src/checkout.ts',
            children: [{ text: '' }],
          },
          { text: '' },
        ],
      },
    ];
    const before = structuredClone(draft);
    const result = appendTryItStarter(draft, 'Triage it.');
    expect(draft).toEqual(before);
    expect(result).toEqual([
      ...before,
      { type: 'paragraph', children: [{ text: '' }] },
      { type: 'paragraph', children: [{ text: 'Triage it.' }] },
    ]);
    expect(result[0]).not.toBe(draft[0]);
  });

  it('keeps a reference-only draft', () => {
    const draft: Descendant[] = [
      {
        type: 'paragraph',
        children: [
          { text: '' },
          {
            type: 'file-reference',
            displayPath: 'README.md',
            absolutePath: '/repo/README.md',
            children: [{ text: '' }],
          },
          { text: '' },
        ],
      },
    ];
    expect(appendTryItStarter(draft, 'Go.')).toHaveLength(3);
  });
});

describe('mergeTryItSelections', () => {
  const capability: TryItCapability = {
    kind: 'skill',
    sourceId: 'share:abc',
    catalogId: 'incident-triage',
    name: 'Incident triage',
  };

  it('adds the capability once and keeps unrelated selections', () => {
    const existing = {
      collectionIds: ['oncall'],
      skillRefs: [{ sourceId: 'custom', skillName: 'notes' }],
      pluginRefs: [{ marketplaceId: 'm', pluginName: 'p' }],
    };
    const incoming = {
      collectionIds: [],
      skillRefs: [{ sourceId: 'custom', skillName: 'incident-triage' }],
      pluginRefs: [],
    };
    const once = mergeTryItSelections(existing, incoming);
    expect(mergeTryItSelections(once, incoming)).toEqual(once);
    expect(once).toMatchObject({
      collectionIds: ['oncall'],
      skillRefs: [
        { sourceId: 'custom', skillName: 'notes' },
        { sourceId: 'custom', skillName: 'incident-triage' },
      ],
      pluginRefs: [{ marketplaceId: 'm', pluginName: 'p' }],
    });
  });

  it('deduplicates an unresolved capability', () => {
    const incoming = {
      collectionIds: [],
      skillRefs: [],
      pluginRefs: [],
      unresolvedCapabilities: [capability],
    };
    expect(
      mergeTryItSelections(mergeTryItSelections(undefined, incoming), incoming)
        .unresolvedCapabilities,
    ).toEqual([capability]);
  });
});
