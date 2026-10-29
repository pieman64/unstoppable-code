import { renderToString } from 'react-dom/server';
import type { WorkspaceSettingsDataResponse } from '@canopy/desktop-shared/types';
import { WorkspaceHealthIssuesBlock } from '../WorktreeSettingsControls';
import { workspaceHealthIssueClassName } from '../workspace-health-styles';

function makeHealthData(blocking: boolean): WorkspaceSettingsDataResponse {
  return {
    driftIssues: [
      {
        code: blocking ? 'invalid-canopy-json' : 'missing-canopy-json',
        message: blocking ? 'The file is invalid' : 'The file is optional',
        blocking,
      },
    ],
    driftTargetPath: '/workspace/canopy.json',
    manifest: null,
    localConfig: { version: 1, type: 'single-repo', repos: [] },
    effectiveRepos: [],
    suppressedManifestRepos: [],
    unresolvedManifestRepoIds: [],
  };
}

describe('WorkspaceHealthIssuesBlock theme contrast', () => {
  it('uses semantic warning colors instead of dark-theme-only amber text', () => {
    const html = renderToString(
      <WorkspaceHealthIssuesBlock healthData={makeHealthData(false)} />,
    );

    expect(html).toContain('border-line-attention/30');
    expect(html).toContain('bg-warning-subtle');
    expect(html).toContain('fg-warning');
    expect(html).not.toContain('text-amber-200');
  });

  it('uses semantic destructive colors for blocking issues', () => {
    const html = renderToString(
      <WorkspaceHealthIssuesBlock healthData={makeHealthData(true)} />,
    );

    expect(html).toContain('border-line-destructive/30');
    expect(html).toContain('bg-destructive-subtle');
    expect(html).toContain('fg-destructive');
    expect(html).not.toContain('text-rose-200');
  });

  it('shares the same issue colors with the repair dialog', () => {
    expect(workspaceHealthIssueClassName(false)).toBe(
      'border-line-attention/30 bg-warning-subtle fg-warning',
    );
    expect(workspaceHealthIssueClassName(true)).toBe(
      'border-line-destructive/30 bg-destructive-subtle fg-destructive',
    );
  });
});
