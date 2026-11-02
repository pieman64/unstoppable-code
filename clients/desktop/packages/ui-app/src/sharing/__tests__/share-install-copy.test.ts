import {
  shareAttributionParts,
  shareAttributionText,
  shareInstallActionLabel,
  shareInstallSkillEffect,
  shareInstallSkillEffectParts,
  shareInstallDefaultDescription,
  shareInstallEntityNoun,
  shareInstallPlaceholderTitle,
  shareInstallTypeLabel,
  shareLandingErrorCopy,
  shareLandingRecoveryAction,
  shareLandingRecoveryActionLabel,
  type ShareInstallEntity,
  type ShareLandingFailureReason,
} from '../share-install-copy';

const ENTITIES: readonly ShareInstallEntity[] = [
  'skill',
  'plugin',
  'pipeline',
  'automation',
  'agent',
  'collection',
  'workspace',
];

describe('shareInstallActionLabel', () => {
  it('says Install with no noun for every entity, Blueprints included', () => {
    for (const entity of ENTITIES) {
      expect(shareInstallActionLabel(entity, 'install')).toBe('Install');
      expect(shareInstallActionLabel(entity, 'installing')).toBe('Installing…');
      expect(shareInstallActionLabel(entity, 'update')).toBe('Update');
      expect(shareInstallActionLabel(entity, 'updating')).toBe('Updating…');
    }
  });

  it('names the destination once installed', () => {
    expect(shareInstallActionLabel('skill', 'open')).toBe('Open skill');
    expect(shareInstallActionLabel('plugin', 'open')).toBe('Open plugin');
    expect(shareInstallActionLabel('pipeline', 'open')).toBe('Open workflow');
    expect(shareInstallActionLabel('automation', 'open')).toBe(
      'Open automation',
    );
    expect(shareInstallActionLabel('agent', 'open')).toBe('Open agent');
    expect(shareInstallActionLabel('collection', 'open')).toBe(
      'Open collection',
    );
    expect(shareInstallActionLabel('workspace', 'open')).toBe('Open project');
  });
});

describe('shareInstallDefaultDescription', () => {
  it('gives every entity its own one-line sentence', () => {
    const descriptions = ENTITIES.map(shareInstallDefaultDescription);
    expect(new Set(descriptions).size).toBe(ENTITIES.length);
    for (const description of descriptions) {
      expect(description).toMatch(/^[A-Z].*\.$/);
      expect(description).not.toContain('\n');
    }
  });

  it('describes an automation without assuming a pipeline or a project', () => {
    // Prompt and App Advisor automations run no pipeline, and App Advisor
    // needs no project.
    expect(shareInstallDefaultDescription('automation')).toBe(
      'An automation that runs a task for you on a schedule.',
    );
  });

  it('describes a pipeline share as a workflow (CAN-4651)', () => {
    expect(shareInstallDefaultDescription('pipeline')).toBe(
      'A workflow you can run on a project when you need it.',
    );
  });

  it('describes a Blueprint as a project template', () => {
    expect(shareInstallDefaultDescription('workspace')).toBe(
      'A project template with its setup ready to use.',
    );
  });
});

describe('shareInstallTypeLabel', () => {
  it('capitalizes the noun, and a Blueprint reads as a project template', () => {
    expect(shareInstallTypeLabel('skill')).toBe('Skill');
    expect(shareInstallTypeLabel('workspace')).toBe('Project template');
    expect(shareInstallTypeLabel('pipeline')).toBe('Workflow');
    expect(shareInstallEntityNoun('pipeline')).toBe('workflow');
    expect(shareInstallEntityNoun('workspace')).toBe('project');
    expect(shareInstallEntityNoun('collection')).toBe('collection');
  });

  it('names the loading placeholder by type', () => {
    expect(shareInstallPlaceholderTitle('automation')).toBe(
      'Shared automation',
    );
    expect(shareInstallPlaceholderTitle('pipeline')).toBe('Shared workflow');
    expect(shareInstallPlaceholderTitle('workspace')).toBe(
      'Shared project template',
    );
  });
});

describe('share attribution', () => {
  it('orders sharer, owner and audience', () => {
    const parts = shareAttributionParts({
      sharerName: 'Lena Park',
      ownerName: 'Acme',
      audienceLabel: 'Team: Platform',
    });
    expect(parts).toEqual([
      { kind: 'sharer', name: 'Lena Park' },
      { kind: 'owner', name: 'Acme' },
      { kind: 'audience', label: 'Team: Platform' },
    ]);
    expect(shareAttributionText(parts)).toBe(
      'Shared by Lena Park · Acme · Team: Platform',
    );
  });

  it('drops missing and blank parts without dangling separators', () => {
    expect(
      shareAttributionText(
        shareAttributionParts({
          sharerName: '   ',
          ownerName: 'Acme',
          audienceLabel: 'Organization',
        }),
      ),
    ).toBe('Acme · Organization');
    expect(
      shareAttributionText(
        shareAttributionParts({ sharerName: ' Ada ', ownerName: null }),
      ),
    ).toBe('Shared by Ada');
    expect(
      shareAttributionText(
        shareAttributionParts({ sharerName: null, ownerName: '' }),
      ),
    ).toBe('');
  });
});

describe('shareInstallSkillEffect', () => {
  const note =
    "Later edits to the shared skill won't automatically update this copy.";

  it('separates only the identifying context name from recorded copy', () => {
    expect(
      shareInstallSkillEffectParts({ kind: 'organization', name: ' Acme ' }),
    ).toEqual([
      { kind: 'copy', text: 'Adds a copy to this device for the ' },
      { kind: 'name', text: 'Acme' },
      { kind: 'copy', text: ` context. ${note}` },
    ]);
  });

  it('names the context a scoped copy lands in', () => {
    expect(
      shareInstallSkillEffect({ kind: 'organization', name: 'Acme' }),
    ).toBe(`Adds a copy to this device for the Acme context. ${note}`);
    expect(shareInstallSkillEffect({ kind: 'personal' })).toBe(
      `Adds a copy to this device for your Personal context. ${note}`,
    );
  });

  it("falls back to the owning organization's context without a name", () => {
    for (const name of [null, '', '  ']) {
      expect(shareInstallSkillEffect({ kind: 'organization', name })).toBe(
        `Adds a copy to this device for the owning organization's context. ${note}`,
      );
    }
  });

  it('says an unscoped copy is available everywhere', () => {
    expect(shareInstallSkillEffect({ kind: 'all-contexts' })).toBe(
      `Adds a copy to this device, available in every context. ${note}`,
    );
  });

  it('claims no scope when the install scope is unknown', () => {
    expect(shareInstallSkillEffect({ kind: 'unknown' })).toBe(
      `Adds a copy to this device. ${note}`,
    );
  });
});

describe('share landing failures (CAN-5222)', () => {
  const BRAND = { appName: 'TestApp', serverName: 'TestCloud' } as const;
  const REASONS: readonly ShareLandingFailureReason[] = [
    'not-found',
    'sign-in-required',
    'not-a-member',
    'cloud-unreachable',
    'client-upgrade-required',
    'share-changed',
  ];

  it('names the entity when signing in or another account may help', () => {
    expect(shareLandingErrorCopy('sign-in-required', 'pipeline', BRAND)).toBe(
      'Sign in to open this workflow.',
    );
    expect(shareLandingErrorCopy('not-a-member', 'agent', BRAND)).toBe(
      "This account doesn't have access to this agent. Try signing in with another account.",
    );
  });

  it('keeps an unavailable share neutral about why', () => {
    expect(shareLandingErrorCopy('not-found', 'skill', BRAND)).toBe(
      "This share isn't available. It may no longer exist, or you may not have access.",
    );
  });

  it('never claims revocation or names an organization', () => {
    for (const reason of REASONS) {
      for (const entity of ENTITIES) {
        const copy = shareLandingErrorCopy(reason, entity, BRAND);
        expect(copy).not.toMatch(/revoked|organization|member/i);
      }
    }
  });

  it('uses the host brand for the app and the service', () => {
    expect(shareLandingErrorCopy('cloud-unreachable', 'skill', BRAND)).toBe(
      "Couldn't reach TestCloud. Check your connection and try again.",
    );
    expect(
      shareLandingErrorCopy('client-upgrade-required', 'pipeline', BRAND),
    ).toContain('this version of TestApp cannot install');
  });

  it('offers one recovery per recoverable failure and none otherwise', () => {
    expect(
      Object.fromEntries(
        REASONS.map((reason) => [reason, shareLandingRecoveryAction(reason)]),
      ),
    ).toEqual({
      'not-found': null,
      'sign-in-required': 'sign-in',
      'not-a-member': 'switch-account',
      'cloud-unreachable': 'retry',
      'client-upgrade-required': 'check-for-updates',
      'share-changed': null,
    });
  });

  it('labels each recovery action', () => {
    expect(shareLandingRecoveryActionLabel('sign-in')).toBe('Sign in');
    expect(shareLandingRecoveryActionLabel('switch-account')).toBe(
      'Switch account',
    );
    expect(shareLandingRecoveryActionLabel('retry')).toBe('Retry');
    expect(shareLandingRecoveryActionLabel('check-for-updates')).toBe(
      'Check for updates',
    );
  });
});
