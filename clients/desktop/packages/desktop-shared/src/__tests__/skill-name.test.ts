import {
  getCustomSkillNameValidationError,
  getSkillFilePathValidationError,
  MAX_CUSTOM_SKILL_NAME_LENGTH,
  MAX_SKILL_FILE_PATH_SEGMENT_LENGTH,
} from '../skill-name';

describe('getCustomSkillNameValidationError', () => {
  it.each(['my-skill', 'skill-2', 'a', 'two--hyphens'])(
    'accepts the cross-platform skill name %s',
    (name) => {
      expect(getCustomSkillNameValidationError(name)).toBeNull();
    },
  );

  it.each([
    ['', 'Skill name is required.'],
    [
      'My-Skill',
      'Skill name can only contain lowercase letters, numbers, and hyphens.',
    ],
    [
      'my_skill',
      'Skill name can only contain lowercase letters, numbers, and hyphens.',
    ],
    [
      'my skill',
      'Skill name can only contain lowercase letters, numbers, and hyphens.',
    ],
    ['-my-skill', 'Skill name must start with a lowercase letter or number.'],
    ['my-skill-', 'Skill name must end with a lowercase letter or number.'],
    [
      'a'.repeat(MAX_CUSTOM_SKILL_NAME_LENGTH + 1),
      `Skill name must be at most ${MAX_CUSTOM_SKILL_NAME_LENGTH} characters.`,
    ],
  ])('rejects %p with an actionable message', (name, expected) => {
    expect(getCustomSkillNameValidationError(name)).toBe(expected);
  });

  it.each(['con', 'prn', 'aux', 'nul', 'com1', 'lpt9'])(
    'rejects the Windows reserved device name %s',
    (name) => {
      expect(getCustomSkillNameValidationError(name)).toBe(
        'Skill name cannot use a Windows reserved device name.',
      );
    },
  );
});

describe('getSkillFilePathValidationError', () => {
  it.each(['SKILL.md/notes.txt', 'skill.MD/references/api.md'])(
    'rejects supporting paths nested beneath the reserved main file in %s',
    (filePath) => {
      expect(getSkillFilePathValidationError(filePath)).toBe(
        'SKILL.md is reserved for the main skill file.',
      );
    },
  );

  it('rejects a path segment that exceeds filesystem component limits', () => {
    expect(
      getSkillFilePathValidationError(
        `${'a'.repeat(MAX_SKILL_FILE_PATH_SEGMENT_LENGTH + 1)}.md`,
      ),
    ).toBe(
      `File names must be at most ${MAX_SKILL_FILE_PATH_SEGMENT_LENGTH} characters.`,
    );
  });

  it.each(['CON.md', 'references/aux.txt', 'com1', 'nested/LPT9.json', 'nul'])(
    'rejects the Windows reserved path segment in %s',
    (filePath) => {
      expect(getSkillFilePathValidationError(filePath)).toBe(
        'File names cannot use Windows reserved device names.',
      );
    },
  );
});
