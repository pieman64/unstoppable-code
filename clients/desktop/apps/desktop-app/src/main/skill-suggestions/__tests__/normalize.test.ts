import {
  countContentTokens,
  jaccard,
  leadingSkillInvocation,
  normalizePromptTokens,
  pairScore,
  sharedContentTokenCount,
  skillsInToolShape,
  toolShapeEntry,
} from '../normalize';

describe('skill suggestion prompt normalization', () => {
  it('replaces volatile values with slot tokens', () => {
    const tokens = normalizePromptTokens(
      'Review https://github.com/org/repo/pull/12 for CAN-385 and #42 at src/main/index.ts, sha deadbeef12, "exact phrase", 3 times',
    );
    expect(tokens).toEqual(
      expect.arrayContaining([
        '<url>',
        '<ticket>',
        '<path>',
        '<sha>',
        '<quote>',
        '<num>',
        'review',
        'times',
        'sha',
      ]),
    );
    expect(tokens).not.toContain('github');
    expect(tokens).not.toContain('385');
    expect(tokens).not.toContain('exact');
  });

  it('lowercases, strips punctuation and drops stopwords', () => {
    expect(
      normalizePromptTokens('Please Summarize the LATEST release notes!'),
    ).toEqual(['latest', 'notes', 'release', 'summarize']);
  });

  it('removes a leading skill invocation from the prompt text', () => {
    expect(leadingSkillInvocation('/review check this change')).toBe('review');
    expect(leadingSkillInvocation('$Push-Branch')).toBe('push-branch');
    expect(leadingSkillInvocation('please /review')).toBeNull();
    // A skill name starts with a letter: prices and numbers are not skills.
    expect(leadingSkillInvocation('$5 budget for the team lunch')).toBeNull();
    expect(leadingSkillInvocation('/2 more rows please')).toBeNull();
    expect(normalizePromptTokens('/review check this change')).toEqual([
      'change',
      'check',
    ]);
  });

  it('caps the prompt before normalizing', () => {
    const tokens = normalizePromptTokens(`${'word '.repeat(300)}unreachable`);
    expect(tokens).not.toContain('unreachable');
  });

  it('counts only content tokens', () => {
    expect(countContentTokens(['<url>', '<num>', 'deploy'])).toBe(1);
    expect(countContentTokens(normalizePromptTokens('fix it'))).toBe(1);
    expect(sharedContentTokenCount(['<url>', 'a', 'b'], ['<url>', 'b'])).toBe(
      1,
    );
  });

  it('scores pairs symmetrically with the prompt and tool weights', () => {
    const a = { tokens: ['deploy', 'staging', 'notes'], tools: ['Bash'] };
    const b = { tokens: ['deploy', 'staging'], tools: ['Bash', 'Read'] };
    expect(pairScore(a, b)).toBeCloseTo(pairScore(b, a));
    expect(pairScore(a, b)).toBeCloseTo(0.75 * (2 / 3) + 0.25 * (1 / 2));
    expect(pairScore(a, a)).toBeCloseTo(1);
    expect(jaccard([], [])).toBe(1);
    expect(jaccard(['a'], [])).toBe(0);
  });

  it('maps provider tool names to tool-shape entries', () => {
    expect(toolShapeEntry('Skill', { skill: 'Review' })).toBe('skill:review');
    expect(toolShapeEntry('mcp__linear__get_issue')).toBe('mcp:linear');
    expect(toolShapeEntry('Task')).toBeNull();
    expect(toolShapeEntry('Agent')).toBeNull();
    expect(toolShapeEntry('spawnAgent')).toBeNull();
    expect(toolShapeEntry('Bash')).toBe('Bash');
    expect(skillsInToolShape(['Bash', 'skill:a', 'mcp:x', 'skill:b'])).toEqual([
      'a',
      'b',
    ]);
  });
});
