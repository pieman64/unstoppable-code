import {
  ANIMAL_NAMES,
  DEFAULT_BRANCH_NAMING_SYSTEM_PROMPT,
  DEFAULT_WORKTREE_DISPLAY_NAME,
  isDefaultWorktreeBranchName,
  makeDefaultWorktreeBranchName,
  pickUniqueAnimalName,
  sanitizeBranchName,
} from '../worktree-branch-names';

describe('default worktree branch names', () => {
  it('builds the timestamped default branch name from the worktree id', () => {
    expect(makeDefaultWorktreeBranchName('dormouse', 1713571200123)).toBe(
      'dormouse-1713571200123',
    );
  });

  it('rejects timestamps that cannot round-trip through the matcher', () => {
    expect(() => makeDefaultWorktreeBranchName('dormouse', 1)).toThrow(
      'Default worktree branch timestamp must be an integer >= 1000000000000',
    );
    expect(() => makeDefaultWorktreeBranchName('dormouse', 1.5)).toThrow(
      'Default worktree branch timestamp must be an integer >= 1000000000000',
    );
  });

  it('recognizes legacy and timestamped default branch names', () => {
    expect(isDefaultWorktreeBranchName('dormouse', 'dormouse')).toBe(true);
    // Preserve compatibility with the legacy collision-avoidance format.
    expect(isDefaultWorktreeBranchName('dormouse-2', 'dormouse')).toBe(true);
    expect(
      isDefaultWorktreeBranchName('dormouse-1713571200123', 'dormouse'),
    ).toBe(true);
    expect(
      isDefaultWorktreeBranchName('dormouse-2-1713571200123', 'dormouse-2'),
    ).toBe(true);
    expect(
      isDefaultWorktreeBranchName(
        makeDefaultWorktreeBranchName('dormouse', 1713571200123),
        'dormouse',
      ),
    ).toBe(true);
  });

  it('does not treat renamed branches as default branch names', () => {
    expect(isDefaultWorktreeBranchName('feature/dormouse', 'dormouse')).toBe(
      false,
    );
    expect(isDefaultWorktreeBranchName('dormouse-feature', 'dormouse')).toBe(
      false,
    );
    expect(isDefaultWorktreeBranchName('dormouse-1', 'dormouse')).toBe(false);
    expect(isDefaultWorktreeBranchName('dormouse-100-200', 'dormouse')).toBe(
      false,
    );
    expect(
      isDefaultWorktreeBranchName('dormouse-2-1713571200123', 'dormouse'),
    ).toBe(false);
    expect(
      isDefaultWorktreeBranchName('dormouse-1713571200123-1', 'dormouse'),
    ).toBe(false);
    expect(
      isDefaultWorktreeBranchName('dormouse-1713571200123-2', 'dormouse'),
    ).toBe(false);
  });

  it('exposes the list display label for default worktrees', () => {
    expect(DEFAULT_WORKTREE_DISPLAY_NAME).toBe('New Task');
  });
});

describe('sanitizeBranchName', () => {
  it('lowercases, hyphenates whitespace and drops unsupported characters', () => {
    expect(sanitizeBranchName('  Fix OAuth__Flow!!!  ')).toBe('fix-oauth-flow');
    // Slashes are legal git ref separators and survive; the colon and the
    // trailing bangs are dropped.
    expect(sanitizeBranchName('Fix: Login/Bug!!')).toBe('fix-login/bug');
  });

  it('strips a trailing .lock and collapses repeated separators', () => {
    expect(sanitizeBranchName('feature.lock')).toBe('feature');
    expect(sanitizeBranchName('a---b//c..d')).toBe('a-b/c.d');
  });

  it('trims leading and trailing separators', () => {
    expect(sanitizeBranchName('-/.name./-')).toBe('name');
  });

  it('caps the result at 100 characters without a trailing separator', () => {
    const result = sanitizeBranchName(`${'a'.repeat(99)}-bbbb`);
    expect(result).toBe('a'.repeat(99));
  });

  it('returns null when nothing usable remains', () => {
    expect(sanitizeBranchName('!!!')).toBeNull();
    expect(sanitizeBranchName('   ')).toBeNull();
  });
});

describe('DEFAULT_BRANCH_NAMING_SYSTEM_PROMPT', () => {
  it('asks for a JSON object with a single branchName field', () => {
    expect(DEFAULT_BRANCH_NAMING_SYSTEM_PROMPT).toContain(
      'Return ONLY a JSON object with a single "branchName" field.',
    );
  });
});

describe('pickUniqueAnimalName', () => {
  const animalNames = new Set<string>(ANIMAL_NAMES);
  const retiredAnimalNames = ['booby', 'redpanda'];

  it('returns a curated animal name when nothing is taken', () => {
    expect(animalNames.has(pickUniqueAnimalName(new Set<string>()))).toBe(true);
  });

  it('avoids names that are already taken', () => {
    const name = pickUniqueAnimalName(new Set(['aardvark']), {
      random: () => 0,
    });

    expect(name).not.toBe('aardvark');
    expect(animalNames.has(name)).toBe(true);
  });

  it('is deterministic for a fixed random source', () => {
    const first = pickUniqueAnimalName(new Set<string>(), {
      random: () => 0.3,
    });
    const second = pickUniqueAnimalName(new Set<string>(), {
      random: () => 0.3,
    });

    expect(first).toBe(second);
  });

  it('finds the single remaining free name', () => {
    const taken = new Set<string>(ANIMAL_NAMES);
    taken.delete('zebra');

    expect(pickUniqueAnimalName(taken)).toBe('zebra');
  });

  it('applies the prefix to the picked name', () => {
    const name = pickUniqueAnimalName(new Set<string>(), { prefix: 'dev-' });

    expect(name.startsWith('dev-')).toBe(true);
    expect(animalNames.has(name.slice('dev-'.length))).toBe(true);
  });

  it('checks collisions against the prefixed candidate only', () => {
    // Unprefixed names do not collide with prefixed candidates.
    const name = pickUniqueAnimalName(new Set<string>(ANIMAL_NAMES), {
      prefix: 'dev-',
    });

    expect(name.startsWith('dev-')).toBe(true);
    expect(name.endsWith('-2')).toBe(false);
  });

  it('falls back to a numeric suffix when every name is taken', () => {
    const name = pickUniqueAnimalName(new Set<string>(ANIMAL_NAMES));
    const match = /^([a-z]+)-2$/.exec(name);

    expect(match).not.toBeNull();
    expect(animalNames.has(match?.[1] ?? '')).toBe(true);
  });

  it('keeps the prefix on suffixed fallback names', () => {
    const taken = new Set<string>();
    for (const animalName of ANIMAL_NAMES) {
      taken.add(`dev-${animalName}`);
    }

    const name = pickUniqueAnimalName(taken, { prefix: 'dev-' });

    expect(name.startsWith('dev-')).toBe(true);
    expect(name.endsWith('-2')).toBe(true);
  });

  it('keeps incrementing the suffix past taken suffixes', () => {
    const taken = new Set<string>();
    for (const animalName of ANIMAL_NAMES) {
      taken.add(animalName);
      taken.add(`${animalName}-2`);
    }

    expect(pickUniqueAnimalName(taken).endsWith('-3')).toBe(true);
  });

  it('keeps the curated animal list unique and free of retired names', () => {
    expect(animalNames.size).toBe(ANIMAL_NAMES.length);

    for (const retiredAnimalName of retiredAnimalNames) {
      expect(ANIMAL_NAMES).not.toContain(retiredAnimalName);
    }
  });
});
