import {
  matchInvocationEntry,
  normalizeInvocationToken,
} from '../plugins/invocation-prefix-normalizer';

const codexStandaloneSkill = {
  invocationKey: '$builtin-app-plugin:review',
  kind: 'skill' as const,
  name: 'review',
};

const claudeStandaloneSkill = {
  invocationKey: '/review',
  kind: 'skill' as const,
  name: 'review',
};

describe('normalizeInvocationToken', () => {
  it('rewrites a standalone Codex skill tail alias to its namespaced invocation key', () => {
    expect(normalizeInvocationToken('/review', [codexStandaloneSkill])).toBe(
      '$builtin-app-plugin:review',
    );
  });

  it.each(['$builtin-app-plugin:review', '$review'])(
    'rewrites the Codex-style alias %s to a standalone Claude skill',
    (text) => {
      expect(normalizeInvocationToken(text, [claudeStandaloneSkill])).toBe(
        '/review',
      );
    },
  );

  it('does not swap namespaces when a qualified token has no exact match', () => {
    expect(
      normalizeInvocationToken('/other:review', [
        {
          invocationKey: '/acme:review',
          kind: 'skill',
          name: 'review',
        },
      ]),
    ).toBe('/other:review');
  });

  it.each([
    {
      text: '/compact',
      entry: {
        invocationKey: '/myplugin:compact',
        kind: 'plugin_command' as const,
        name: 'compact',
      },
    },
    {
      text: '$compact',
      entry: {
        invocationKey: '$myplugin:compact',
        kind: 'plugin_command' as const,
        name: 'compact',
      },
    },
  ])(
    'does not let a plugin member capture the bare token $text',
    ({ text, entry }) => {
      expect(normalizeInvocationToken(text, [entry])).toBe(text);
    },
  );

  it('tail-resolves a qualified token only to a bare standalone skill', () => {
    expect(
      normalizeInvocationToken('$builtin-app-plugin:review', [
        claudeStandaloneSkill,
      ]),
    ).toBe('/review');
  });

  it('never collapses a non-aggregate namespace to a bare standalone skill', () => {
    // An explicit namespace outside the aggregate plugin is the user's choice;
    // dropping it would invoke a skill the user did not qualify.
    expect(
      normalizeInvocationToken('/other-plugin:review', [claudeStandaloneSkill]),
    ).toBe('/other-plugin:review');
    expect(
      normalizeInvocationToken('$other-plugin:review', [claudeStandaloneSkill]),
    ).toBe('$other-plugin:review');
  });

  it('does not expand a bare token from a qualified plugin member', () => {
    expect(
      normalizeInvocationToken('/review', [
        {
          ...codexStandaloneSkill,
          kind: 'plugin_skill',
        },
      ]),
    ).toBe('/review');
  });

  it.each([
    {
      text: '/plugin:skill run this',
      entry: {
        invocationKey: '$plugin:skill',
        kind: 'plugin_skill' as const,
        name: 'skill',
      },
      expected: '$plugin:skill run this',
    },
    {
      text: '$plugin:skill run this',
      entry: {
        invocationKey: '/plugin:skill',
        kind: 'plugin_skill' as const,
        name: 'skill',
      },
      expected: '/plugin:skill run this',
    },
  ])(
    'rewrites a qualified plugin pair from $text',
    ({ text, entry, expected }) => {
      expect(normalizeInvocationToken(text, [entry])).toBe(expected);
    },
  );

  it('leaves an ambiguous tail alias unchanged', () => {
    expect(
      normalizeInvocationToken('/review hello', [
        {
          invocationKey: '$first-plugin:review',
          kind: 'skill',
          name: 'review',
        },
        {
          invocationKey: '$second-plugin:review',
          kind: 'skill',
          name: 'review',
        },
      ]),
    ).toBe('/review hello');
  });

  it('leaves an ambiguous qualified-to-bare tail alias unchanged', () => {
    expect(
      normalizeInvocationToken('$builtin-app-plugin:review', [
        {
          invocationKey: '/review',
          kind: 'skill',
          name: 'review',
        },
        {
          invocationKey: '$review',
          kind: 'skill',
          name: 'review',
        },
      ]),
    ).toBe('$builtin-app-plugin:review');
  });

  it('gives a full-body alias precedence over a colliding tail alias', () => {
    expect(
      normalizeInvocationToken('/review', [
        {
          invocationKey: '$review',
          kind: 'skill',
          name: 'review',
        },
        {
          invocationKey: '$plugin:review',
          kind: 'skill',
          name: 'review',
        },
      ]),
    ).toBe('$review');
  });

  it('leaves the correct invocation key unchanged', () => {
    expect(
      normalizeInvocationToken('$builtin-app-plugin:review', [
        codexStandaloneSkill,
      ]),
    ).toBe('$builtin-app-plugin:review');
  });

  it('leaves an unknown invocation unchanged', () => {
    expect(normalizeInvocationToken('/unknown', [codexStandaloneSkill])).toBe(
      '/unknown',
    );
  });

  it('leaves a mid-message invocation unchanged', () => {
    expect(
      normalizeInvocationToken('please run /review', [codexStandaloneSkill]),
    ).toBe('please run /review');
  });

  it('preserves leading whitespace and the remaining bytes while rewriting', () => {
    expect(
      normalizeInvocationToken(' \t/review\t now\nnext', [
        codexStandaloneSkill,
      ]),
    ).toBe(' \t$builtin-app-plugin:review\t now\nnext');
  });

  it('leaves input unchanged when the inventory is empty', () => {
    expect(normalizeInvocationToken('/review', [])).toBe('/review');
  });
});

describe('matchInvocationEntry', () => {
  it('returns the complete matched row with the same alias precedence', () => {
    const qualified = {
      invocationKey: '/namespace:review',
      kind: 'skill' as const,
      sourceId: 'installed',
    };
    const exact = { invocationKey: '/review', kind: 'plugin_skill' as const };
    expect(matchInvocationEntry('$review now', [qualified])).toBe(qualified);
    expect(matchInvocationEntry('/review now', [qualified, exact])).toBe(exact);
    expect(matchInvocationEntry('prose /review', [exact])).toBeUndefined();
    expect(matchInvocationEntry('/unknown:review', [exact])).toBeUndefined();
    expect(
      matchInvocationEntry('/review', [
        qualified,
        { ...qualified, invocationKey: '/other:review' },
      ]),
    ).toBeUndefined();
  });
});
