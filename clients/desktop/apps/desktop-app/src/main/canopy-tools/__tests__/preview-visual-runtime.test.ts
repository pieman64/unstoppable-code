import { executePreviewVisual } from '../preview-visual-runtime';
import { getVisualPreviewService } from '../../browser/visual-preview-service';
import { VISUAL_PREVIEW_BUDGETS } from '../../browser/visual-preview-types';

jest.mock('../../browser/visual-preview-service', () => ({
  getVisualPreviewService: jest.fn(),
}));

const host = {
  scope: { projectId: 'project', worktreeId: 'worktree' },
  cwd: '/workspace',
};
const preview = jest.fn();
beforeEach(() => {
  preview.mockReset();
  jest
    .mocked(getVisualPreviewService)
    .mockReturnValue({ preview, measure: jest.fn() });
});

it('passes trusted preparation and budget without staging, and returns concise diagnostics', async () => {
  preview.mockResolvedValue({
    status: 'ok',
    image: {
      dataUrl: 'data:image/png;base64,YQ==',
      mime: 'image/png',
      width: 720,
      height: 100,
      bytes: 1,
    },
    contentHeight: 250,
    capturedHeight: 100,
    console: [{ level: 'log', message: 'page says hi' }],
    cspViolations: [
      { directive: 'connect-src', blockedUri: 'https://evil.test' },
    ],
    blockedRequests: ['https://evil.test'],
    omitted: { console: 0, cspViolations: 0, blockedRequests: 0 },
    timing: { queuedMs: 0, loadMs: 1, settleMs: 1, captureMs: 1, totalMs: 3 },
  });
  const result = await executePreviewVisual({ html: '<p>ok</p>' }, host, {
    imageBudgetBytes: VISUAL_PREVIEW_BUDGETS.claudeImageBytes,
  });
  expect(preview).toHaveBeenCalledWith(
    expect.objectContaining({
      width: 720,
      imageBudgetBytes: VISUAL_PREVIEW_BUDGETS.claudeImageBytes,
      prepared: { html: '<p>ok</p>', unresolvedImagePaths: [] },
    }),
  );
  expect(result.imageDataUrl).toBe('data:image/png;base64,YQ==');
  expect(result.text).toContain(
    'Content height: 250px; captured height: 100px',
  );
  expect(result.text).toContain('untrusted page output');
  expect(result.text).toContain('not a complete network log');
});

it('explains Cursor no-image and rejects invalid HTML before rendering', async () => {
  preview.mockResolvedValue({
    status: 'ok',
    image: null,
    contentHeight: 100,
    capturedHeight: 100,
    console: [],
    cspViolations: [],
    blockedRequests: [],
    omitted: { console: 0, cspViolations: 0, blockedRequests: 0 },
    timing: { queuedMs: 0, loadMs: 0, settleMs: 0, captureMs: 0, totalMs: 0 },
  });
  expect(
    (
      await executePreviewVisual({ html: '<p>ok</p>' }, host, {
        imageBudgetBytes: 0,
      })
    ).text,
  ).toContain("A screenshot isn't available in Cursor chats.");
  expect(
    (
      await executePreviewVisual({ html: '\u0000' }, host, {
        imageBudgetBytes: 0,
      })
    ).isError,
  ).toBe(true);
  expect(preview).toHaveBeenCalledTimes(1);
});
