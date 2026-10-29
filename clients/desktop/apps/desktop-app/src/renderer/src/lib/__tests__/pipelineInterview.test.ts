/**
 * @jest-environment jsdom
 */
const createStandaloneChatWithMessage = jest.fn();
const navigate = jest.fn();
const addToast = jest.fn();

jest.mock('@/stores/standaloneChatStore', () => ({
  useStandaloneChatStore: {
    getState: (): { createStandaloneChatWithMessage: jest.Mock } => ({
      createStandaloneChatWithMessage,
    }),
  },
}));
jest.mock('@/stores/navigationStore', () => ({
  useNavigationStore: {
    getState: (): { navigate: jest.Mock } => ({ navigate }),
  },
}));
jest.mock('@/stores/githubStore', () => ({
  useGitHubStore: {
    getState: (): { addToast: jest.Mock } => ({ addToast }),
  },
}));

import {
  PIPELINE_INTERVIEW_PROMPT,
  startPipelineInterviewChat,
} from '../pipelineInterview';

describe('startPipelineInterviewChat (CAN-3487)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('opens a new Cowork chat that immediately sends the interview prompt', async () => {
    createStandaloneChatWithMessage.mockResolvedValue('chat-1');

    await expect(startPipelineInterviewChat()).resolves.toBe(true);

    expect(PIPELINE_INTERVIEW_PROMPT).toMatch(
      /^Interview me to help me build a pipeline/,
    );
    expect(createStandaloneChatWithMessage).toHaveBeenCalledWith({
      message: PIPELINE_INTERVIEW_PROMPT,
    });
    expect(navigate).toHaveBeenCalledWith('chat');
    expect(addToast).not.toHaveBeenCalled();
  });

  it('stays on the page and surfaces a toast when the chat cannot start', async () => {
    createStandaloneChatWithMessage.mockRejectedValue(new Error('boom'));

    await expect(startPipelineInterviewChat()).resolves.toBe(false);

    expect(navigate).not.toHaveBeenCalled();
    expect(addToast).toHaveBeenCalledWith(
      "Couldn't start the chat. Try again.",
      'error',
    );
  });
});
