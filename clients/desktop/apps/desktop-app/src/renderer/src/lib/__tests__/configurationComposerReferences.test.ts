import type { ConfiguredPromptReference } from '@canopy/protocol/configured-prompt-references';
import {
  configuredFileReference,
  configuredReferenceLocatorMap,
  createConfiguredReferenceNamespace,
  resolveConfiguredEditorReferences,
  unresolvedConfiguredFiles,
} from '../configurationComposerReferences';

const first: ConfiguredPromptReference = {
  kind: 'file',
  textStart: 0,
  displayText: 'README.md',
  root: { kind: 'repo', repoId: 'first' },
  relativePath: 'README.md',
};
const second: ConfiguredPromptReference = {
  kind: 'file',
  textStart: 12,
  displayText: 'README.md',
  root: { kind: 'repo', repoId: 'second' },
  relativePath: 'README.md',
};

function locatorAt(
  locators: Map<string, ConfiguredPromptReference>,
  index: number,
): string {
  const candidate: unknown = Array.from(locators.keys())[index];
  if (typeof candidate !== 'string')
    throw new Error('reference locator missing');
  return candidate;
}

describe('configured composer reference identities', () => {
  it('keeps the surviving pill after deleting an earlier identical pill, typing, and undoing', () => {
    const namespace = createConfiguredReferenceNamespace();
    const locatorMap = configuredReferenceLocatorMap(
      [first, second],
      namespace,
    );
    const firstLocator = locatorAt(locatorMap, 0);
    const secondLocator = locatorAt(locatorMap, 1);
    const resolve = (absolutePaths: string[]): ConfiguredPromptReference[] =>
      resolveConfiguredEditorReferences({
        fileReferences: absolutePaths.map((absolutePath, index) => ({
          absolutePath,
          displayPath: 'README.md',
          textStart: index * 12,
        })),
        referenceByLocator: locatorMap,
        repos: [],
      });

    const afterDelete = resolve([secondLocator]);
    expect(afterDelete).toEqual([{ ...second, textStart: 0 }]);
    expect(resolve([secondLocator])).toEqual(afterDelete);
    expect(resolve([firstLocator, secondLocator])).toEqual([first, second]);
  });

  it('never maps a copied reference from one editor onto another editor reference', () => {
    const firstEditorLocators = configuredReferenceLocatorMap(
      [first],
      createConfiguredReferenceNamespace(),
    );
    const fromFirstEditor = locatorAt(firstEditorLocators, 0);
    const secondEditorLocators = configuredReferenceLocatorMap(
      [second],
      createConfiguredReferenceNamespace(),
    );
    expect(secondEditorLocators.has(fromFirstEditor)).toBe(false);
    expect(() =>
      resolveConfiguredEditorReferences({
        fileReferences: [
          {
            absolutePath: fromFirstEditor,
            displayPath: 'README.md',
            textStart: 0,
          },
        ],
        referenceByLocator: secondEditorLocators,
        repos: [],
      }),
    ).toThrow(/another composer/);
  });

  it('does not mistake a same-named child-repo file for a missing workspace-root reference', () => {
    const missing: ConfiguredPromptReference = {
      ...first,
      root: { kind: 'workspace' },
    };
    expect(
      unresolvedConfiguredFiles(
        [missing],
        [
          {
            repoId: 'child',
            repoName: 'child',
            absolutePath: '/repo/child',
            rootKind: 'git-repo',
            files: [
              {
                absolutePath: '/repo/child/README.md',
                relativePath: 'README.md',
                filename: 'README.md',
                isIgnored: false,
              },
            ],
          },
          {
            repoId: 'workspace',
            repoName: 'workspace',
            absolutePath: '/repo',
            rootKind: 'workspace-root',
            files: [],
          },
        ],
      ),
    ).toEqual([missing]);
  });

  it('keeps a nested cowork file relative to the live cowork root', () => {
    const absolutePath = '/cowork/live/.brand/notes/plan.md';
    const repos = [
      {
        repoId: 'cowork',
        repoName: 'live',
        absolutePath: '/cowork/live',
        rootKind: 'standalone' as const,
        files: [
          {
            absolutePath,
            relativePath: '.brand/notes/plan.md',
            filename: 'plan.md',
            isIgnored: false,
          },
        ],
      },
    ];
    const ref = configuredFileReference(
      {
        repoId: 'cowork',
        repoName: 'live',
        absolutePath,
        relativePath: '.brand/notes/plan.md',
        filename: 'plan.md',
      },
      repos,
      { kind: 'cowork' },
    );
    expect(ref).toMatchObject({
      kind: 'file',
      root: { kind: 'workspace' },
      relativePath: '.brand/notes/plan.md',
    });
    expect(unresolvedConfiguredFiles(ref ? [ref] : [], repos)).toEqual([]);
  });
});
