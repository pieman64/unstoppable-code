import type {
  AgentAuditEntry,
  AgentAuditToolCounts,
} from '@canopy/desktop-shared/types';
import {
  entriesToCsv,
  formatAuditCostLabel,
  formatRequestedSpeed,
  observedCostUnavailableMessage,
} from '../auditTrailCost';

// Derived from the re-exported `AgentAuditEntry` so the test never depends on
// the named `AgentObservedCost` type being re-exported through the barrel
// (the transport slice owns that surface).
type ObservedCost = NonNullable<AgentAuditEntry['observedCost']>;

const ZERO_TOOL_COUNTS: AgentAuditToolCounts = {
  thinking: 0,
  bash: 0,
  read: 0,
  readLines: 0,
  writeEdit: 0,
  plan: 0,
  fileEdit: 0,
  fileAdd: 0,
  fileDelete: 0,
  search: 0,
  grep: 0,
  web: 0,
  agent: 0,
  workflow: 0,
  tasks: 0,
  taskStop: 0,
  skills: 0,
  monitor: 0,
  claude: 0,
  scheduleWakeup: 0,
  askUser: 0,
  scriptOutput: 0,
  watcher: 0,
  canopy: 0,
  appAdvisor: 0,
  mcp: 0,
  other: 0,
};

function makeEntry(overrides: Partial<AgentAuditEntry> = {}): AgentAuditEntry {
  return {
    id: 'entry-1',
    eventType: 'worktree_chat',
    status: 'success',
    provider: 'codex',
    label: 'Test turn',
    startedAt: '2026-06-18T00:00:00.000Z',
    tokens: {
      input: 100,
      output: 50,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    },
    messageCount: 1,
    assistantMessageCount: 1,
    toolUseCount: 0,
    subAgentCount: 0,
    toolCounts: { ...ZERO_TOOL_COUNTS },
    hasTranscript: false,
    ...overrides,
  };
}

function unpricedCost(reason: ObservedCost['reason']): ObservedCost {
  return {
    status: 'unpriced',
    reason,
    currency: 'usd',
    components: [],
  };
}

/**
 * A requested Ultra fast turn with two web-search calls whose explicit outcome
 * is unpriced, persisted beside a stale flat total from an older Standard
 * estimate: $0.0035 of tokens plus a $0.02 web-search surcharge.
 */
function staleUltraFastWebSearchEntry(): AgentAuditEntry {
  return makeEntry({
    id: 'stale-ultra-fast',
    provider: 'codex',
    model: 'gpt-6-astra',
    serviceTier: 'ultrafast',
    billableToolCounts: { openAiWebSearchCalls: 2 },
    totalCostUsd: 0.0235,
    observedCost: {
      ...unpricedCost('unsupported_service_tier'),
      model: 'gpt-6-astra',
      serviceTier: 'ultrafast',
      components: [
        {
          kind: 'unpriced_tokens',
          label: 'Codex token usage',
          reason: 'unsupported_service_tier',
        },
        {
          kind: 'unpriced_tool',
          label: 'OpenAI web search calls',
          quantity: 2,
          unit: 'calls',
          reason: 'unsupported_service_tier',
        },
      ],
    },
  });
}

describe('observedCostUnavailableMessage', () => {
  test('maps model_not_priced to the API-pricing-basis sentence', () => {
    expect(observedCostUnavailableMessage('model_not_priced')).toBe(
      'Cost unavailable: no published API pricing basis for this Codex model.',
    );
  });

  test('maps pricing_unavailable to the load-failure sentence', () => {
    expect(observedCostUnavailableMessage('pricing_unavailable')).toBe(
      'Cost unavailable: pricing data could not be loaded.',
    );
  });

  test('maps billable_tool_pricing_unavailable to the partial-pricing sentence', () => {
    expect(
      observedCostUnavailableMessage('billable_tool_pricing_unavailable'),
    ).toBe(
      'Cost partially unavailable: billable tool pricing could not be loaded.',
    );
  });

  test('maps unsupported_fast_pricing to the Fast-mode sentence', () => {
    expect(observedCostUnavailableMessage('unsupported_fast_pricing')).toBe(
      'Cost unavailable: Fast mode pricing is not published for this model.',
    );
  });

  test('maps unsupported_service_tier to the missing speed rates sentence', () => {
    expect(observedCostUnavailableMessage('unsupported_service_tier')).toBe(
      'Cost unavailable: pricing data has no rates for the requested speed.',
    );
  });

  test('names Ultra fast when its exact rates are missing', () => {
    expect(
      observedCostUnavailableMessage('unsupported_service_tier', 'ultrafast'),
    ).toBe('Cost unavailable: pricing data has no rates for Ultra fast.');
  });

  test.each([
    'model_missing',
    'unsupported_usage_shape',
    'invalid_pricing_payload',
  ] as const)('maps %s to a generic non-misleading message', (reason) => {
    const message = observedCostUnavailableMessage(reason);
    expect(message).toBe(
      'Cost unavailable: cost could not be determined for this Codex turn.',
    );
    // Never renders a misleading `$0`.
    expect(message.startsWith('Cost unavailable')).toBe(true);
  });
});

describe('formatAuditCostLabel', () => {
  test('priced turn renders $X.XXXX (4 dp)', () => {
    const entry = makeEntry({
      provider: 'codex',
      totalCostUsd: 1.23456,
      observedCost: {
        status: 'priced',
        reason: 'priced',
        currency: 'usd',
        totalUsd: 1.23456,
        components: [],
      },
    });
    expect(formatAuditCostLabel(entry)).toBe('$1.2346');
  });

  test('organization gateway turns never render a dollar estimate', () => {
    expect(
      formatAuditCostLabel(
        makeEntry({
          provider: 'codex',
          modelGatewayRouted: true,
          totalCostUsd: 1.25,
          observedCost: {
            status: 'priced',
            reason: 'priced',
            currency: 'usd',
            totalUsd: 1.25,
            components: [],
          },
        }),
      ),
    ).toBeNull();
  });

  test('unpriced Codex turn renders Cost unavailable + reason copy', () => {
    const entry = makeEntry({
      provider: 'codex',
      totalCostUsd: undefined,
      observedCost: unpricedCost('model_not_priced'),
    });
    expect(formatAuditCostLabel(entry)).toBe(
      'Cost unavailable: no published API pricing basis for this Codex model.',
    );
  });

  test('partially priced Codex turn renders partial unavailable copy before dollar total', () => {
    const entry = makeEntry({
      provider: 'codex',
      totalCostUsd: 0.5,
      observedCost: {
        status: 'partially_priced',
        reason: 'billable_tool_pricing_unavailable',
        currency: 'usd',
        totalUsd: 0.5,
        components: [],
      },
    });
    expect(formatAuditCostLabel(entry)).toBe(
      'Cost partially unavailable: billable tool pricing could not be loaded.',
    );
  });

  test('partially priced Codex turn with unpriced tokens renders partial model copy', () => {
    const entry = makeEntry({
      provider: 'codex',
      totalCostUsd: 0.5,
      observedCost: {
        status: 'partially_priced',
        reason: 'model_not_priced',
        currency: 'usd',
        totalUsd: 0.5,
        components: [],
      },
    });
    expect(formatAuditCostLabel(entry)).toBe(
      'Cost partially unavailable: no published API pricing basis for this Codex model.',
    );
  });

  test('Ollama turn still renders Cost N/A', () => {
    const entry = makeEntry({
      provider: 'ollama',
      totalCostUsd: undefined,
      observedCost: undefined,
    });
    expect(formatAuditCostLabel(entry)).toBe('Cost N/A');
  });

  test('Codex turn with no observedCost still renders Cost N/A', () => {
    const entry = makeEntry({
      provider: 'codex',
      totalCostUsd: undefined,
      observedCost: undefined,
    });
    expect(formatAuditCostLabel(entry)).toBe('Cost N/A');
  });

  test('Claude turn without a cost renders no cost cell', () => {
    const entry = makeEntry({
      provider: 'claude',
      totalCostUsd: undefined,
      observedCost: undefined,
    });
    expect(formatAuditCostLabel(entry)).toBeNull();
  });

  test('priced label wins even when observedCost is present', () => {
    const entry = makeEntry({
      provider: 'codex',
      totalCostUsd: 0.5,
      observedCost: {
        status: 'priced',
        reason: 'priced',
        currency: 'usd',
        totalUsd: 0.5,
        components: [],
      },
    });
    expect(formatAuditCostLabel(entry)).toBe('$0.5000');
  });

  test('requested Ultra fast turn without exact rates stays unpriced', () => {
    const entry = makeEntry({
      provider: 'codex',
      serviceTier: 'ultrafast',
      totalCostUsd: undefined,
      observedCost: {
        ...unpricedCost('unsupported_service_tier'),
        serviceTier: 'ultrafast',
      },
    });
    expect(formatAuditCostLabel(entry)).toBe(
      'Cost unavailable: pricing data has no rates for Ultra fast.',
    );
  });

  test('unrecognized requested speed renders the generic speed sentence', () => {
    const entry = makeEntry({
      provider: 'codex',
      serviceTier: 'flex',
      totalCostUsd: undefined,
      observedCost: {
        ...unpricedCost('unsupported_service_tier'),
        serviceTier: 'flex',
      },
    });
    expect(formatAuditCostLabel(entry)).toBe(
      'Cost unavailable: pricing data has no rates for the requested speed.',
    );
  });

  test.each([
    [
      'unsupported_service_tier',
      'ultrafast',
      0.014225,
      'Cost unavailable: pricing data has no rates for Ultra fast.',
    ],
    [
      'unsupported_fast_pricing',
      'priority',
      0.02445,
      'Cost unavailable: Fast mode pricing is not published for this model.',
    ],
    [
      'model_not_priced',
      'default',
      0.012225,
      'Cost unavailable: no published API pricing basis for this Codex model.',
    ],
  ] as const)(
    'explicit unpriced %s outcome for a %p request hides a stale total of %p',
    (reason, serviceTier, staleTotalUsd, expected) => {
      const entry = makeEntry({
        provider: 'codex',
        serviceTier,
        totalCostUsd: staleTotalUsd,
        observedCost: { ...unpricedCost(reason), serviceTier },
      });

      const label = formatAuditCostLabel(entry);

      expect(label).toBe(expected);
      expect(label).not.toContain('$');
    },
  );

  test('unsupported tier with billable web-search calls shows no Standard tool surcharge', () => {
    const label = formatAuditCostLabel(staleUltraFastWebSearchEntry());

    expect(label).toBe(
      'Cost unavailable: pricing data has no rates for Ultra fast.',
    );
    expect(label).not.toContain('$');
  });

  test('provider-reported cost without an observed outcome still renders dollars', () => {
    const entry = makeEntry({
      provider: 'claude',
      totalCostUsd: 0.25,
      observedCost: undefined,
    });
    expect(formatAuditCostLabel(entry)).toBe('$0.2500');
  });
});

describe('formatRequestedSpeed', () => {
  test.each([
    ['ultrafast', 'Requested Ultra fast'],
    ['priority', 'Requested Fast'],
    ['fast', 'Requested Fast'],
    ['flex', 'Requested flex'],
  ])(
    'reports the %p request as %p with the actual tier unreported',
    (serviceTier, requested) => {
      expect(formatRequestedSpeed(makeEntry({ serviceTier }))).toEqual({
        requested,
        actual: 'Actual tier unreported',
      });
    },
  );

  test.each([undefined, '', 'default', 'standard'])(
    'omits the Regular or missing request %p',
    (serviceTier) => {
      expect(formatRequestedSpeed(makeEntry({ serviceTier }))).toBeNull();
    },
  );
});

describe('entriesToCsv', () => {
  test('header includes the new observed-cost columns after Total Cost (USD)', () => {
    const [header] = entriesToCsv([]).split('\n');
    const columns = header.split(',');
    const totalCostIndex = columns.indexOf('Total Cost (USD)');
    expect(totalCostIndex).toBeGreaterThanOrEqual(0);
    expect(columns.slice(totalCostIndex, totalCostIndex + 6)).toEqual([
      'Total Cost (USD)',
      'Observed Cost Status',
      'Observed Cost Reason',
      'Token Cost (USD)',
      'Non-Token Cost (USD)',
      'Pricing Basis',
    ]);
  });

  test('priced entry exports observed-cost detail columns', () => {
    const entry = makeEntry({
      id: 'priced',
      provider: 'codex',
      totalCostUsd: 0.123456,
      observedCost: {
        status: 'priced',
        reason: 'priced',
        currency: 'usd',
        totalUsd: 0.123456,
        tokenUsd: 0.1,
        nonTokenUsd: 0.023456,
        pricingBasis: 'openai_api_standard',
        components: [],
      },
    });
    const lines = entriesToCsv([entry]).split('\n');
    const columns = lines[0].split(',');
    const values = lines[1].split(',');
    const at = (name: string): string => values[columns.indexOf(name)];

    expect(at('Total Cost (USD)')).toBe('0.123456');
    expect(at('Observed Cost Status')).toBe('priced');
    expect(at('Observed Cost Reason')).toBe('priced');
    expect(at('Token Cost (USD)')).toBe('0.100000');
    expect(at('Non-Token Cost (USD)')).toBe('0.023456');
    expect(at('Pricing Basis')).toBe('openai_api_standard');
  });

  test('unpriced entry exports status/reason and leaves cost columns blank', () => {
    const entry = makeEntry({
      id: 'unpriced',
      provider: 'codex',
      totalCostUsd: undefined,
      observedCost: unpricedCost('model_not_priced'),
    });
    const lines = entriesToCsv([entry]).split('\n');
    const columns = lines[0].split(',');
    const values = lines[1].split(',');
    const at = (name: string): string => values[columns.indexOf(name)];

    expect(at('Total Cost (USD)')).toBe('');
    expect(at('Observed Cost Status')).toBe('unpriced');
    expect(at('Observed Cost Reason')).toBe('model_not_priced');
    expect(at('Token Cost (USD)')).toBe('');
    expect(at('Non-Token Cost (USD)')).toBe('');
    expect(at('Pricing Basis')).toBe('');
  });

  test('explicitly unpriced entry exports no stale total or Standard tool surcharge', () => {
    const lines = entriesToCsv([staleUltraFastWebSearchEntry()]).split('\n');
    const columns = lines[0].split(',');
    const values = lines[1].split(',');
    const at = (name: string): string => values[columns.indexOf(name)];

    expect(at('Total Cost (USD)')).toBe('');
    expect(at('Observed Cost Status')).toBe('unpriced');
    expect(at('Observed Cost Reason')).toBe('unsupported_service_tier');
    expect(at('Token Cost (USD)')).toBe('');
    expect(at('Non-Token Cost (USD)')).toBe('');
    expect(at('Pricing Basis')).toBe('');
  });

  test('AI Credits Routed column follows the observed-cost columns', () => {
    const [header] = entriesToCsv([]).split('\n');
    const columns = header.split(',');
    expect(columns.indexOf('AI Credits Routed')).toBe(
      columns.indexOf('Pricing Basis') + 1,
    );
  });

  test('routed entry exports "Yes" for AI Credits Routed', () => {
    const entry = makeEntry({
      id: 'routed',
      provider: 'claude',
      aiCreditsRouted: true,
    });
    const lines = entriesToCsv([entry]).split('\n');
    const columns = lines[0].split(',');
    const values = lines[1].split(',');
    expect(values[columns.indexOf('AI Credits Routed')]).toBe('Yes');
  });

  test('non-routed entry leaves AI Credits Routed blank', () => {
    const entry = makeEntry({
      id: 'native',
      provider: 'claude',
      aiCreditsRouted: undefined,
    });
    const lines = entriesToCsv([entry]).split('\n');
    const columns = lines[0].split(',');
    const values = lines[1].split(',');
    expect(values[columns.indexOf('AI Credits Routed')]).toBe('');
  });

  test('organization gateway entry exports tokens but no dollar or AI Credits claim', () => {
    const entry = makeEntry({
      id: 'org-gateway',
      provider: 'codex',
      modelGatewayRouted: true,
      aiCreditsRouted: true,
      totalCostUsd: 2.5,
      tokens: {
        input: 12,
        output: 7,
        cacheReadInputTokens: 3,
        cacheCreationInputTokens: 0,
      },
    });
    const lines = entriesToCsv([entry]).split('\n');
    const columns = lines[0].split(',');
    const values = lines[1].split(',');
    expect(values[columns.indexOf('Input Tokens')]).toBe('12');
    expect(values[columns.indexOf('Total Cost (USD)')]).toBe('');
    expect(values[columns.indexOf('AI Credits Routed')]).toBe('');
  });

  test('entry without observedCost keeps its reported total and leaves observed-cost columns blank', () => {
    const entry = makeEntry({
      id: 'legacy',
      provider: 'claude',
      totalCostUsd: 0.25,
      observedCost: undefined,
    });
    const lines = entriesToCsv([entry]).split('\n');
    const columns = lines[0].split(',');
    const values = lines[1].split(',');
    const at = (name: string): string => values[columns.indexOf(name)];

    expect(at('Total Cost (USD)')).toBe('0.250000');
    expect(at('Observed Cost Status')).toBe('');
    expect(at('Observed Cost Reason')).toBe('');
    expect(at('Token Cost (USD)')).toBe('');
    expect(at('Non-Token Cost (USD)')).toBe('');
    expect(at('Pricing Basis')).toBe('');
  });
});
