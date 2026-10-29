import {
  isSkillEditorSaveEnabled,
  resolveSupportingFilePaths,
  skillEditorSnapshot,
} from '../skill-edit-safety';

describe('resolveSupportingFilePaths', () => {
  it('does not convert an enumeration failure into an empty editable set', () => {
    expect(
      resolveSupportingFilePaths({
        success: false,
        error: 'enumeration failed',
      }),
    ).toEqual({
      success: false,
      error: 'enumeration failed',
    });
  });

  it('returns only supporting file paths after a successful enumeration', () => {
    expect(
      resolveSupportingFilePaths({
        success: true,
        data: {
          files: ['SKILL.md', 'references/api.md'],
          truncated: false,
        },
      }),
    ).toEqual({
      success: true,
      paths: ['references/api.md'],
    });
  });

  it('blocks saving when enumeration is only a truncated preview', () => {
    expect(
      resolveSupportingFilePaths({
        success: true,
        data: {
          files: ['SKILL.md', 'references/api.md'],
          truncated: true,
        },
      }),
    ).toEqual({
      success: false,
      error:
        'This skill has too many files to load safely. Saving is disabled to protect files that were not listed.',
    });
  });
});

describe('isSkillEditorSaveEnabled', () => {
  it('keeps saving disabled until supporting files are safely loaded', () => {
    expect(
      isSkillEditorSaveEnabled({
        saving: false,
        loading: false,
        supportingFilesReady: false,
        hasContent: true,
      }),
    ).toBe(false);
  });
});

describe('skillEditorSnapshot', () => {
  const base = {
    name: 'review',
    description: 'Checklist',
    body: '# Review',
    metadata: [{ key: 'license', value: 'MIT' }],
    files: [{ path: 'notes.md', content: 'a', editable: true }],
  };

  it('matches for the same fields', () => {
    expect(skillEditorSnapshot(base)).toBe(skillEditorSnapshot({ ...base }));
  });

  it.each([
    ['name', { name: 'review-2' }],
    ['description', { description: 'Changed' }],
    ['body', { body: '# Changed' }],
    ['metadata', { metadata: [{ key: 'license', value: 'Apache-2.0' }] }],
    ['files', { files: [{ path: 'notes.md', content: 'b', editable: true }] }],
  ])('changes when the %s changes', (_field, change) => {
    expect(skillEditorSnapshot({ ...base, ...change })).not.toBe(
      skillEditorSnapshot(base),
    );
  });
});
