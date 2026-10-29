import {
  PLUGIN_MENTION_KIND,
  buildPluginMentionAbsolutePath,
} from '@canopy/desktop-shared/lib/plugin-mention';
import {
  APP_ADVISOR_PROJECT_ID,
  COWORK_WORKSPACE_FILE_ROOT_ID,
  WORKSPACE_ROOT_REPO_ID,
  type FileReference,
  type RepoFileIndex,
} from '@canopy/desktop-shared/types';
import {
  formatFileReferencePath,
  getCwdFromFileIndex,
  rewriteFileReferencesAcrossRepoRoots,
  rewriteFileReferencesForCwd,
  rewriteFileReferencesForTargetCwd,
} from '../file-reference-paths';

const noFiles: RepoFileIndex['files'] = [];

describe('formatFileReferencePath', () => {
  it('returns the absolute path when cwd is undefined', () => {
    expect(formatFileReferencePath('/repo/src/main.ts', undefined)).toBe(
      '/repo/src/main.ts',
    );
  });

  it('returns a cwd-relative path for files inside cwd', () => {
    expect(formatFileReferencePath('/repo/src/main.ts', '/repo')).toBe(
      'src/main.ts',
    );
  });

  it('returns the absolute path for files outside cwd', () => {
    expect(formatFileReferencePath('/elsewhere/file.ts', '/repo')).toBe(
      '/elsewhere/file.ts',
    );
  });

  it('returns the absolute path when cwd equals the file', () => {
    expect(formatFileReferencePath('/repo', '/repo')).toBe('/repo');
  });

  it('does not match a partial directory prefix', () => {
    expect(formatFileReferencePath('/repo-other/file.ts', '/repo')).toBe(
      '/repo-other/file.ts',
    );
  });

  it('returns a cwd-relative path for Windows drive-letter paths', () => {
    expect(formatFileReferencePath('C:\\repo\\src\\main.ts', 'C:\\repo')).toBe(
      'src\\main.ts',
    );
  });

  it('returns a cwd-relative path for Windows UNC paths', () => {
    expect(
      formatFileReferencePath(
        '\\\\server\\share\\repo\\src\\main.ts',
        '\\\\server\\share\\repo',
      ),
    ).toBe('src\\main.ts');
  });

  it('does not match a different Windows drive', () => {
    expect(formatFileReferencePath('D:\\repo\\src\\main.ts', 'C:\\repo')).toBe(
      'D:\\repo\\src\\main.ts',
    );
  });
});

describe('getCwdFromFileIndex', () => {
  const workspaceRoot: RepoFileIndex = {
    repoId: WORKSPACE_ROOT_REPO_ID,
    repoName: 'Workspace root',
    absolutePath: '/data/workspaces/ws/worktrees/wt',
    rootKind: 'workspace-root',
    files: noFiles,
  };
  const frontend: RepoFileIndex = {
    repoId: 'frontend',
    repoName: 'frontend',
    absolutePath: '/data/workspaces/ws/worktrees/wt/repos/frontend',
    rootKind: 'git-repo',
    files: noFiles,
  };
  const backend: RepoFileIndex = {
    repoId: 'backend',
    repoName: 'backend',
    absolutePath: '/data/workspaces/ws/worktrees/wt/repos/backend',
    rootKind: 'git-repo',
    files: noFiles,
  };

  it('resolves to the project root when no repo is selected', () => {
    expect(
      getCwdFromFileIndex([workspaceRoot, frontend, backend], undefined),
    ).toBe('/data/workspaces/ws/worktrees/wt');
  });

  it('treats the project root sentinel as the project root', () => {
    expect(
      getCwdFromFileIndex(
        [workspaceRoot, frontend, backend],
        WORKSPACE_ROOT_REPO_ID,
      ),
    ).toBe('/data/workspaces/ws/worktrees/wt');
  });

  it('resolves to the selected child repo when one is selected', () => {
    expect(
      getCwdFromFileIndex([workspaceRoot, frontend, backend], 'frontend'),
    ).toBe('/data/workspaces/ws/worktrees/wt/repos/frontend');
  });

  it('falls back to the only git-repo for single-repo projects', () => {
    const onlyRepo: RepoFileIndex = {
      repoId: 'app',
      repoName: 'app',
      absolutePath: '/repo',
      rootKind: 'git-repo',
      files: noFiles,
    };
    expect(getCwdFromFileIndex([onlyRepo], undefined)).toBe('/repo');
  });

  it('resolves the cowork project root to its own path (the agent cwd)', () => {
    const coworkWorkspace: RepoFileIndex = {
      repoId: COWORK_WORKSPACE_FILE_ROOT_ID,
      repoName: 'Workspace',
      absolutePath: '/data/workspaces/cw/home',
      rootKind: 'standalone',
      files: noFiles,
    };
    const notes: RepoFileIndex = {
      repoId: 'notes',
      repoName: 'notes',
      absolutePath: '/data/workspaces/cw/home/.canopy/notes',
      rootKind: 'standalone',
      files: noFiles,
    };
    expect(getCwdFromFileIndex([coworkWorkspace, notes], undefined)).toBe(
      '/data/workspaces/cw/home',
    );
  });

  it('resolves the App Advisor root to its own path (the agent cwd)', () => {
    const appAdvisorRoot: RepoFileIndex = {
      repoId: APP_ADVISOR_PROJECT_ID,
      repoName: APP_ADVISOR_PROJECT_ID,
      absolutePath: '/data/app-workspaces/app-advisor/home',
      rootKind: 'standalone',
      files: noFiles,
    };
    expect(getCwdFromFileIndex([appAdvisorRoot], undefined)).toBe(
      '/data/app-workspaces/app-advisor/home',
    );
  });

  it('keeps App Advisor references relative to the agent cwd', () => {
    const appAdvisorRoot: RepoFileIndex = {
      repoId: APP_ADVISOR_PROJECT_ID,
      repoName: APP_ADVISOR_PROJECT_ID,
      absolutePath: '/data/app-workspaces/app-advisor/home',
      rootKind: 'standalone',
      files: noFiles,
    };
    const cwd = getCwdFromFileIndex([appAdvisorRoot], undefined);
    const result = rewriteFileReferencesForCwd(
      'review report.md',
      [
        {
          displayPath: 'report.md',
          absolutePath: '/data/app-workspaces/app-advisor/home/report.md',
        },
      ],
      cwd,
    );

    expect(result.text).toBe('review report.md');
    expect(result.fileReferences[0]?.displayPath).toBe('report.md');
  });

  it('derives the chat project dir from a standalone root', () => {
    const notes: RepoFileIndex = {
      repoId: 'notes',
      repoName: 'notes',
      absolutePath: '/data/standalone-chat/proj/workspace/notes',
      rootKind: 'standalone',
      files: noFiles,
    };
    expect(getCwdFromFileIndex([notes], undefined)).toBe(
      '/data/standalone-chat/proj/workspace',
    );
  });

  it('derives the chat project dir from a Windows standalone root', () => {
    const notes: RepoFileIndex = {
      repoId: 'notes',
      repoName: 'notes',
      absolutePath: 'C:\\data\\standalone-chat\\proj\\workspace\\notes',
      rootKind: 'standalone',
      files: noFiles,
    };
    expect(getCwdFromFileIndex([notes], undefined)).toBe(
      'C:\\data\\standalone-chat\\proj\\workspace',
    );
  });
});

describe('rewriteFileReferencesForCwd', () => {
  it('returns the input unchanged when cwd is undefined', () => {
    const refs: FileReference[] = [
      {
        displayPath: 'frontend/src/main.ts',
        absolutePath: '/abs/repos/frontend/src/main.ts',
      },
    ];
    expect(
      rewriteFileReferencesForCwd('see frontend/src/main.ts', refs, undefined),
    ).toEqual({
      text: 'see frontend/src/main.ts',
      fileReferences: refs,
    });
  });

  it('rewrites both text and displayPath to the cwd-relative path', () => {
    const refs: FileReference[] = [
      {
        displayPath: 'frontend/src/main.ts',
        absolutePath: '/data/wt/repos/frontend/src/main.ts',
        repoName: 'frontend',
      },
    ];
    const result = rewriteFileReferencesForCwd(
      'review frontend/src/main.ts please',
      refs,
      '/data/wt',
    );
    expect(result.text).toBe('review repos/frontend/src/main.ts please');
    expect(result.fileReferences).toEqual([
      {
        displayPath: 'repos/frontend/src/main.ts',
        absolutePath: '/data/wt/repos/frontend/src/main.ts',
        repoName: 'frontend',
      },
    ]);
  });

  it('rewrites sibling-repo references to absolute paths when scoped to a child repo', () => {
    const refs: FileReference[] = [
      {
        displayPath: 'frontend/src/main.ts',
        absolutePath: '/data/wt/repos/frontend/src/main.ts',
        repoName: 'frontend',
      },
      {
        displayPath: 'backend/src/api.ts',
        absolutePath: '/data/wt/repos/backend/src/api.ts',
        repoName: 'backend',
      },
    ];
    const result = rewriteFileReferencesForCwd(
      'compare frontend/src/main.ts with backend/src/api.ts',
      refs,
      '/data/wt/repos/frontend',
    );
    expect(result.text).toBe(
      'compare src/main.ts with /data/wt/repos/backend/src/api.ts',
    );
    expect(result.fileReferences[0].displayPath).toBe('src/main.ts');
    expect(result.fileReferences[1].displayPath).toBe(
      '/data/wt/repos/backend/src/api.ts',
    );
  });

  it('rewrites repeated references in document order', () => {
    const ref: FileReference = {
      displayPath: 'frontend/src/main.ts',
      absolutePath: '/data/wt/repos/frontend/src/main.ts',
      repoName: 'frontend',
    };
    const result = rewriteFileReferencesForCwd(
      'see frontend/src/main.ts again at frontend/src/main.ts',
      [ref, ref],
      '/data/wt',
    );
    expect(result.text).toBe(
      'see repos/frontend/src/main.ts again at repos/frontend/src/main.ts',
    );
  });
});

describe('rewriteFileReferencesForTargetCwd', () => {
  const TARGET = '/data/workspaces/ws/worktrees/wt-new';

  it('re-roots a stale single-root reference (repo shadow) onto the target cwd via its displayPath', () => {
    const refs: FileReference[] = [
      {
        displayPath: 'src/main.ts',
        absolutePath: '/data/repo-shadows/k/checkout/src/main.ts',
      },
    ];
    expect(rewriteFileReferencesForTargetCwd(refs, TARGET)).toEqual([
      {
        displayPath: 'src/main.ts',
        absolutePath: '/data/workspaces/ws/worktrees/wt-new/src/main.ts',
      },
    ]);
  });

  it('re-roots a stale reference from a previously selected worktree onto the new target cwd', () => {
    const refs: FileReference[] = [
      {
        displayPath: 'docs/readme.md',
        absolutePath: '/data/workspaces/ws/worktrees/wt-old/docs/readme.md',
      },
    ];
    expect(rewriteFileReferencesForTargetCwd(refs, TARGET)).toEqual([
      {
        displayPath: 'docs/readme.md',
        absolutePath: '/data/workspaces/ws/worktrees/wt-new/docs/readme.md',
      },
    ]);
  });

  it('leaves a reference already inside the target cwd unchanged', () => {
    const refs: FileReference[] = [
      {
        displayPath: 'src/main.ts',
        absolutePath: '/data/workspaces/ws/worktrees/wt-new/src/main.ts',
      },
    ];
    expect(rewriteFileReferencesForTargetCwd(refs, TARGET)).toEqual(refs);
  });

  it('leaves an absolute-displayPath reference (attachment-root pill) unchanged', () => {
    const refs: FileReference[] = [
      {
        displayPath: '/tmp/attachments/pasted.png',
        absolutePath: '/tmp/attachments/pasted.png',
      },
    ];
    expect(rewriteFileReferencesForTargetCwd(refs, TARGET)).toEqual(refs);
  });

  it('leaves a repoName-carrying (multi-root-sourced) reference unchanged — original root is ambiguous', () => {
    const refs: FileReference[] = [
      {
        displayPath: 'frontend/src/main.ts',
        absolutePath:
          '/data/workspaces/ws/worktrees/wt-old/repos/frontend/src/main.ts',
        repoName: 'frontend',
      },
    ];
    expect(rewriteFileReferencesForTargetCwd(refs, TARGET)).toEqual(refs);
  });

  it('leaves a reference whose absolutePath does not end with its displayPath unchanged', () => {
    const refs: FileReference[] = [
      {
        displayPath: 'src/renamed.ts',
        absolutePath: '/data/repo-shadows/k/checkout/src/main.ts',
      },
    ];
    expect(rewriteFileReferencesForTargetCwd(refs, TARGET)).toEqual(refs);
  });

  it("leaves '.'/'..' displayPaths unchanged", () => {
    const refs: FileReference[] = [
      { displayPath: '.', absolutePath: '/data/repo-shadows/k/checkout' },
      {
        displayPath: '../outside.ts',
        absolutePath: '/data/outside.ts',
      },
    ];
    expect(rewriteFileReferencesForTargetCwd(refs, TARGET)).toEqual(refs);
  });

  it('re-roots Windows-style stale references', () => {
    const refs: FileReference[] = [
      {
        displayPath: 'src\\main.ts',
        absolutePath: 'C:\\shadows\\k\\checkout\\src\\main.ts',
      },
    ];
    expect(
      rewriteFileReferencesForTargetCwd(
        refs,
        'C:\\workspaces\\ws\\worktrees\\wt-new',
      ),
    ).toEqual([
      {
        displayPath: 'src\\main.ts',
        absolutePath: 'C:\\workspaces\\ws\\worktrees\\wt-new\\src\\main.ts',
      },
    ]);
  });
});

describe('rewriteFileReferencesAcrossRepoRoots', () => {
  function makeIndexRepo(
    repoId: string,
    absolutePath: string,
    overrides?: Partial<RepoFileIndex>,
  ): RepoFileIndex {
    return {
      repoId,
      repoName: repoId,
      absolutePath,
      rootKind: 'git-repo',
      files: noFiles,
      ...overrides,
    };
  }

  const SOURCE_REPOS: RepoFileIndex[] = [
    makeIndexRepo(WORKSPACE_ROOT_REPO_ID, '/shadows/src/checkout', {
      rootKind: 'workspace-root',
    }),
    makeIndexRepo('web', '/shadows/web/checkout'),
    makeIndexRepo('api', '/shadows/api/checkout'),
  ];
  const TARGET_REPOS: RepoFileIndex[] = [
    makeIndexRepo(WORKSPACE_ROOT_REPO_ID, '/ws/worktrees/wt-1', {
      rootKind: 'workspace-root',
    }),
    makeIndexRepo('web', '/ws/worktrees/wt-1/repos/web'),
    makeIndexRepo('api', '/ws/worktrees/wt-1/repos/api'),
  ];

  it('re-roots repoName-carrying pills onto the target root with the same repoId', () => {
    const refs: FileReference[] = [
      {
        displayPath: 'web/src/App.tsx',
        absolutePath: '/shadows/web/checkout/src/App.tsx',
        repoName: 'web',
      },
      {
        displayPath: 'README.md',
        absolutePath: '/shadows/src/checkout/README.md',
        repoName: 'Workspace root',
      },
    ];
    expect(
      rewriteFileReferencesAcrossRepoRoots(refs, SOURCE_REPOS, TARGET_REPOS),
    ).toEqual([
      {
        displayPath: 'web/src/App.tsx',
        absolutePath: '/ws/worktrees/wt-1/repos/web/src/App.tsx',
        repoName: 'web',
      },
      {
        displayPath: 'README.md',
        absolutePath: '/ws/worktrees/wt-1/README.md',
        repoName: 'Workspace root',
      },
    ]);
  });

  it('leaves references already inside a target root unchanged', () => {
    const refs: FileReference[] = [
      {
        displayPath: 'src/App.tsx',
        absolutePath: '/ws/worktrees/wt-1/repos/web/src/App.tsx',
        repoName: 'web',
      },
    ];
    expect(
      rewriteFileReferencesAcrossRepoRoots(refs, SOURCE_REPOS, TARGET_REPOS),
    ).toEqual(refs);
  });

  it('prefers the deepest containing source root when roots nest', () => {
    const nestedSources: RepoFileIndex[] = [
      makeIndexRepo(WORKSPACE_ROOT_REPO_ID, '/old/worktree', {
        rootKind: 'workspace-root',
      }),
      makeIndexRepo('web', '/old/worktree/repos/web'),
    ];
    const refs: FileReference[] = [
      {
        displayPath: 'src/App.tsx',
        absolutePath: '/old/worktree/repos/web/src/App.tsx',
        repoName: 'web',
      },
    ];
    expect(
      rewriteFileReferencesAcrossRepoRoots(refs, nestedSources, TARGET_REPOS),
    ).toEqual([
      {
        displayPath: 'src/App.tsx',
        absolutePath: '/ws/worktrees/wt-1/repos/web/src/App.tsx',
        repoName: 'web',
      },
    ]);
  });

  it('passes through references outside every source root and repoIds missing from the target', () => {
    const refs: FileReference[] = [
      {
        displayPath: '/tmp/attachments/pasted.png',
        absolutePath: '/tmp/attachments/pasted.png',
      },
      {
        displayPath: 'src/gone.ts',
        absolutePath: '/shadows/removed/checkout/src/gone.ts',
        repoName: 'removed',
      },
    ];
    expect(
      rewriteFileReferencesAcrossRepoRoots(refs, SOURCE_REPOS, TARGET_REPOS),
    ).toEqual(refs);

    const targetsWithoutWeb = TARGET_REPOS.filter(
      (repo) => repo.repoId !== 'web',
    );
    const webRef: FileReference[] = [
      {
        displayPath: 'web/src/App.tsx',
        absolutePath: '/shadows/web/checkout/src/App.tsx',
        repoName: 'web',
      },
    ];
    expect(
      rewriteFileReferencesAcrossRepoRoots(
        webRef,
        SOURCE_REPOS,
        targetsWithoutWeb,
      ),
    ).toEqual(webRef);
  });

  it('returns the references untouched when either index is empty', () => {
    const refs: FileReference[] = [
      {
        displayPath: 'src/App.tsx',
        absolutePath: '/shadows/web/checkout/src/App.tsx',
      },
    ];
    expect(rewriteFileReferencesAcrossRepoRoots(refs, [], TARGET_REPOS)).toBe(
      refs,
    );
    expect(rewriteFileReferencesAcrossRepoRoots(refs, SOURCE_REPOS, [])).toBe(
      refs,
    );
  });
});

describe('rewriteFileReferencesForCwd with plugin mentions', () => {
  it('leaves a plugin mention pill and its inline token untouched', () => {
    const refs: FileReference[] = [
      {
        displayPath: 'figma',
        absolutePath: buildPluginMentionAbsolutePath({
          marketplaceId: 'claude-plugins-official',
          pluginName: 'figma',
        }),
        kind: PLUGIN_MENTION_KIND,
      },
      {
        displayPath: 'src/main.ts',
        absolutePath: '/repo/src/main.ts',
      },
    ];
    const result = rewriteFileReferencesForCwd(
      'Use figma on src/main.ts',
      refs,
      '/repo',
    );
    expect(result.text).toBe('Use figma on src/main.ts');
    expect(result.fileReferences).toEqual(refs);
  });
});
