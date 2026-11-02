jest.mock('../lib/canopy-json', () => ({
  readCanopyJson: jest.fn(),
}));
jest.mock('../lib/preferences-store', () => ({
  readPreferencesFile: jest.fn(),
}));
jest.mock('../lib/resolve-worktree', () => ({
  resolveWorktreeCwd: jest.fn(),
}));
jest.mock('../lib/workspace-source', () => ({
  readEffectiveWorkspaceConfig: jest.fn(),
}));

import { readCanopyJson } from '../lib/canopy-json';
import { readPreferencesFile } from '../lib/preferences-store';
import { resolveWorktreeCwd } from '../lib/resolve-worktree';
import { readEffectiveWorkspaceConfig } from '../lib/workspace-source';
import { resolveWorktreePlanDetectionRules } from '../lib/plan-detection-config';

const mockedReadCanopyJson = jest.mocked(readCanopyJson);
const mockedReadPreferencesFile = jest.mocked(readPreferencesFile);
const mockedResolveWorktreeCwd = jest.mocked(resolveWorktreeCwd);
const mockedReadEffectiveWorkspaceConfig = jest.mocked(
  readEffectiveWorkspaceConfig,
);
type PreferencesFile = Awaited<ReturnType<typeof readPreferencesFile>>;
type EffectiveWorkspaceConfig = Awaited<
  ReturnType<typeof readEffectiveWorkspaceConfig>
>;

describe('resolveWorktreePlanDetectionRules', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    const preferences: Partial<PreferencesFile> = {
      planDetection: {
        disabledBuiltinRuleIds: [],
        customRules: [],
      },
    };
    // A partial fixture: these tests rely on unset preferences staying undefined.
    mockedReadPreferencesFile.mockResolvedValue(preferences as PreferencesFile);
    mockedReadEffectiveWorkspaceConfig.mockResolvedValue({
      manifest: null,
      localConfig: {},
    } as EffectiveWorkspaceConfig);
    mockedResolveWorktreeCwd.mockReturnValue('/worktrees/proj-1/wt-1');
  });

  it('includes worktree canopy.json plan-detection rules when effective manifest is absent', async () => {
    mockedReadCanopyJson.mockResolvedValue({
      version: 1,
      planDetection: {
        rules: [
          {
            id: 'repo-plan',
            label: 'Repo Plan',
            kind: 'include',
            pattern: 'docs/repo-plan.md',
            enabled: true,
          },
        ],
      },
    });

    const result = await resolveWorktreePlanDetectionRules('proj-1', 'wt-1');

    expect(mockedResolveWorktreeCwd).toHaveBeenCalledWith('proj-1', 'wt-1');
    expect(mockedReadCanopyJson).toHaveBeenCalledWith('/worktrees/proj-1/wt-1');
    expect(result.includes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'repo-plan',
          pattern: 'docs/repo-plan.md',
        }),
      ]),
    );
  });

  it('does not read worktree canopy.json when an effective manifest is present', async () => {
    mockedReadEffectiveWorkspaceConfig.mockResolvedValue({
      manifest: {
        version: 1,
        planDetection: {
          rules: [
            {
              id: 'manifest-plan',
              label: 'Manifest Plan',
              kind: 'include',
              pattern: 'docs/manifest-plan.md',
              enabled: true,
            },
          ],
        },
      },
      localConfig: {},
    } as EffectiveWorkspaceConfig);

    const result = await resolveWorktreePlanDetectionRules('proj-1', 'wt-1');

    expect(mockedReadCanopyJson).not.toHaveBeenCalled();
    expect(result.includes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'manifest-plan',
          pattern: 'docs/manifest-plan.md',
        }),
      ]),
    );
  });
});
