import {
  normalizeOrgEnforcedPolicy,
  normalizeOrgEnforcedSettings,
  normalizeOrgEnforcedSettingsWithStatus,
} from '../org-enforced-parsing';
import { isModelBlocked, resolveModelPolicy } from '../model-policy';

describe('normalizeOrgEnforcedPolicy', () => {
  const gatewayModel = {
    id: 'acme-qwen3-coder',
    gatewayId: 'vertex/qwen3-coder',
    label: 'Acme Qwen 3 Coder',
    harness: 'codex',
    contextWindow: 262_144,
    supportedThinkingLevels: ['low', 'high'],
    toolSchemaProfile: 'flat',
  };

  it('normalizes a bounded HTTPS model gateway and defaults cache passthrough on', () => {
    expect(
      normalizeOrgEnforcedPolicy({
        kind: 'model-gateway',
        baseUrl: 'https://gateway.acme.test/v1',
        models: [gatewayModel],
        enforced: true,
      }),
    ).toEqual({
      kind: 'model-gateway',
      baseUrl: 'https://gateway.acme.test',
      models: [gatewayModel],
      enforced: true,
      promptCachePassthrough: true,
    });
  });

  it.each([
    ['non-HTTPS URL', { baseUrl: 'http://gateway.acme.test' }],
    ['duplicate selection id', { models: [gatewayModel, gatewayModel] }],
    [
      'duplicate label',
      {
        models: [
          gatewayModel,
          { ...gatewayModel, id: 'acme-other', gatewayId: 'vertex/other' },
        ],
      },
    ],
    ['malformed cache toggle', { promptCachePassthrough: 'yes' }],
  ])('drops a malformed model gateway: %s', (_label, override) => {
    expect(
      normalizeOrgEnforcedPolicy({
        kind: 'model-gateway',
        baseUrl: 'https://gateway.acme.test',
        models: [gatewayModel],
        enforced: false,
        ...override,
      }),
    ).toBeNull();
  });

  it('canonicalizes a gateway base URL before routing', () => {
    expect(
      normalizeOrgEnforcedPolicy({
        kind: 'model-gateway',
        baseUrl: ' https://GATEWAY.Acme.Test:443/prefix/ ',
        models: [gatewayModel],
        enforced: false,
      }),
    ).toMatchObject({ baseUrl: 'https://gateway.acme.test/prefix' });
  });

  it('keeps a well-formed model policy and de-duplicates its ids', () => {
    expect(
      normalizeOrgEnforcedPolicy({
        kind: 'model-policy',
        blockedModelIds: ['a', 'a', 'b'],
        reviewedModelIds: ['c', 'c'],
      }),
    ).toEqual({
      kind: 'model-policy',
      blockedModelIds: ['a', 'b'],
      reviewedModelIds: ['c'],
    });
  });

  it('drops unknown policy kinds and non-records', () => {
    expect(normalizeOrgEnforcedPolicy({ kind: 'not-a-real-kind' })).toBeNull();
    expect(normalizeOrgEnforcedPolicy(null)).toBeNull();
    expect(normalizeOrgEnforcedPolicy('model-policy')).toBeNull();
  });

  // A dropped model policy leaves the member completely unrestricted, which is
  // the opposite of every other degraded path in this feature. A recognized but
  // malformed model policy must survive as "nothing reviewed" so that the
  // absent-from-reviewed rule denies rather than permits.
  it.each([
    ['missing arrays', { kind: 'model-policy' }],
    [
      'non-array fields',
      { kind: 'model-policy', blockedModelIds: 'a', reviewedModelIds: 7 },
    ],
    [
      'non-string members',
      {
        kind: 'model-policy',
        blockedModelIds: [1, null],
        reviewedModelIds: [{}, false],
      },
    ],
  ])('fails closed on a malformed model policy (%s)', (_label, value) => {
    expect(normalizeOrgEnforcedPolicy(value)).toEqual({
      kind: 'model-policy',
      blockedModelIds: [],
      reviewedModelIds: [],
    });
  });

  it('keeps the usable ids when only some entries are malformed', () => {
    expect(
      normalizeOrgEnforcedPolicy({
        kind: 'model-policy',
        blockedModelIds: ['good', 42],
        reviewedModelIds: [null, 'also-good'],
      }),
    ).toEqual({
      kind: 'model-policy',
      blockedModelIds: ['good'],
      reviewedModelIds: ['also-good'],
    });
  });
});

describe('malformed model policy end to end', () => {
  it('blocks a model instead of vanishing into an unrestricted account', () => {
    const settings = normalizeOrgEnforcedSettings([
      {
        organizationId: 'org-1',
        organizationName: 'Acme',
        policies: [{ kind: 'model-policy', blockedModelIds: 'oops' }],
      },
    ]);

    const policy = resolveModelPolicy({
      enforcedSettings: settings,
    });

    expect(policy.size).toBeGreaterThan(0);
    expect(isModelBlocked('claude-sonnet-4-6', policy)).toBe(true);
  });
});

describe('malformed enforced model gateway end to end', () => {
  const validModel = {
    id: 'acme-qwen',
    gatewayId: 'vertex/qwen',
    label: 'Acme Qwen',
    harness: 'codex',
    contextWindow: 131_072,
    supportedThinkingLevels: ['low'],
    toolSchemaProfile: 'flat',
  };

  it.each([
    ['query string', { baseUrl: 'https://gateway.acme.test?tenant=acme' }],
    ['fragment', { baseUrl: 'https://gateway.acme.test#tenant' }],
    ['malformed model', { models: [{ ...validModel, contextWindow: 0 }] }],
    ['malformed enforcement type', { enforced: 'yes' }],
    ['oversized catalog', { models: Array(101).fill(validModel) }],
  ])('preserves the fail-closed boundary for a %s', (_label, override) => {
    const settings = normalizeOrgEnforcedSettings([
      {
        organizationId: 'org-1',
        organizationName: 'Acme',
        policies: [
          {
            kind: 'model-gateway',
            baseUrl: 'https://gateway.acme.test',
            models: [validModel],
            enforced: true,
            ...override,
          },
        ],
      },
    ]);

    expect(settings).toEqual([
      expect.objectContaining({
        organizationId: 'org-1',
        modelGatewayEnforcementUnavailable: true,
      }),
    ]);
  });

  it('does not preserve degraded enforcement for an explicitly additive policy', () => {
    const settings = normalizeOrgEnforcedSettings([
      {
        organizationId: 'org-1',
        organizationName: 'Acme',
        policies: [
          {
            kind: 'model-gateway',
            baseUrl: 'https://gateway.acme.test?tenant=acme',
            models: [validModel],
            enforced: false,
          },
        ],
      },
    ]);

    expect(settings[0]).not.toHaveProperty(
      'modelGatewayEnforcementUnavailable',
    );
  });

  it('retains degraded enforcement when normalized account state is read again', () => {
    const once = normalizeOrgEnforcedSettings([
      {
        organizationId: 'org-1',
        organizationName: 'Acme',
        policies: [
          {
            kind: 'model-gateway',
            baseUrl: 'https://gateway.acme.test?tenant=acme',
            models: [validModel],
            enforced: true,
          },
        ],
      },
    ]);

    expect(normalizeOrgEnforcedSettings(once)).toEqual(once);
  });

  it('retains enforced intent when the organization envelope is malformed', () => {
    expect(
      normalizeOrgEnforcedSettingsWithStatus([
        {
          organizationId: 42,
          organizationName: 'Acme',
          policies: [
            {
              kind: 'model-gateway',
              baseUrl: 'https://gateway.acme.test',
              models: [validModel],
              enforced: true,
            },
          ],
        },
      ]),
    ).toEqual({
      settings: [],
      modelGatewayEnforcementUnavailable: true,
      telemetryEnforcementUnavailable: true,
    });
  });

  it('retains enforced intent when the top-level container is a record', () => {
    expect(
      normalizeOrgEnforcedSettingsWithStatus({
        organizationId: 'org-1',
        organizationName: 'Acme',
        policies: [
          {
            kind: 'model-gateway',
            baseUrl: 'https://gateway.acme.test',
            models: [validModel],
            enforced: true,
          },
        ],
      }),
    ).toEqual({
      settings: [],
      modelGatewayEnforcementUnavailable: true,
      telemetryEnforcementUnavailable: true,
    });
  });

  it('retains enforced intent in a numeric-keyed record envelope', () => {
    expect(
      normalizeOrgEnforcedSettingsWithStatus({
        0: {
          organizationId: 'org-1',
          organizationName: 'Acme',
          policies: [
            {
              kind: 'model-gateway',
              baseUrl: 'https://gateway.acme.test',
              models: [validModel],
              enforced: true,
            },
          ],
        },
      }),
    ).toEqual({
      settings: [],
      modelGatewayEnforcementUnavailable: true,
      telemetryEnforcementUnavailable: true,
    });
  });

  it('bounds numeric-record inspection without reading beyond the limit', () => {
    const envelope: Record<string, unknown> = {};
    for (let index = 0; index < 100; index += 1) {
      Object.defineProperty(envelope, String(index), {
        enumerable: true,
        value: {},
      });
    }
    const outOfBoundsGetter = jest.fn(() => {
      throw new Error('out-of-bounds record value was read');
    });
    Object.defineProperty(envelope, '100', {
      enumerable: true,
      get: outOfBoundsGetter,
    });

    expect(normalizeOrgEnforcedSettingsWithStatus(envelope)).toEqual({
      settings: [],
      modelGatewayEnforcementUnavailable: true,
      telemetryEnforcementUnavailable: true,
    });
    expect(outOfBoundsGetter).not.toHaveBeenCalled();
  });

  it('retains enforced intent from a malformed policy container', () => {
    expect(
      normalizeOrgEnforcedSettingsWithStatus([
        {
          organizationId: 'org-1',
          organizationName: 'Acme',
          policies: {
            kind: 'model-gateway',
            baseUrl: 'https://gateway.acme.test',
            models: [validModel],
            enforced: true,
          },
        },
      ]),
    ).toEqual({
      settings: [
        {
          organizationId: 'org-1',
          organizationName: 'Acme',
          policies: [],
        },
      ],
      modelGatewayEnforcementUnavailable: true,
      telemetryEnforcementUnavailable: true,
    });
  });
});

it('retains unavailable telemetry enforcement rather than normalizing malformed consent policy into permission', () => {
  expect(
    normalizeOrgEnforcedSettingsWithStatus(undefined)
      .telemetryEnforcementUnavailable,
  ).toBe(true);
  expect(
    normalizeOrgEnforcedSettingsWithStatus([]).telemetryEnforcementUnavailable,
  ).not.toBe(true);
  expect(
    normalizeOrgEnforcedSettingsWithStatus([
      {
        organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        organizationName: 'A',
        policies: [
          {
            kind: 'telemetry-sync',
            scopes: {},
            prohibitedScopes: { metadata: 'true' },
          },
        ],
      },
    ]).telemetryEnforcementUnavailable,
  ).toBe(true);
});
