// Static source checks cover both mutually exclusive Branch Info render paths
// without mounting the dialog's project, chat, and feature-flag dependencies.
// eslint-disable-next-line no-restricted-imports
import { readFileSync } from 'node:fs';
// eslint-disable-next-line no-restricted-imports
import { join } from 'node:path';

const readComponent = (name: string): string =>
  readFileSync(join(__dirname, '..', name), 'utf8');

const branchInfoSource = readComponent('WorktreeBranchInfoDialog.tsx');
const projectSettingsSource = readComponent('ProjectSettingsModal.tsx');
const workspaceSettingsSource = readComponent('WorkspaceSettingsModal.tsx');

describe('Code Graph surface integration contracts', () => {
  it('wires the feature-gated summary and actions into both Branch Info variants', () => {
    expect(branchInfoSource).toContain(
      "type BranchInfoTab = 'details' | 'pipelines' | 'code-graph'",
    );
    expect(branchInfoSource).toContain(
      "? ['details', 'pipelines', 'code-graph']",
    );
    expect(branchInfoSource).toContain(
      'window.api.codeGraphGetWorktreeSummary({',
    );
    expect(branchInfoSource).toContain('window.api.codeGraphBuildWorktree({');
    expect(branchInfoSource).toContain("openSettings('code-graph')");
    expect(branchInfoSource).not.toContain('ExperimentIcon');
    expect(branchInfoSource).toContain('<GraphIcon');
    expect(
      branchInfoSource.match(
        /\{effectiveBranchInfoTab === 'code-graph' && codeGraphPanel\}/g,
      ),
    ).toHaveLength(2);
    expect(branchInfoSource).toContain(
      'externalBuilding={isBuildingCodeGraph}',
    );
  });

  it.each([
    ['single-repo', projectSettingsSource],
    ['multi-repo', workspaceSettingsSource],
  ])(
    'wires the %s Settings modal tab, deep link, summary, actions, and 5xl width',
    (_variant, source) => {
      expect(source).toContain("| 'code-graph'");
      expect(source).toContain("id: 'code-graph'");
      expect(source).toContain('initialTab');
      expect(source).toContain('maxWidth="5xl"');
      expect(source).toContain('window.api.codeGraphGetWorkspaceSummary({');
      expect(source).toContain('window.api.codeGraphBuildWorkspace({');
      expect(source).toContain("openSettings('code-graph')");
      expect(source).toContain('icon: <GraphIcon width={14} height={14} />');
      expect(source).not.toContain('ExperimentIcon');
      expect(source).toContain(
        "activeTab === 'code-graph' && codeGraphExperimentEnabled",
      );
      expect(source).toContain(
        "!codeGraphExperimentEnabled && activeTab === 'code-graph'",
      );
    },
  );

  it('allows the single-repo modal to receive a Code Graph initial tab', () => {
    expect(projectSettingsSource).toMatch(/initialTab\?: ProjectTab;/);
    expect(projectSettingsSource).toContain("(initialTab ?? 'details')");
  });
});

describe('Auto Delete renderer integration contracts', () => {
  it('resets all single-repo Auto Delete drafts when the modal retargets', () => {
    expect(projectSettingsSource).toContain(
      'setPendingAutoArchiveEnabled(project.autoArchiveDays != null);',
    );
    expect(projectSettingsSource).toMatch(
      /setPendingAutoArchiveDays\(\s*project\.autoArchiveDays \?\? DEFAULT_AUTO_ARCHIVE_DAYS,?\s*\);/,
    );
    expect(projectSettingsSource).toMatch(
      /setPendingAutoArchiveDeleteBranch\(\s*project\.autoArchiveDeleteBranch === true,?\s*\);/,
    );
  });

  it('resets all multi-repo Auto Delete drafts when the modal retargets', () => {
    expect(
      workspaceSettingsSource.match(
        /setPendingAutoArchiveEnabled\(workspace\.autoArchiveDays != null\);/g,
      ),
    ).toHaveLength(2);
    expect(
      workspaceSettingsSource.match(
        /setPendingAutoArchiveDays\(\s*workspace\.autoArchiveDays \?\? DEFAULT_AUTO_ARCHIVE_DAYS,?\s*\);/g,
      ),
    ).toHaveLength(2);
    expect(
      workspaceSettingsSource.match(
        /setPendingAutoArchiveDeleteBranch\(\s*workspace\.autoArchiveDeleteBranch === true,?\s*\);/g,
      ),
    ).toHaveLength(2);
  });
});
