import { buildCodexSessionDynamicToolSpecs } from '../codex/session-dynamic-tools';
import { buildCanopyDynamicToolSpecs } from '../codex/canopy-dynamic-tools';
import { buildAppAdvisorDynamicToolSpecs } from '../app-advisor/codex-dynamic-tools';
import { buildPipelineEditorDynamicToolSpecs } from '../pipeline-editor/codex-dynamic-tools';

jest.mock('../codex/canopy-dynamic-tools', () => ({
  buildCanopyDynamicToolSpecs: jest.fn(() => [{ name: 'default' }]),
}));
jest.mock('../app-advisor/codex-dynamic-tools', () => ({
  buildAppAdvisorDynamicToolSpecs: jest.fn(() => [{ name: 'app-advisor' }]),
}));
jest.mock('../pipeline-editor/codex-dynamic-tools', () => ({
  buildPipelineEditorDynamicToolSpecs: jest.fn(() => [
    { name: 'pipeline-editor' },
  ]),
}));

describe('buildCodexSessionDynamicToolSpecs', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('preserves every default-session tool-profile input', () => {
    buildCodexSessionDynamicToolSpecs({
      assistantMode: 'default',
      workspaceMode: 'worktree',
      isCodeReview: true,
      includeCodeGraph: false,
      includeChatVisuals: true,
      toolSchemaProfile: 'flat',
    });

    expect(buildCanopyDynamicToolSpecs).toHaveBeenCalledWith({
      mode: 'worktree',
      includeCodeGraph: false,
      includeChatVisuals: true,
      includeLedger: false,
      isCodeReview: true,
      toolSchemaProfile: 'flat',
    });
  });

  it('passes the Ledger exposure decision through', () => {
    buildCodexSessionDynamicToolSpecs({
      assistantMode: 'default',
      workspaceMode: 'cowork',
      isCodeReview: false,
      includeCodeGraph: false,
      includeChatVisuals: false,
      includeLedger: true,
      toolSchemaProfile: 'standard',
    });

    expect(buildCanopyDynamicToolSpecs).toHaveBeenCalledWith({
      mode: 'cowork',
      includeCodeGraph: false,
      includeChatVisuals: false,
      includeLedger: true,
      isCodeReview: false,
      toolSchemaProfile: 'standard',
    });
  });

  it.each([true, false, undefined])(
    'passes the Ledger exposure decision %s to the App Advisor tools',
    (includeLedger) => {
      buildCodexSessionDynamicToolSpecs({
        assistantMode: 'app-advisor',
        workspaceMode: 'worktree',
        isCodeReview: false,
        includeCodeGraph: true,
        includeChatVisuals: false,
        ...(includeLedger === undefined ? {} : { includeLedger }),
        toolSchemaProfile: 'standard',
      });

      expect(buildAppAdvisorDynamicToolSpecs).toHaveBeenCalledWith({
        includeLedger: includeLedger === true,
      });
      expect(buildCanopyDynamicToolSpecs).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['app-advisor', buildAppAdvisorDynamicToolSpecs],
    ['pipeline-editor', buildPipelineEditorDynamicToolSpecs],
  ] as const)(
    'preserves the %s-specific tool profile',
    (assistantMode, build) => {
      buildCodexSessionDynamicToolSpecs({
        assistantMode,
        workspaceMode: 'worktree',
        isCodeReview: false,
        includeCodeGraph: true,
        includeChatVisuals: false,
        toolSchemaProfile: 'standard',
      });

      expect(build).toHaveBeenCalledTimes(1);
      expect(buildCanopyDynamicToolSpecs).not.toHaveBeenCalled();
    },
  );
});
