import { isPipelineEditorRendererToolRequest } from '../types';

describe('Pipeline Editor renderer transport guards', () => {
  it('accepts valid renderer tool requests', () => {
    expect(
      isPipelineEditorRendererToolRequest({
        kind: 'set_yaml',
        requestId: 'request-1',
        yaml: 'pipeline:\n  name: Build',
      }),
    ).toBe(true);
    expect(
      isPipelineEditorRendererToolRequest({
        kind: 'open',
        requestId: 'request-2',
        locator: {
          pipelineId: 'build',
          cwd: '/repo',
          pipelineFilePath: '/repo/.canopy/pipelines/build.yaml',
        },
      }),
    ).toBe(true);
  });

  it('rejects malformed renderer tool requests', () => {
    expect(
      isPipelineEditorRendererToolRequest({
        kind: 'set_yaml',
        requestId: 'request-1',
        yaml: 123,
      }),
    ).toBe(false);
    expect(
      isPipelineEditorRendererToolRequest({
        kind: 'open',
        requestId: 'request-2',
        locator: { pipelineId: 123 },
      }),
    ).toBe(false);
    expect(
      isPipelineEditorRendererToolRequest({
        kind: 'unknown',
        requestId: 'request-3',
      }),
    ).toBe(false);
  });
});
