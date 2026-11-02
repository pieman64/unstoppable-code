import type { SharedContainerRevisionPackage } from '@canopy/protocol/shared-containers';
import {
  formatCapabilityPackageCounts,
  formatCapabilityPackageForkDisclosure,
  formatCapabilityPackageShareNote,
} from '../capability-package-counts';

const EMPTY = { skills: 0, pipelines: 0, agents: 0, automations: 0, hooks: 0 };

function pkg(
  counts: Partial<typeof EMPTY>,
  executableFiles: string[] = [],
): SharedContainerRevisionPackage {
  return {
    digest: `pp:v1:${'a'.repeat(43)}`,
    counts: { ...EMPTY, ...counts },
    executableFiles,
  };
}

describe('formatCapabilityPackageCounts', () => {
  it('returns null when every category is zero', () => {
    expect(formatCapabilityPackageCounts(EMPTY)).toBeNull();
  });

  it('uses singular and plural forms and omits zero categories', () => {
    expect(formatCapabilityPackageCounts({ ...EMPTY, skills: 1 })).toBe(
      '1 skill',
    );
    expect(
      formatCapabilityPackageCounts({ ...EMPTY, skills: 2, automations: 1 }),
    ).toBe('2 skills and 1 automation');
    expect(
      formatCapabilityPackageCounts({
        skills: 3,
        pipelines: 1,
        agents: 2,
        automations: 0,
        hooks: 1,
      }),
    ).toBe('3 skills, 1 pipeline, 2 Agents and 1 hook');
  });
});

describe('formatCapabilityPackageShareNote', () => {
  it('is absent for an empty package', () => {
    expect(formatCapabilityPackageShareNote(EMPTY)).toBeNull();
  });

  it('says the counts install only when a teammate makes a copy', () => {
    expect(
      formatCapabilityPackageShareNote({ ...EMPTY, agents: 1, pipelines: 2 }),
    ).toBe(
      'This share also carries the 2 pipelines and 1 Agent used here. They install only if a teammate makes a copy.',
    );
  });

  it('says hooks stay out of copies', () => {
    expect(
      formatCapabilityPackageShareNote({ ...EMPTY, skills: 1, hooks: 2 }),
    ).toBe(
      'This share also carries the 1 skill and 2 hooks used here. They install only if a teammate makes a copy, except hooks.',
    );
  });
});

describe('formatCapabilityPackageForkDisclosure', () => {
  it('is absent for an empty package', () => {
    expect(formatCapabilityPackageForkDisclosure(pkg({}))).toBeNull();
  });

  it('summarizes what installs and keeps the caveats in the details', () => {
    expect(
      formatCapabilityPackageForkDisclosure(
        pkg({ skills: 1, automations: 1, hooks: 2 }),
      ),
    ).toEqual({
      summary: 'Installs 1 skill and 1 automation.',
      details: [
        'New chats in the copy start with this skill turned on.',
        'The automation starts turned off.',
        "Hooks from this share aren't added.",
      ],
      scripts: [],
    });
    expect(
      formatCapabilityPackageForkDisclosure(pkg({ automations: 2 })),
    ).toEqual({
      summary: 'Installs 2 automations.',
      details: ['Automations start turned off.'],
      scripts: [],
    });
  });

  it('says skills start turned on only when the package installs skills', () => {
    expect(
      formatCapabilityPackageForkDisclosure(pkg({ skills: 2 }))?.details,
    ).toEqual(['New chats in the copy start with these skills turned on.']);
    expect(
      formatCapabilityPackageForkDisclosure(pkg({ pipelines: 1, agents: 1 })),
    ).toEqual({
      summary: 'Installs 1 pipeline and 1 Agent.',
      details: [],
      scripts: [],
    });
  });

  it('does not promise an installation for a hooks-only package', () => {
    expect(formatCapabilityPackageForkDisclosure(pkg({ hooks: 1 }))).toEqual({
      summary: "Hooks from this share aren't added.",
      details: [],
      scripts: [],
    });
  });

  it('counts runnable scripts up front and names every one in full', () => {
    const longName = `skill-a/scripts/${'deeply-nested/'.repeat(12)}run.sh`;
    const disclosure = formatCapabilityPackageForkDisclosure(
      pkg({ skills: 1 }, ['skill-a/scripts/setup.sh', longName]),
    );
    expect(disclosure?.summary).toBe(
      'Installs 1 skill, plus 2 scripts that can run on this computer.',
    );
    expect(disclosure?.scripts).toEqual(['skill-a/scripts/setup.sh', longName]);
  });

  it('discloses an executable-only package with zero category counts', () => {
    expect(
      formatCapabilityPackageForkDisclosure(
        pkg({}, ['action-1/action/run.sh']),
      ),
    ).toEqual({
      summary: 'Installs 1 script that can run on this computer.',
      details: [],
      scripts: ['action-1/action/run.sh'],
    });
  });
});
