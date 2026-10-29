import {
  IPC_CHANNELS,
  type FeedbackPrepareRequest,
  type FeedbackSubmitRequest,
} from '@canopy/desktop-shared/types';
import { prepareFeedbackBundle } from '../feedback/feedback-bundle';
import { submitFeedback } from '../feedback/feedback-submit';
import { registerFeedbackHandlers } from '../ipc/feedback';

const mockHandlers = new Map<string, (...args: unknown[]) => unknown>();
const mockHandle = jest.fn<void, [string, (...args: unknown[]) => unknown]>(
  (channel, handler) => {
    mockHandlers.set(channel, handler);
  },
);
const mockRemoveHandler = jest.fn<void, [string]>((channel) => {
  mockHandlers.delete(channel);
});

jest.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown): void =>
      mockHandle(channel, handler),
    removeHandler: (channel: string): void => {
      mockRemoveHandler(channel);
    },
  },
}));

jest.mock('../feedback/feedback-bundle', () => ({
  prepareFeedbackBundle: jest.fn(),
}));

jest.mock('../feedback/feedback-submit', () => ({
  submitFeedback: jest.fn(),
}));

describe('registerFeedbackHandlers', () => {
  beforeEach(() => {
    mockHandlers.clear();
    jest.clearAllMocks();
  });

  it('registers feedback:prepare', () => {
    registerFeedbackHandlers();

    expect(mockRemoveHandler).toHaveBeenCalledWith(
      IPC_CHANNELS.feedbackPrepare,
    );
    expect(mockHandle).toHaveBeenCalledWith(
      IPC_CHANNELS.feedbackPrepare,
      expect.any(Function),
    );
    expect(mockHandlers.has(IPC_CHANNELS.feedbackPrepare)).toBe(true);
  });

  it('passes requests to prepareFeedbackBundle and returns its response', async () => {
    const response = {
      filename: 'canopy-feedback-20260505T181523Z.zip',
      absolutePath: '/tmp/canopy-feedback-20260505T181523Z.zip',
      createdAt: '2026-05-05T18:15:23.000Z',
      sizeBytes: 123,
    };
    jest.mocked(prepareFeedbackBundle).mockResolvedValue(response);
    registerFeedbackHandlers();
    const handler = getHandler(IPC_CHANNELS.feedbackPrepare);
    const request: FeedbackPrepareRequest = {
      description: 'Problem report',
      area: 'overview',
    };

    await expect(handler({}, request)).resolves.toBe(response);
    expect(prepareFeedbackBundle).toHaveBeenCalledWith(request);
  });

  it('registers feedback:submit', () => {
    registerFeedbackHandlers();

    expect(mockHandle).toHaveBeenCalledWith(
      IPC_CHANNELS.feedbackSubmit,
      expect.any(Function),
    );
    expect(mockHandlers.has(IPC_CHANNELS.feedbackSubmit)).toBe(true);
  });

  it('passes requests to submitFeedback and returns its response', async () => {
    const response = { submitted: true } as const;
    jest.mocked(submitFeedback).mockResolvedValue(response);
    registerFeedbackHandlers();
    const handler = getHandler(IPC_CHANNELS.feedbackSubmit);
    const request: FeedbackSubmitRequest = {
      type: 'bug',
      description: 'Something broke',
      context: { activePage: 'main' },
      includeDiagnostics: true,
    };

    await expect(handler({}, request)).resolves.toBe(response);
    expect(submitFeedback).toHaveBeenCalledWith(request);
  });
});

function getHandler(channel: string): (...args: unknown[]) => Promise<unknown> {
  const handler = mockHandlers.get(channel);
  if (handler === undefined) {
    throw new Error(`No handler registered for ${channel}`);
  }
  return (...args: unknown[]) => Promise.resolve(handler(...args));
}
