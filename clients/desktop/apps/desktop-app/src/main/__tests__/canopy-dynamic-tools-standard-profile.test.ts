const mockApplyToolSchemaProfile = jest.fn((schema: unknown) => schema);

jest.mock('../codex/tool-schema-profile', () => ({
  applyToolSchemaProfile: (...args: [unknown, 'standard' | 'flat']): unknown =>
    mockApplyToolSchemaProfile(...args),
}));

import { buildCanopyDynamicToolSpecs } from '../codex/canopy-dynamic-tools';

describe('canopy dynamic tools standard schema profile', () => {
  beforeEach(() => {
    mockApplyToolSchemaProfile.mockClear();
  });

  it('skips schema projection for the standard profile', () => {
    buildCanopyDynamicToolSpecs({
      includeChatVisuals: false,
      toolSchemaProfile: 'standard',
    });

    expect(mockApplyToolSchemaProfile).not.toHaveBeenCalled();
  });

  it('projects schemas for the flat profile', () => {
    buildCanopyDynamicToolSpecs({
      includeChatVisuals: false,
      toolSchemaProfile: 'flat',
    });

    expect(mockApplyToolSchemaProfile).toHaveBeenCalled();
    for (const call of mockApplyToolSchemaProfile.mock.calls) {
      expect(call[1]).toBe('flat');
    }
  });
});
