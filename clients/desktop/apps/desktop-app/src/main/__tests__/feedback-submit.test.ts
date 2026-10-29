import type { FeedbackSubmitRequest } from '@canopy/desktop-shared/types';
import { requestCanopyCloudJson } from '../canopy-cloud/client';
import { prepareFeedbackBundle } from '../feedback/feedback-bundle';
import { submitFeedback } from '../feedback/feedback-submit';

jest.mock('../canopy-cloud/client', () => ({
  requestCanopyCloudJson: jest.fn(),
}));

jest.mock('../feedback/feedback-bundle', () => ({
  prepareFeedbackBundle: jest.fn(),
}));

const mockReadFile = jest.fn();
const mockRm = jest.fn();
jest.mock('node:fs/promises', () => ({
  readFile: (...args: unknown[]): unknown => mockReadFile(...args),
  rm: (...args: unknown[]): unknown => mockRm(...args),
}));

const mockedRequest = jest.mocked(requestCanopyCloudJson);
const mockedPrepare = jest.mocked(prepareFeedbackBundle);
const fetchMock: jest.MockedFunction<typeof fetch> = jest.fn();
const originalFetch = global.fetch;

const baseRequest: FeedbackSubmitRequest = {
  type: 'bug',
  description: 'The diff view crashed',
  context: {
    activePage: 'main',
    workspaceId: 'ws-1',
    worktreeId: 'wt-1',
  },
  includeDiagnostics: true,
};

describe('submitFeedback', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockReadFile.mockResolvedValue(Buffer.from('zip-bytes'));
    mockRm.mockResolvedValue(undefined);
    fetchMock.mockResolvedValue(new Response(null, { status: 200 }));
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('builds a temp bundle, files the report, uploads, commits, and cleans up', async () => {
    mockedPrepare.mockResolvedValue({
      filename: 'feedback.zip',
      absolutePath: '/tmp/feedback.zip',
      createdAt: '2026-07-07T00:00:00.000Z',
      sizeBytes: 4096,
    });
    mockedRequest
      .mockResolvedValueOnce({
        reportId: 'issue-uuid',
        uploadUrl: 'https://gcs.example/upload',
        filePath: 'canopy/feedback/ext-1/abc.zip',
      })
      .mockResolvedValueOnce({ ok: true });

    const result = await submitFeedback(baseRequest);

    // No internal issue identifier/URL is surfaced — only a success marker.
    expect(result).toEqual({ submitted: true });

    // Bundle built to a temp file (not Downloads), scoped to the worktree and
    // including chat transcript details so bug reports carry the relevant chat.
    expect(mockedPrepare).toHaveBeenCalledWith(
      expect.objectContaining({
        area: 'worktrees',
        includeChatDetails: true,
        workspaceSelections: [{ workspaceId: 'ws-1', worktreeIds: ['wt-1'] }],
      }),
      { destination: 'temp' },
    );

    // Report create carries the diagnostics size.
    const [reportsPath, reportsInit] = mockedRequest.mock.calls[0];
    expect(reportsPath).toBe('/api/v1/feedback/reports');
    const reportsBody = reportsInit?.body;
    const createdBody: unknown =
      typeof reportsBody === 'string' ? JSON.parse(reportsBody) : undefined;
    expect(createdBody).toMatchObject({
      type: 'bug',
      attachDiagnostics: true,
      diagnosticsSizeBytes: 4096,
    });

    // Zip PUT to the signed URL.
    expect(fetchMock).toHaveBeenCalledWith(
      'https://gcs.example/upload',
      expect.objectContaining({ method: 'PUT' }),
    );
    const putInit = fetchMock.mock.calls[0]?.[1];
    expect(putInit?.headers).toMatchObject({
      'Content-Type': 'application/zip',
    });

    // Attachment commit.
    const [commitPath, commitInit] = mockedRequest.mock.calls[1];
    expect(commitPath).toBe('/api/v1/feedback/reports/attachment-commit');
    const commitBody = commitInit?.body;
    const parsedCommit: unknown =
      typeof commitBody === 'string' ? JSON.parse(commitBody) : undefined;
    expect(parsedCommit).toEqual({
      reportId: 'issue-uuid',
      filePath: 'canopy/feedback/ext-1/abc.zip',
    });

    // Temp file removed.
    expect(mockRm).toHaveBeenCalledWith('/tmp/feedback.zip', { force: true });
  });

  it('scopes a chat-area report to the chat project with chat details included', async () => {
    mockedPrepare.mockResolvedValue({
      filename: 'feedback.zip',
      absolutePath: '/tmp/feedback.zip',
      createdAt: '2026-07-07T00:00:00.000Z',
      sizeBytes: 4096,
    });
    mockedRequest
      .mockResolvedValueOnce({
        reportId: 'issue-uuid',
        uploadUrl: 'https://gcs.example/upload',
        filePath: 'canopy/feedback/ext-1/abc.zip',
      })
      .mockResolvedValueOnce({ ok: true });

    await submitFeedback({
      type: 'bug',
      description: 'Chat lost my message',
      context: { activePage: 'chat', chatProjectId: 'default' },
      includeDiagnostics: true,
    });

    expect(mockedPrepare).toHaveBeenCalledWith(
      expect.objectContaining({
        area: 'chat',
        includeChatDetails: true,
        chatProjectIds: ['default'],
      }),
      { destination: 'temp' },
    );
  });

  it('files a report from the Workflows Library under the pipelines area', async () => {
    mockedPrepare.mockResolvedValue({
      filename: 'feedback.zip',
      absolutePath: '/tmp/feedback.zip',
      createdAt: '2026-07-07T00:00:00.000Z',
      sizeBytes: 4096,
    });
    mockedRequest
      .mockResolvedValueOnce({
        reportId: 'issue-uuid',
        uploadUrl: 'https://gcs.example/upload',
        filePath: 'canopy/feedback/ext-1/abc.zip',
      })
      .mockResolvedValueOnce({ ok: true });

    await submitFeedback({
      type: 'bug',
      description: 'Pipeline row is missing',
      context: { activePage: 'workflows-library' },
      includeDiagnostics: true,
    });

    expect(mockedPrepare).toHaveBeenCalledWith(
      expect.objectContaining({ area: 'pipelines' }),
      { destination: 'temp' },
    );
  });

  it('skips bundle building and upload when diagnostics are disabled', async () => {
    mockedRequest.mockResolvedValueOnce({
      reportId: 'issue-uuid',
    });

    const result = await submitFeedback({
      ...baseRequest,
      includeDiagnostics: false,
    });

    expect(result).toEqual({ submitted: true });
    expect(mockedPrepare).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mockedRequest).toHaveBeenCalledTimes(1);
  });

  it('still cleans up the temp bundle when the report create fails', async () => {
    mockedPrepare.mockResolvedValue({
      filename: 'feedback.zip',
      absolutePath: '/tmp/feedback.zip',
      createdAt: '2026-07-07T00:00:00.000Z',
      sizeBytes: 4096,
    });
    mockedRequest.mockRejectedValueOnce(new Error('boom'));

    await expect(submitFeedback(baseRequest)).rejects.toThrow('boom');
    expect(mockRm).toHaveBeenCalledWith('/tmp/feedback.zip', { force: true });
  });

  it('rejects a blank description before doing any work', async () => {
    await expect(
      submitFeedback({ ...baseRequest, description: '   ' }),
    ).rejects.toThrow('Feedback description is required');
    expect(mockedPrepare).not.toHaveBeenCalled();
    expect(mockedRequest).not.toHaveBeenCalled();
  });
});
