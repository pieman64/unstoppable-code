import {
  buildSkillFileTree,
  SKILL_MAIN_FILE,
  skillFileLabel,
} from '../skill-files';

describe('skill file helpers', () => {
  it('builds a nested tree without changing flat-file order', () => {
    expect(
      buildSkillFileTree([
        SKILL_MAIN_FILE,
        'references/notes.md',
        'references/nested/example.ts',
        'asset.txt',
      ]),
    ).toEqual({
      name: '',
      path: '',
      dirs: [
        {
          name: 'references',
          path: 'references',
          dirs: [
            {
              name: 'nested',
              path: 'references/nested',
              dirs: [],
              files: ['references/nested/example.ts'],
            },
          ],
          files: ['references/notes.md'],
        },
      ],
      files: [SKILL_MAIN_FILE, 'asset.txt'],
    });
  });

  it('returns the final path segment as the display label', () => {
    expect(skillFileLabel('references/notes.md')).toBe('notes.md');
    expect(skillFileLabel('SKILL.md')).toBe('SKILL.md');
  });
});
