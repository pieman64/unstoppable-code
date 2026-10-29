import { createShowVisualHost } from '../show-visual-host';
import { getVisualPreviewService } from '../../browser/visual-preview-service';

jest.mock('../../browser/visual-preview-service', () => ({
  getVisualPreviewService: jest.fn(),
}));

test('passes prepared HTML and the abortable measurement request to the lazy service', async () => {
  const measure = jest.fn(() =>
    Promise.resolve({
      status: 'ok' as const,
      heights: [[360, 180]] as ReadonlyArray<readonly [number, number]>,
    }),
  );
  jest.mocked(getVisualPreviewService).mockReturnValue({
    measure,
    preview: jest.fn(),
  });
  const host = createShowVisualHost({
    projectId: 'project',
    worktreeId: 'worktree',
    chatId: 'chat',
    cwd: '/workspace',
  });
  expect(getVisualPreviewService).not.toHaveBeenCalled();
  const prepared = { html: '<p>Chart</p>', unresolvedImagePaths: [] };
  const controller = new AbortController();
  const options = {
    maxHeight: 600,
    widths: [360],
    deadlineMs: 3000,
    signal: controller.signal,
  };
  await expect(host.measureVisual?.(prepared, options)).resolves.toEqual({
    status: 'ok',
    heights: [[360, 180]],
  });
  expect(measure).toHaveBeenCalledWith({ prepared, ...options });
});
