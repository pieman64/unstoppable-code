import {
  beginResume,
  isResumePending,
  resetResumeLifecycleForTests,
  subscribeResumePending,
  trackResume,
} from '../resume-lifecycle';

afterEach(() => resetResumeLifecycleForTests());

describe('resume lifecycle', () => {
  it('starts before work executes and clears synchronous failure', () => {
    trackResume(() => {
      expect(isResumePending()).toBe(true);
      throw new Error('navigation failed');
    });
    expect(isResumePending()).toBe(false);
  });
  it('stays pending until every overlapping resume ends, each only once', () => {
    const listener = jest.fn();
    subscribeResumePending(listener);
    const endFirst = beginResume();
    const endSecond = beginResume();
    endFirst();
    endFirst();
    expect(isResumePending()).toBe(true);
    endSecond();
    expect(isResumePending()).toBe(false);
    expect(listener).toHaveBeenCalledTimes(4);
  });

  it.each([
    ['resolves', (): Promise<void> => Promise.resolve()],
    ['rejects', (): Promise<void> => Promise.reject(new Error('switch'))],
  ])('ends a tracked resume when its work %s', async (_label, work) => {
    trackResume(work);
    expect(isResumePending()).toBe(true);
    await Promise.resolve();
    await Promise.resolve();
    expect(isResumePending()).toBe(false);
  });
});
