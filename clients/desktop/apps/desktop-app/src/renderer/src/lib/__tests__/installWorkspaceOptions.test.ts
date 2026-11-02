import { toInstallWorkspaceOptions } from '../installWorkspaceOptions';

describe('toInstallWorkspaceOptions', () => {
  it('marks only a multi-repo project with no source root as lacking a project folder', () => {
    expect(
      toInstallWorkspaceOptions([
        { id: 'single', name: 'Single', type: 'single-repo' },
        { id: 'cowork', name: 'Cowork', type: 'cowork' },
        {
          id: 'rooted',
          name: 'Rooted',
          type: 'multi-repo',
          sourceRepoPath: '/repos/root',
        },
        { id: 'rootless', name: 'Rootless', type: 'multi-repo' },
      ]),
    ).toEqual([
      { id: 'single', name: 'Single', type: 'single-repo' },
      { id: 'cowork', name: 'Cowork', type: 'cowork' },
      { id: 'rooted', name: 'Rooted', type: 'multi-repo' },
      {
        id: 'rootless',
        name: 'Rootless',
        type: 'multi-repo',
        lacksProjectFolder: true,
      },
    ]);
  });
});
