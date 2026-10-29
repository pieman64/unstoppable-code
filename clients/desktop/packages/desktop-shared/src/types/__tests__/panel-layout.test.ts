import {
  isPanelLayoutModeFileV1,
  isWorkspaceLayoutMode,
  WORKSPACE_LAYOUT_MODES,
} from '../panel-layout';

describe('project layout mode transport types', () => {
  it('accepts only the declared project layout modes', () => {
    expect(WORKSPACE_LAYOUT_MODES).toEqual(['minimal', 'advanced']);
    expect(isWorkspaceLayoutMode('minimal')).toBe(true);
    expect(isWorkspaceLayoutMode('advanced')).toBe(true);

    for (const value of [null, undefined, '', 'basic', 'Minimal', 1, {}]) {
      expect(isWorkspaceLayoutMode(value)).toBe(false);
    }
  });

  it('accepts only complete version-1 mode files', () => {
    expect(isPanelLayoutModeFileV1({ version: 1, mode: 'minimal' })).toBe(true);
    expect(isPanelLayoutModeFileV1({ version: 1, mode: 'advanced' })).toBe(
      true,
    );

    expect(isPanelLayoutModeFileV1(null)).toBe(false);
    expect(isPanelLayoutModeFileV1({ version: 2, mode: 'minimal' })).toBe(
      false,
    );
    expect(isPanelLayoutModeFileV1({ version: 1, mode: 'basic' })).toBe(false);
    expect(isPanelLayoutModeFileV1({ version: 1 })).toBe(false);
  });
});
