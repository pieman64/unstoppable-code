import {
  createCapabilitySkillNameAllocator,
  resolveCapabilitySkillNames,
  sanitizeCapabilitySkillName,
} from '../capability-bundle';

describe('capability skill names', () => {
  it('sanitizes names into the bundle-safe character set', () => {
    expect(sanitizeCapabilitySkillName('plugin:my skill/v2')).toBe(
      'plugin-my-skill-v2',
    );
    expect(sanitizeCapabilitySkillName('ok-name_1.2')).toBe('ok-name_1.2');
    expect(sanitizeCapabilitySkillName('')).toBe('skill');
    expect(sanitizeCapabilitySkillName('.')).toBe('skill');
    expect(sanitizeCapabilitySkillName('..')).toBe('skill');
  });

  it('collapses the reserved digest-sentinel name so validation stays unreachable', () => {
    // Bundle validation is all-or-nothing, so a user-named skill that reached
    // the validator would fail the whole bundle instead of being renamed.
    expect(sanitizeCapabilitySkillName('.capability-bundle-digest')).toBe(
      'skill',
    );
    expect(sanitizeCapabilitySkillName('.Capability-Bundle-Digest')).toBe(
      'skill',
    );
    // Flattening can CREATE the reserved name, so the check must follow it.
    expect(sanitizeCapabilitySkillName('.capability bundle digest')).toBe(
      'skill',
    );
    // Names that merely resemble it are untouched.
    expect(sanitizeCapabilitySkillName('capability-bundle-digest')).toBe(
      'capability-bundle-digest',
    );
    expect(sanitizeCapabilitySkillName('.capability-bundle-digest-2')).toBe(
      '.capability-bundle-digest-2',
    );
  });

  it('suffixes sanitized collisions in stable input order', () => {
    expect(
      resolveCapabilitySkillNames([
        { preferredName: 'Release Notes' },
        { preferredName: 'Release/Notes' },
        { preferredName: 'Release Notes' },
        { preferredName: '.' },
        { preferredName: '' },
      ]),
    ).toEqual([
      'Release-Notes',
      'Release-Notes-2',
      'Release-Notes-3',
      'skill',
      'skill-2',
    ]);
  });

  it('previews the next name incrementally without reserving it', () => {
    const allocator = createCapabilitySkillNameAllocator();
    expect(allocator.claim('Release Notes')).toBe('Release-Notes');

    // Previews resolve against the claimed set but never join it, so two
    // colliding candidates each see the same next-free name.
    expect(allocator.preview('Release/Notes')).toBe('Release-Notes-2');
    expect(allocator.preview('Release Notes')).toBe('Release-Notes-2');

    // Claiming still advances the set exactly like the batch resolver.
    expect(allocator.claim('Release/Notes')).toBe('Release-Notes-2');
    expect(allocator.preview('Release Notes')).toBe('Release-Notes-3');
  });

  it('keeps the batch resolver and the allocator on one algorithm', () => {
    const drafts = [
      { preferredName: 'Release Notes' },
      { preferredName: 'Release/Notes' },
      { preferredName: '.' },
      { preferredName: '' },
    ];
    const allocator = createCapabilitySkillNameAllocator();
    expect(resolveCapabilitySkillNames(drafts)).toEqual(
      drafts.map((draft) => allocator.claim(draft.preferredName)),
    );
  });
});
