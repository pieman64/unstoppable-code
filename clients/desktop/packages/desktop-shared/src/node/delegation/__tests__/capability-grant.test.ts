import {
  DELEGATION_CAPABILITY_LIMITS,
  isDelegationCapabilitySummary,
} from '@canopy/protocol/delegation';
import {
  delegationCapabilityDisplayName,
  isDelegationCapabilityId,
  resolveDelegationCapabilityDiscovery,
  summarizeDelegationCapabilities,
  type DelegationCapabilitySummaryInput,
} from '../capability-grant';

function itemsFixture(
  count: number,
): DelegationCapabilitySummaryInput['items'] {
  return Array.from({ length: count }, (_, index) => ({
    kind: 'skill' as const,
    name: `item-${index}`,
    source: 'agent' as const,
  }));
}

function skippedFixture(
  count: number,
): DelegationCapabilitySummaryInput['skipped'] {
  return Array.from({ length: count }, (_, index) => ({
    kind: 'plugin' as const,
    name: `skipped-${index}`,
    reason: 'missing_selection' as const,
  }));
}

function capabilityId(fill: string): string {
  return `deferred:v1:${fill.repeat(43).slice(0, 43)}`;
}

describe('summarizeDelegationCapabilities', () => {
  it('bounds items to the summary limit and records the omitted count', () => {
    const result = summarizeDelegationCapabilities({
      inherit: true,
      discovery: false,
      items: itemsFixture(129),
      skipped: [],
    });
    expect(result.items).toHaveLength(128);
    expect(result.omittedItems).toBe(1);
    expect(result).not.toHaveProperty('omittedSkipped');
    expect(isDelegationCapabilitySummary(result)).toBe(true);
  });

  it('bounds skipped entries to the summary limit and records the omitted count', () => {
    const result = summarizeDelegationCapabilities({
      inherit: false,
      discovery: true,
      items: [],
      skipped: skippedFixture(65),
    });
    expect(result.skipped).toHaveLength(64);
    expect(result.omittedSkipped).toBe(1);
    expect(result).not.toHaveProperty('omittedItems');
    expect(isDelegationCapabilitySummary(result)).toBe(true);
  });

  it('omits both overflow counters entirely when within bounds', () => {
    const result = summarizeDelegationCapabilities({
      inherit: true,
      discovery: true,
      items: itemsFixture(2),
      skipped: skippedFixture(1),
    });
    expect(result).not.toHaveProperty('omittedItems');
    expect(result).not.toHaveProperty('omittedSkipped');
    expect(isDelegationCapabilitySummary(result)).toBe(true);
  });

  it('folds an embedded newline into a single-line item name', () => {
    const result = summarizeDelegationCapabilities({
      inherit: true,
      discovery: false,
      items: [
        { kind: 'skill', name: 'First line\nSecond line', source: 'agent' },
      ],
      skipped: [],
    });
    expect(result.items[0]?.name).toBe('First line Second line');
  });

  it('passes isDelegationCapabilitySummary for a populated result', () => {
    const result = summarizeDelegationCapabilities({
      inherit: true,
      discovery: false,
      items: [{ kind: 'mcp', name: 'Search Server', source: 'inherited' }],
      skipped: [
        { kind: 'skill', name: 'Blocked Skill', reason: 'unsupported_hooks' },
      ],
    });
    expect(isDelegationCapabilitySummary(result)).toBe(true);
  });
});

describe('delegationCapabilityDisplayName', () => {
  it('collapses embedded newlines into a single line', () => {
    expect(
      delegationCapabilityDisplayName('Line one\r\nLine two\nLine three'),
    ).toBe('Line one Line two Line three');
  });

  it('truncates an overlong name to exactly the character limit with an ellipsis', () => {
    const long = 'x'.repeat(250);
    const result = delegationCapabilityDisplayName(long);
    expect(result).toHaveLength(DELEGATION_CAPABILITY_LIMITS.nameCharacters);
    expect(result.endsWith('…')).toBe(true);
    expect(result).toBe(
      `${'x'.repeat(DELEGATION_CAPABILITY_LIMITS.nameCharacters - 1)}…`,
    );
  });

  it('leaves a name at exactly the limit unchanged', () => {
    const exact = 'y'.repeat(DELEGATION_CAPABILITY_LIMITS.nameCharacters);
    expect(delegationCapabilityDisplayName(exact)).toBe(exact);
  });
});

describe('resolveDelegationCapabilityDiscovery', () => {
  describe('root caller (callerDepth 0)', () => {
    it.each([
      [true, undefined, true],
      [true, true, true],
      [true, false, false],
      [false, undefined, false],
      [false, true, false],
      [false, false, false],
      [undefined, undefined, false],
      [undefined, true, false],
      [undefined, false, false],
    ] as const)(
      'rootDeferredToolsAllowed=%p requested=%p -> %p',
      (rootDeferredToolsAllowed, requested, expected) => {
        expect(
          resolveDelegationCapabilityDiscovery({
            callerDepth: 0,
            rootDeferredToolsAllowed,
            parentGrant: undefined,
            requested,
          }),
        ).toBe(expected);
      },
    );
  });

  describe('nested caller (callerDepth 1)', () => {
    it.each([
      [{ discovery: true }, undefined, true],
      [{ discovery: true }, true, true],
      [{ discovery: true }, false, false],
      [{ discovery: false }, undefined, false],
      [{ discovery: false }, true, false],
      [{ discovery: false }, false, false],
      [undefined, undefined, false],
      [undefined, true, false],
      [undefined, false, false],
    ] as const)(
      'parentGrant=%p requested=%p -> %p',
      (parentGrant, requested, expected) => {
        expect(
          resolveDelegationCapabilityDiscovery({
            callerDepth: 1,
            rootDeferredToolsAllowed: undefined,
            parentGrant,
            requested,
          }),
        ).toBe(expected);
      },
    );
  });
});

describe('isDelegationCapabilityId', () => {
  it('accepts a real deferred-catalog reference shape', () => {
    expect(isDelegationCapabilityId(capabilityId('A'))).toBe(true);
  });

  it('rejects a 64-character hex string', () => {
    expect(isDelegationCapabilityId('a'.repeat(64))).toBe(false);
  });

  it('rejects the wrong catalog version prefix', () => {
    expect(isDelegationCapabilityId(`deferred:v2:${'A'.repeat(43)}`)).toBe(
      false,
    );
  });

  it('rejects a reference one character short', () => {
    expect(isDelegationCapabilityId(`deferred:v1:${'A'.repeat(42)}`)).toBe(
      false,
    );
  });

  it('rejects a reference one character long', () => {
    expect(isDelegationCapabilityId(`deferred:v1:${'A'.repeat(44)}`)).toBe(
      false,
    );
  });

  it.each([[undefined], [null], [123], [{}], [[]]] as const)(
    'rejects a non-string value (%p)',
    (value) => {
      expect(isDelegationCapabilityId(value)).toBe(false);
    },
  );
});
