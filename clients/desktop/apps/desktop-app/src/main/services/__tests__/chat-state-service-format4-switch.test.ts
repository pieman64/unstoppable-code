import { ChatStateService } from '../chat-state-service';
import type * as RepositoryModule from '../chat-state-v2-repository';
import { isE2eBuild } from '../../lib/e2e-gate';
import type { ChatStateV2RepositoryOptions } from '../chat-state-v2-repository';

const mockOptions: ChatStateV2RepositoryOptions[] = [];
jest.mock('../../lib/e2e-gate', () => ({ isE2eBuild: jest.fn() }));
jest.mock('../chat-state-v2-repository', () => {
  const actual = jest.requireActual<typeof RepositoryModule>(
    '../chat-state-v2-repository',
  );
  return {
    ...actual,
    ChatStateV2Repository: class extends actual.ChatStateV2Repository {
      constructor(options: ChatStateV2RepositoryOptions) {
        super(options);
        mockOptions.push(options);
      }
    },
  };
});

describe('the production chat repository format-4 construction gate', () => {
  const original = process.env.CANOPY_E2E_CHAT_FORMAT4;
  afterEach(() => {
    if (original === undefined) delete process.env.CANOPY_E2E_CHAT_FORMAT4;
    else process.env.CANOPY_E2E_CHAT_FORMAT4 = original;
    mockOptions.length = 0;
  });

  test.each([
    [true, undefined, false],
    [false, '1', false],
    [true, '0', false],
    [true, '1', true],
  ])('E2E=%s option=%s enables=%s', (e2e, option, enabled) => {
    jest.mocked(isE2eBuild).mockReturnValue(e2e);
    if (option === undefined) delete process.env.CANOPY_E2E_CHAT_FORMAT4;
    else process.env.CANOPY_E2E_CHAT_FORMAT4 = option;
    // Do not inject a repository: exercise the real service construction seam.
    new ChatStateService();
    expect(mockOptions).toHaveLength(1);
    expect(mockOptions[0].enableFormat4 === true).toBe(enabled);
  });
});
