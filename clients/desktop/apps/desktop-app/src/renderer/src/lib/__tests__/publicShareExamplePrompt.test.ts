import { buildSkillStarterPrompt } from '../publicShareExamplePrompt';

describe('buildSkillStarterPrompt', () => {
  it('uses the shared fallback normalization for catalog and public-share prompts', () => {
    expect(
      buildSkillStarterPrompt({
        name: '  Table   helper ',
        description: ' Format\n  tables?!.. ',
        frontmatter: { example: false, usage: [] },
      }),
    ).toBe('Using Table helper, format tables.');
  });
  it('prefers the frontmatter example over every other source', () => {
    expect(
      buildSkillStarterPrompt({
        name: 'helper',
        description: 'Formats markdown tables.',
        frontmatter: {
          example: '  Format this table for me.  ',
          usage: 'Never used.',
          example_prompt: 'Never used either.',
        },
      }),
    ).toBe('Format this table for me.');
  });

  it('falls through example → usage → example_prompt in order', () => {
    expect(
      buildSkillStarterPrompt({
        name: 'helper',
        description: '',
        frontmatter: { usage: 'Run me on a README.' },
      }),
    ).toBe('Run me on a README.');
    expect(
      buildSkillStarterPrompt({
        name: 'helper',
        description: '',
        frontmatter: { example_prompt: 'Try me on this snippet.' },
      }),
    ).toBe('Try me on this snippet.');
  });

  it('ignores non-string and whitespace-only frontmatter values', () => {
    expect(
      buildSkillStarterPrompt({
        name: 'helper',
        description: 'Formats markdown tables.',
        frontmatter: { example: 42, usage: '   ' },
      }),
    ).toBe('Using helper, format markdown tables.');
  });

  it('derives a short task from the pinned description', () => {
    expect(
      buildSkillStarterPrompt({
        name: 'helper',
        description: 'Formats markdown tables. ',
        frontmatter: null,
      }),
    ).toBe('Using helper, format markdown tables.');
  });

  it('falls back to the generic prompt when description is empty', () => {
    expect(
      buildSkillStarterPrompt({
        name: 'helper',
        description: '   ',
        frontmatter: null,
      }),
    ).toBe(
      'Using the helper skill, run one quick, real example and show me the result.',
    );
  });
});
