import {
  automationContextNoteMessage,
  automationContextRefusalMessage,
  backgroundExecutionDeniedMessage,
  backgroundExecutionRetryMessage,
  workspaceContextDisplayLabel,
} from '../automation-context-copy';

it('gives transient runs and watchers distinct retry guidance', () => {
  expect(backgroundExecutionRetryMessage('run')).toBe(
    "Couldn't check access to what this run uses. Try again in a moment.",
  );
  expect(backgroundExecutionRetryMessage('watcher')).toBe(
    "Couldn't check access to what this watcher uses. It'll try again.",
  );
});

describe('backgroundExecutionDeniedMessage', () => {
  it.each([
    [
      'context-mismatch',
      "This is in a different Personal or organization context than the one it was set up in, so it didn't run.",
    ],
    ['access-removed', 'You no longer have access to something this uses.'],
    [
      'unknown-provenance',
      "Couldn't confirm where something this uses came from, so it didn't run.",
    ],
    [
      'missing-dependency',
      "Something this needs is missing, so it didn't run.",
    ],
    [
      'unsupported-target',
      "Couldn't confirm where this runs, so it didn't run.",
    ],
  ] as const)('explains %s', (reason, message): void => {
    expect(backgroundExecutionDeniedMessage(reason)).toBe(message);
    expect(backgroundExecutionDeniedMessage(reason, { turnedOff: true })).toBe(
      `${message} It's been turned off.`,
    );
  });

  it('never blames another organization or mentions project contexts', (): void => {
    for (const reason of [
      'context-mismatch',
      'access-removed',
      'unknown-provenance',
      'missing-dependency',
      'unsupported-target',
    ] as const) {
      const message = backgroundExecutionDeniedMessage(reason);
      expect(message).not.toMatch(/another organization|project context/i);
      expect(message).not.toMatch(/resource/i);
    }
  });

  it('names the target and both contexts for a detailed mismatch', (): void => {
    const mismatch = {
      targetName: 'Chats',
      targetContext: 'Personal',
      boundContext: 'Acme',
    };
    expect(
      backgroundExecutionDeniedMessage('context-mismatch', { mismatch }),
    ).toBe(
      'Chats is in Personal, but this automation was turned on in Acme. Turn it on again to run it in Personal.',
    );
    expect(
      backgroundExecutionDeniedMessage('context-mismatch', {
        mismatch,
        turnedOff: true,
      }),
    ).toBe(
      'Turned off because Chats is in Personal, but this automation was turned on in Acme. Turn it on again to run it in Personal.',
    );
  });

  it('asks to turn an automation that is still on off and on again', (): void => {
    const mismatch = {
      targetName: 'Chats',
      targetContext: 'Personal',
      boundContext: 'Acme',
    };
    expect(
      backgroundExecutionDeniedMessage('context-mismatch', {
        mismatch,
        stillOn: true,
      }),
    ).toBe(
      'Chats is in Personal, but this automation was turned on in Acme. Turn it off and on again to run it in Personal.',
    );
    // Once it's been turned off, turning it on is enough.
    expect(
      backgroundExecutionDeniedMessage('context-mismatch', {
        mismatch,
        stillOn: true,
        turnedOff: true,
      }),
    ).toBe(
      'Turned off because Chats is in Personal, but this automation was turned on in Acme. Turn it on again to run it in Personal.',
    );
  });

  it('explains that the project moved instead of silently blaming setup', (): void => {
    expect(
      backgroundExecutionDeniedMessage('context-mismatch', {
        mismatch: {
          targetName: 'Chats',
          targetContext: 'Acme',
          boundContext: 'Personal',
          projectMoved: true,
        },
        turnedOff: true,
      }),
    ).toBe(
      'Turned off because Chats moved to Acme, but this automation still runs in Personal. Turn it on again to run it in Acme.',
    );
  });

  it('ignores mismatch details for other reasons', (): void => {
    expect(
      backgroundExecutionDeniedMessage('access-removed', {
        mismatch: {
          targetName: 'Chats',
          targetContext: 'Personal',
          boundContext: 'Acme',
        },
      }),
    ).toBe('You no longer have access to something this uses.');
  });

  it('names the resource whose provenance is unknown', (): void => {
    expect(
      backgroundExecutionDeniedMessage('unknown-provenance', {
        subject: { kind: 'plugin', name: 'Mystery plugin' },
      }),
    ).toBe(
      "Couldn't confirm where Mystery plugin came from, so it didn't run.",
    );
  });

  it('uses a bounded single-line resource name with an unnamed fallback', (): void => {
    const boundedName = 'A'.repeat(200);
    expect(
      backgroundExecutionDeniedMessage('unknown-provenance', {
        subject: {
          kind: 'plugin',
          name: `  ${'A'.repeat(205)}\nforged line\u0000  `,
        },
      }),
    ).toBe(
      `Couldn't confirm where ${boundedName} came from, so it didn't run.`,
    );
    expect(
      backgroundExecutionDeniedMessage('unknown-provenance', {
        subject: { kind: 'plugin', name: '\n\t\u0000' },
      }),
    ).toBe(
      "Couldn't confirm where something this uses came from, so it didn't run.",
    );
  });
});

describe('automationContextRefusalMessage', () => {
  it.each([
    ['enable', 'turn this automation on'],
    ['run', 'run this automation again'],
    ['save', 'save this automation again'],
  ] as const)(
    'asks for access to the target organization before %s',
    (action, next): void => {
      expect(
        automationContextRefusalMessage({ targetName: 'Website', action }),
      ).toBe(
        `Website is in an organization you're not a member of. Ask for access, then ${next}.`,
      );
    },
  );
});

describe('automationContextNoteMessage', () => {
  it('says turning the automation on runs it where its saved target lives', (): void => {
    expect(
      automationContextNoteMessage({
        targetName: 'Chats',
        targetContext: 'Personal',
      }),
    ).toBe(
      'Chats is in Personal, so turning this automation on runs it there.',
    );
  });

  it('asks for access when the target is in an organization the account is not in', (): void => {
    expect(
      automationContextNoteMessage({
        targetName: 'Website',
        targetContext: null,
      }),
    ).toBe(
      "Website is in an organization you're not a member of. Ask for access to turn this automation on or run it.",
    );
  });
});

describe('workspaceContextDisplayLabel', () => {
  const organizations = [{ id: 'org-1', name: 'Acme' }];

  it('labels Personal and known organizations', (): void => {
    expect(workspaceContextDisplayLabel({ kind: 'personal' }, [])).toBe(
      'Personal',
    );
    expect(
      workspaceContextDisplayLabel(
        { kind: 'organization', organizationId: 'org-1' },
        organizations,
      ),
    ).toBe('Acme');
  });

  it('falls back for an unknown organization', (): void => {
    expect(
      workspaceContextDisplayLabel(
        { kind: 'organization', organizationId: 'org-2' },
        organizations,
      ),
    ).toBe('your organization');
    expect(
      workspaceContextDisplayLabel(
        { kind: 'organization', organizationId: 'org-2' },
        organizations,
        'another organization',
      ),
    ).toBe('another organization');
  });
});
