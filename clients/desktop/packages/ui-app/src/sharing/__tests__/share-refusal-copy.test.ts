import { resourceContextRefusalMessage } from '../share-refusal-copy';

const SENTENCES = {
  'unsupported-target': "This share can't be moved to that destination.",
  'context-mismatch':
    'Switch to the organization that owns this share, then try again.',
  'access-removed': 'You no longer have access to this share.',
  'unknown-provenance': "This share's owner couldn't be confirmed.",
  'missing-dependency': "A dependency of this share isn't available.",
} as const;

describe('resourceContextRefusalMessage', () => {
  it.each([
    'Resource',
    'Workflow',
    // Desktops before the workflow rename still send this noun.
    'Pipeline',
    'Skill',
    'Agent',
    'Automation',
    'Collection',
    'Plugin',
  ])(
    'translates the bounded %s refusal without exposing internal reasons',
    (noun) => {
      for (const [reason, sentence] of Object.entries(SENTENCES)) {
        const message = `${noun.toUpperCase()} unavailable (${reason})`;
        expect(resourceContextRefusalMessage(new Error(message))).toBe(
          sentence,
        );
        expect(resourceContextRefusalMessage(message)).toBe(sentence);
        expect(
          resourceContextRefusalMessage({
            message: `Error invoking remote method 'sharing:update': ResourceContextUnavailableError: ${message}`,
          }),
        ).toBe(sentence);
      }
    },
  );
  it.each(Object.entries(SENTENCES))(
    'translates a bare %s refusal',
    (reason, sentence) => {
      expect(
        resourceContextRefusalMessage(
          new Error(`Resource unavailable (${reason})`),
        ),
      ).toBe(sentence);
    },
  );

  it('removes the Electron wrapper and error-class prefix', () => {
    expect(
      resourceContextRefusalMessage(
        new Error(
          "Error invoking remote method 'automations:shared:update': ResourceContextUnavailableError: Resource unavailable (unsupported-target)",
        ),
      ),
    ).toBe(SENTENCES['unsupported-target']);
    expect(
      resourceContextRefusalMessage(
        "Error invoking remote method 'skills:shared:update': Error: Resource unavailable (unknown-provenance)",
      ),
    ).toBe(SENTENCES['unknown-provenance']);
  });

  it('matches regardless of capitalization and reads string and object inputs', () => {
    expect(
      resourceContextRefusalMessage('RESOURCE UNAVAILABLE (Access-Removed)'),
    ).toBe(SENTENCES['access-removed']);
    expect(
      resourceContextRefusalMessage({
        message: 'resource unavailable (context-mismatch).',
      }),
    ).toBe(SENTENCES['context-mismatch']);
  });

  it.each(Object.entries(SENTENCES))(
    'normalizes nested transport/class prefixes for %s',
    (reason, sentence) => {
      expect(
        resourceContextRefusalMessage({
          message: `Error: Error invoking remote method 'collections:shared:update': ResourceContextUnavailableError: RESOURCE UNAVAILABLE (${reason.toUpperCase()})`,
        }),
      ).toBe(sentence);
    },
  );

  it('does not throw while reading malformed error objects', () => {
    const error = {
      get message(): string {
        throw new Error('Unreadable');
      },
    };
    expect(resourceContextRefusalMessage(error)).toBeNull();
  });

  it('safely reads Error instances with malformed or unreadable messages', () => {
    const malformed = new Error();
    Object.defineProperty(malformed, 'message', { value: 7 });
    expect(resourceContextRefusalMessage(malformed)).toBeNull();
    const unreadable = new Error();
    Object.defineProperty(unreadable, 'message', {
      get: () => {
        throw new Error('Unreadable');
      },
    });
    expect(resourceContextRefusalMessage(unreadable)).toBeNull();
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['a number', 42],
    ['a non-string message', { message: 7 }],
    ['an empty message', new Error('')],
    ['an unknown reason', new Error('Resource unavailable (other-reason)')],
    ['an inherited key', new Error('Resource unavailable (constructor)')],
    ['an unrelated error', new Error('HTTP 409: conflict')],
    [
      'a message that only mentions a reason',
      new Error('Could not resolve unsupported-target for this upload'),
    ],
    [
      'a refusal embedded in other text',
      new Error(
        'Retry failed: Resource unavailable (unsupported-target) twice',
      ),
    ],
  ])('returns null for %s', (_label, input) => {
    expect(resourceContextRefusalMessage(input)).toBeNull();
  });
});
