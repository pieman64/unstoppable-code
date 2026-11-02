import type { ChatModel } from '@canopy/desktop-shared/types';
import {
  resolveGuestModelFallback,
  revalidateGuestModelFallback,
  type GuestFallbackRow,
} from '../guestModelFallback';

const GATEWAY_IDS: Readonly<Record<string, string>> = {
  'claude-opus-5': 'anthropic/claude-opus-5',
  'claude-haiku-5.5': 'anthropic/claude-haiku-5.5',
  'cursor-claude-haiku-5.5': 'anthropic/claude-haiku-5.5',
  'gpt-6-sol': 'openai/gpt-6-sol',
  'gpt-6-luna': 'openai/gpt-6-luna',
  'gpt-5.6-luna': 'openai/gpt-5.6-luna',
  'mistral-large': 'mistral/mistral-large',
};
const CANONICAL: Record<string, string | undefined> = {
  'anthropic/claude-haiku-5.5': 'claude-haiku-5.5',
  'openai/gpt-6-luna': 'gpt-6-luna',
};

jest.mock('@canopy/desktop-shared/lib/gateway-model-availability', () => ({
  resolveGatewayModelEntry: (
    modelId: string | undefined,
  ): { gatewayId: string; modelId: string } | undefined => {
    const gatewayId = modelId === undefined ? undefined : GATEWAY_IDS[modelId];
    return gatewayId === undefined
      ? undefined
      : { gatewayId, modelId: modelId ?? '' };
  },
  resolveModelIdForGatewayId: (gatewayId: string): string | undefined =>
    CANONICAL[gatewayId],
}));

const model = (id: string): ChatModel => id;

function row(
  id: string,
  gate: GuestFallbackRow['gate'] = { kind: 'available' },
  selectionModel?: string,
): GuestFallbackRow {
  return {
    model: model(id),
    runtimeModel: model(id),
    ...(selectionModel === undefined
      ? {}
      : { selectionModel: model(selectionModel) }),
    gate,
  };
}

const gated = row('claude-opus-5', {
  kind: 'recoverable',
  recovery: { kind: 'needs-account' },
});

describe('resolveGuestModelFallback', () => {
  it('offers the available same-vendor allowlist row with its allowlist label', () => {
    expect(
      resolveGuestModelFallback({
        gatedModel: model('claude-opus-5'),
        currentModel: model('gpt-6-luna'),
        rows: [gated, row('claude-haiku-5.5')],
      }),
    ).toEqual({
      model: 'claude-haiku-5.5',
      gatewayId: 'anthropic/claude-haiku-5.5',
      label: 'Claude Haiku 5.5',
      access: 'now',
    });
  });

  // CAN-5211 — a guest who declined free daily credits sees Haiku as
  // credits-recoverable. That makes it a daily-credits candidate only; the
  // recovery modal decides whether the guest can actually turn them on.
  it.each<[string, GuestFallbackRow['gate']]>([
    [
      'needs-billing-source',
      {
        kind: 'recoverable',
        recovery: { kind: 'needs-billing-source', provider: 'claude' },
      },
    ],
    [
      'needs-credits',
      { kind: 'recoverable', recovery: { kind: 'needs-credits' } },
    ],
  ])('offers a %s candidate through free daily credits', (_case, gate) => {
    expect(
      resolveGuestModelFallback({
        gatedModel: model('claude-opus-5'),
        currentModel: model('gpt-6-luna'),
        rows: [gated, row('claude-haiku-5.5', gate)],
      }),
    ).toEqual({
      model: 'claude-haiku-5.5',
      gatewayId: 'anthropic/claude-haiku-5.5',
      label: 'Claude Haiku 5.5',
      access: 'daily-credits',
    });
  });

  it('offers the preferred credits-recoverable entry over a later available one', () => {
    expect(
      resolveGuestModelFallback({
        gatedModel: model('gpt-6-sol'),
        currentModel: undefined,
        rows: [
          row('gpt-6-luna', {
            kind: 'recoverable',
            recovery: { kind: 'needs-credits' },
          }),
          row('gpt-5.6-luna'),
        ],
      }),
    ).toMatchObject({ model: 'gpt-6-luna', access: 'daily-credits' });
  });

  it('prefers GPT 6 Luna over the legacy OpenAI entry', () => {
    expect(
      resolveGuestModelFallback({
        gatedModel: model('gpt-6-sol'),
        currentModel: undefined,
        rows: [row('gpt-5.6-luna'), row('gpt-6-luna')],
      })?.model,
    ).toBe('gpt-6-luna');
  });

  it('commits the row selection identity', () => {
    expect(
      resolveGuestModelFallback({
        gatedModel: model('claude-opus-5'),
        currentModel: undefined,
        rows: [row('claude-haiku-5.5', { kind: 'available' }, 'agent-haiku')],
      })?.model,
    ).toBe('agent-haiku');
  });

  it('offers nothing when the preferred registry mapping is missing', () => {
    const previous = CANONICAL['anthropic/claude-haiku-5.5'];
    CANONICAL['anthropic/claude-haiku-5.5'] = undefined;
    try {
      expect(
        resolveGuestModelFallback({
          gatedModel: 'claude-opus-5',
          currentModel: undefined,
          rows: [row('claude-haiku-5.5')],
        }),
      ).toBeUndefined();
    } finally {
      CANONICAL['anthropic/claude-haiku-5.5'] = previous;
    }
  });

  it.each([
    ['an unknown vendor', 'mistral-large', [row('claude-haiku-5.5')]],
    ['an unresolved gateway id', 'not-registered', [row('claude-haiku-5.5')]],
    ['a missing candidate row', 'claude-opus-5', [gated]],
    [
      'a candidate that needs an account',
      'claude-opus-5',
      [
        row('claude-haiku-5.5', {
          kind: 'recoverable',
          recovery: { kind: 'needs-account' },
        }),
      ],
    ],
    [
      'a candidate that needs a purchase',
      'claude-opus-5',
      [
        row('claude-haiku-5.5', {
          kind: 'recoverable',
          recovery: { kind: 'needs-purchase' },
        }),
      ],
    ],
    [
      'a candidate that needs a new chat',
      'claude-opus-5',
      [
        row('claude-haiku-5.5', {
          kind: 'recoverable',
          recovery: { kind: 'needs-new-chat', lockedProvider: 'ollama' },
        }),
      ],
    ],
    [
      'a hard-disabled candidate',
      'claude-opus-5',
      [
        row('claude-haiku-5.5', {
          kind: 'hard-disabled',
          cause: 'org-policy',
          reason: 'Blocked by your organization.',
        }),
      ],
    ],
    [
      'ambiguous candidate routes',
      'claude-opus-5',
      [
        row('claude-haiku-5.5', { kind: 'available' }, 'route-a'),
        row('claude-haiku-5.5', { kind: 'available' }, 'route-b'),
      ],
    ],
  ])('offers nothing for %s', (_case, gatedModel, rows) => {
    expect(
      resolveGuestModelFallback({
        gatedModel: model(gatedModel),
        currentModel: undefined,
        rows,
      }),
    ).toBeUndefined();
  });

  it.each(['claude-haiku-5.5', 'cursor-claude-haiku-5.5'])(
    'offers nothing when the chat already uses %s',
    (currentModel) => {
      expect(
        resolveGuestModelFallback({
          gatedModel: model('claude-opus-5'),
          currentModel: model(currentModel),
          rows: [row('claude-haiku-5.5')],
        }),
      ).toBeUndefined();
    },
  );

  it('does not search later allowlist entries when the preferred one is blocked', () => {
    expect(
      resolveGuestModelFallback({
        gatedModel: model('gpt-6-sol'),
        currentModel: undefined,
        rows: [
          row('gpt-6-luna', {
            kind: 'hard-disabled',
            cause: 'org-policy',
            reason: 'Blocked by your organization.',
          }),
          row('gpt-5.6-luna'),
        ],
      }),
    ).toBeUndefined();
  });

  it('rejects duplicate routes even when they share a selection identity', () => {
    expect(
      resolveGuestModelFallback({
        gatedModel: 'claude-opus-5',
        currentModel: undefined,
        rows: [
          row('claude-haiku-5.5'),
          row('claude-haiku-5.5', {
            kind: 'recoverable',
            recovery: { kind: 'needs-credits' },
          }),
        ],
      }),
    ).toBeUndefined();
  });
});

describe('revalidateGuestModelFallback', () => {
  const fallback = {
    model: model('claude-haiku-5.5'),
    gatewayId: 'anthropic/claude-haiku-5.5',
    label: 'Claude Haiku 5.5',
    access: 'now' as const,
  };

  it('confirms a still-available row', () => {
    expect(
      revalidateGuestModelFallback(fallback, [row('claude-haiku-5.5')]),
    ).toEqual({ kind: 'available', model: 'claude-haiku-5.5' });
  });

  it('hands a now-recoverable row to its own recovery', () => {
    expect(
      revalidateGuestModelFallback(fallback, [
        row('claude-haiku-5.5', {
          kind: 'recoverable',
          recovery: { kind: 'needs-credits' },
        }),
      ]),
    ).toEqual({
      kind: 'recoverable',
      model: 'claude-haiku-5.5',
      recovery: { kind: 'needs-credits' },
    });
  });

  it('blocks a removed, disabled, or re-routed row', () => {
    expect(revalidateGuestModelFallback(fallback, [])).toEqual({
      kind: 'blocked',
    });
    expect(
      revalidateGuestModelFallback(fallback, [
        row('claude-haiku-5.5', {
          kind: 'hard-disabled',
          cause: 'org-policy',
          reason: 'Blocked by your organization.',
        }),
      ]),
    ).toEqual({ kind: 'blocked', reason: 'Blocked by your organization.' });
    expect(
      revalidateGuestModelFallback(fallback, [
        row('claude-haiku-5.5', { kind: 'available' }, 'other-route'),
      ]),
    ).toEqual({ kind: 'blocked' });
  });

  it('blocks a changed selection before redirecting to recovery', () => {
    expect(
      revalidateGuestModelFallback(fallback, [
        row(
          'claude-haiku-5.5',
          {
            kind: 'recoverable',
            recovery: { kind: 'needs-credits' },
          },
          'other-route',
        ),
      ]),
    ).toEqual({ kind: 'blocked' });
  });
});
