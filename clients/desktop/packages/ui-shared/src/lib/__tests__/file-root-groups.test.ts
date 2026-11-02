import {
  isCoworkWorkspaceFileRoot,
  partitionFileRoots,
  type FileRootIdentity,
} from '../file-root-groups';

interface Root extends FileRootIdentity {
  readonly label: string;
}

const root = (
  id: string,
  kind: FileRootIdentity['kind'],
  label: string = id,
): Root => ({ id, kind, label });

const partition = (
  roots: readonly Root[],
): { primary: string[]; appManaged: string[] } => {
  const groups = partitionFileRoots(roots, (entry) => entry);
  return {
    primary: groups.primary.map((entry) => entry.id),
    appManaged: groups.appManaged.map((entry) => entry.id),
  };
};

describe('partitionFileRoots', () => {
  it('groups Cowork notes, prompts, and visible attachments in catalog order', () => {
    expect(
      partition([
        root('workspace', 'standalone', 'Vendor Spend Q3'),
        root('notes', 'standalone'),
        root('prompts', 'standalone'),
        root('attachments', 'attachments'),
      ]),
    ).toEqual({
      primary: ['workspace'],
      appManaged: ['notes', 'prompts', 'attachments'],
    });
  });

  it('omits attachments from the group when the catalog hides them', () => {
    expect(
      partition([
        root('workspace', 'standalone'),
        root('notes', 'standalone'),
        root('prompts', 'standalone'),
      ]).appManaged,
    ).toEqual(['notes', 'prompts']);
  });

  it('returns an empty group for a Cowork catalog without managed roots', () => {
    expect(partition([root('workspace', 'standalone')])).toEqual({
      primary: ['workspace'],
      appManaged: [],
    });
  });

  it('keeps unknown and unclassified roots visible and ungrouped', () => {
    expect(
      partition([
        root('workspace', 'standalone'),
        root('extra', 'standalone'),
        root('notes', undefined),
        root('prompts', 'standalone'),
      ]),
    ).toEqual({
      primary: ['workspace', 'extra', 'notes'],
      appManaged: ['prompts'],
    });
  });

  it('classifies by identity, not duplicate display names', () => {
    expect(
      partition([
        root('workspace', 'standalone', 'notes'),
        root('notes', 'standalone', 'notes'),
      ]),
    ).toEqual({ primary: ['workspace'], appManaged: ['notes'] });
  });

  it.each([
    [
      'a git repository whose id is workspace',
      [root('workspace', 'git-repo'), root('attachments', 'attachments')],
    ],
    [
      'an App Advisor standalone root',
      [root('app-advisor', 'standalone'), root('notes', 'standalone')],
    ],
    [
      'an older host without root kinds',
      [root('workspace', undefined), root('notes', undefined)],
    ],
    [
      'an ambiguous catalog with two Cowork roots',
      [
        root('workspace', 'standalone'),
        root('workspace', 'standalone'),
        root('notes', 'standalone'),
      ],
    ],
  ])('does not group %s', (_name, roots) => {
    expect(partition(roots).appManaged).toEqual([]);
    expect(partition(roots).primary).toHaveLength(roots.length);
  });
});

describe('isCoworkWorkspaceFileRoot', () => {
  it('requires both the Cowork id and the standalone kind', () => {
    expect(isCoworkWorkspaceFileRoot(root('workspace', 'standalone'))).toBe(
      true,
    );
    expect(isCoworkWorkspaceFileRoot(root('workspace', 'git-repo'))).toBe(
      false,
    );
    expect(isCoworkWorkspaceFileRoot(root('workspace', undefined))).toBe(false);
  });
});
