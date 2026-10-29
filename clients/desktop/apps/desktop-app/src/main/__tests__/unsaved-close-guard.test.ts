import {
  UNSAVED_CLOSE_ACK_TIMEOUT_MS,
  createUnsavedCloseGuard,
  shouldInterceptUnsavedClose,
  type UnsavedCloseGuard,
  type UnsavedCloseRequest,
} from '../lifecycle/unsaved-close-guard';

function makeEvent(): { preventDefault: jest.Mock } {
  return { preventDefault: jest.fn() };
}

const OPEN = { quitting: false, hidingToTray: false };

interface GuardHarness {
  guard: UnsavedCloseGuard;
  requests: UnsavedCloseRequest[];
  order: string[];
  revealWindow: jest.Mock;
  sendRequest: jest.Mock;
}

function setup(options: { sendResult?: boolean } = {}): GuardHarness {
  const requests: UnsavedCloseRequest[] = [];
  const order: string[] = [];
  const revealWindow = jest.fn(() => {
    order.push('reveal');
  });
  const sendRequest = jest.fn((request: UnsavedCloseRequest) => {
    order.push('send');
    requests.push(request);
    return options.sendResult ?? true;
  });
  let counter = 0;
  const guard = createUnsavedCloseGuard({
    revealWindow,
    sendRequest,
    createRequestId: () => {
      counter += 1;
      return `req-${counter}`;
    },
  });
  return { guard, requests, order, revealWindow, sendRequest };
}

describe('shouldInterceptUnsavedClose', () => {
  test.each([
    [
      {
        dirty: false,
        alreadyConfirmed: false,
        quitting: false,
        hidingToTray: false,
      },
      false,
    ],
    [
      {
        dirty: true,
        alreadyConfirmed: false,
        quitting: false,
        hidingToTray: false,
      },
      true,
    ],
    [
      {
        dirty: true,
        alreadyConfirmed: true,
        quitting: false,
        hidingToTray: false,
      },
      false,
    ],
    [
      {
        dirty: true,
        alreadyConfirmed: false,
        quitting: true,
        hidingToTray: false,
      },
      false,
    ],
    [
      {
        dirty: true,
        alreadyConfirmed: false,
        quitting: false,
        hidingToTray: true,
      },
      false,
    ],
  ])('%o -> %s', (input, expected) => {
    expect(shouldInterceptUnsavedClose(input)).toBe(expected);
  });
});

describe('createUnsavedCloseGuard', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('is a no-op with nothing reported dirty', () => {
    const { guard, revealWindow, sendRequest } = setup();
    const event = makeEvent();
    const resume = jest.fn();

    expect(guard.intercept(event, 'close', OPEN, resume)).toBe(false);
    expect(guard.intercept(event, 'quit', OPEN, resume)).toBe(false);

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(revealWindow).not.toHaveBeenCalled();
    expect(sendRequest).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);
    expect(resume).not.toHaveBeenCalled();
  });

  test('does not intercept a quit already in progress or a close to tray', () => {
    const { guard, sendRequest } = setup();
    guard.setDirty(true);
    const event = makeEvent();

    expect(
      guard.intercept(
        event,
        'quit',
        { quitting: true, hidingToTray: false },
        jest.fn(),
      ),
    ).toBe(false);
    expect(
      guard.intercept(
        event,
        'close',
        { quitting: false, hidingToTray: true },
        jest.fn(),
      ),
    ).toBe(false);

    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(sendRequest).not.toHaveBeenCalled();
  });

  test('reveals the window before asking the renderer', () => {
    const { guard, order, requests } = setup();
    guard.setDirty(true);
    const event = makeEvent();

    expect(guard.intercept(event, 'quit', OPEN, jest.fn())).toBe(true);

    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['reveal', 'send']);
    expect(requests).toEqual([{ requestId: 'req-1', reason: 'quit' }]);
    expect(guard.isPending()).toBe(true);
  });

  test('resumes once the user proceeds, and the resumed close is not asked again', () => {
    const { guard, sendRequest } = setup();
    guard.setDirty(true);
    const resume = jest.fn(() => {
      const event = makeEvent();
      expect(guard.intercept(event, 'close', OPEN, resume)).toBe(false);
      expect(event.preventDefault).not.toHaveBeenCalled();
    });

    guard.intercept(makeEvent(), 'close', OPEN, resume);
    guard.handleShown('req-1');
    guard.handleDecision('req-1', true);

    expect(resume).toHaveBeenCalledTimes(1);
    expect(sendRequest).toHaveBeenCalledTimes(1);
    expect(guard.isPending()).toBe(false);
    expect(guard.isDirty()).toBe(false);
    expect(jest.getTimerCount()).toBe(0);
  });

  test('keeps the window open when the user keeps editing', () => {
    const { guard } = setup();
    guard.setDirty(true);
    const resume = jest.fn();

    guard.intercept(makeEvent(), 'close', OPEN, resume);
    guard.handleShown('req-1');
    guard.handleDecision('req-1', false);

    expect(resume).not.toHaveBeenCalled();
    expect(guard.isPending()).toBe(false);
    expect(guard.isDirty()).toBe(true);

    // The next close asks again.
    const event = makeEvent();
    expect(guard.intercept(event, 'close', OPEN, resume)).toBe(true);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
  });

  test('proceeds when the renderer does not acknowledge before the timeout', () => {
    const { guard } = setup();
    guard.setDirty(true);
    const resume = jest.fn();

    guard.intercept(makeEvent(), 'quit', OPEN, resume);
    jest.advanceTimersByTime(UNSAVED_CLOSE_ACK_TIMEOUT_MS - 1);
    expect(resume).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1);
    expect(resume).toHaveBeenCalledTimes(1);
    expect(guard.isPending()).toBe(false);
  });

  test('never times out while a shown dialog awaits the user', () => {
    const { guard } = setup();
    guard.setDirty(true);
    const resume = jest.fn();

    guard.intercept(makeEvent(), 'close', OPEN, resume);
    guard.handleShown('req-1');
    jest.advanceTimersByTime(UNSAVED_CLOSE_ACK_TIMEOUT_MS * 100);

    expect(resume).not.toHaveBeenCalled();
    expect(guard.isPending()).toBe(true);
  });

  test('proceeds immediately when there is no renderer to ask', () => {
    const { guard } = setup({ sendResult: false });
    guard.setDirty(true);
    const resume = jest.fn();

    expect(guard.intercept(makeEvent(), 'quit', OPEN, resume)).toBe(true);

    expect(resume).toHaveBeenCalledTimes(1);
    expect(guard.isPending()).toBe(false);
  });

  test('proceeds when the renderer goes away, even after the dialog was shown', () => {
    const { guard } = setup();
    guard.setDirty(true);
    const resume = jest.fn();

    guard.intercept(makeEvent(), 'close', OPEN, resume);
    guard.handleShown('req-1');
    guard.handleRendererGone();

    expect(resume).toHaveBeenCalledTimes(1);
    expect(guard.isDirty()).toBe(false);
    expect(guard.isPending()).toBe(false);
  });

  test('a second close or quit while a prompt is pending does not ask again', () => {
    const { guard, sendRequest } = setup();
    guard.setDirty(true);
    const resumeClose = jest.fn();
    const resumeQuit = jest.fn();

    guard.intercept(makeEvent(), 'close', OPEN, resumeClose);
    const secondClose = makeEvent();
    expect(guard.intercept(secondClose, 'close', OPEN, resumeClose)).toBe(true);
    const quit = makeEvent();
    expect(guard.intercept(quit, 'quit', OPEN, resumeQuit)).toBe(true);

    expect(secondClose.preventDefault).toHaveBeenCalledTimes(1);
    expect(quit.preventDefault).toHaveBeenCalledTimes(1);
    expect(sendRequest).toHaveBeenCalledTimes(1);

    // A quit outranks the pending close.
    guard.handleShown('req-1');
    guard.handleDecision('req-1', true);
    expect(resumeQuit).toHaveBeenCalledTimes(1);
    expect(resumeClose).not.toHaveBeenCalled();
  });

  test('ignores answers for a stale request', () => {
    const { guard } = setup();
    guard.setDirty(true);
    const resume = jest.fn();

    guard.intercept(makeEvent(), 'close', OPEN, resume);
    guard.handleShown('other');
    guard.handleDecision('other', true);

    expect(resume).not.toHaveBeenCalled();
    expect(guard.isPending()).toBe(true);

    // The stale ack did not stop the dead-renderer timeout.
    jest.advanceTimersByTime(UNSAVED_CLOSE_ACK_TIMEOUT_MS);
    expect(resume).toHaveBeenCalledTimes(1);
  });

  test('resets the confirmation when the resumed close is itself cancelled', () => {
    const { guard, sendRequest } = setup();
    guard.setDirty(true);
    // The resumed close never reaches the guard (another handler cancelled
    // it), and the renderer reports dirty again.
    const resume = jest.fn();

    guard.intercept(makeEvent(), 'close', OPEN, resume);
    guard.handleShown('req-1');
    guard.handleDecision('req-1', true);
    expect(resume).toHaveBeenCalledTimes(1);

    guard.setDirty(true);
    jest.advanceTimersByTime(UNSAVED_CLOSE_ACK_TIMEOUT_MS);
    // The unused confirmation expired, so the next close asks again.
    const event = makeEvent();
    expect(guard.intercept(event, 'close', OPEN, jest.fn())).toBe(true);
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(sendRequest).toHaveBeenCalledTimes(2);
  });
});
