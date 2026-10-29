/**
 * @jest-environment jsdom
 */
import {
  notifySkillsChanged,
  SKILLS_CHANGED_EVENT,
  trackSkillsRefresh,
} from '../skillsChanged';

describe('skills-changed notifications', () => {
  it('resolves only after every tracked listener refresh settles', async () => {
    let finishRefresh: () => void = () => undefined;
    const refresh = new Promise<void>((resolve) => {
      finishRefresh = resolve;
    });
    const failing = Promise.reject(new Error('refresh failed'));
    const listener = (event: Event): void => {
      trackSkillsRefresh(event, refresh);
      trackSkillsRefresh(event, failing);
    };
    window.addEventListener(SKILLS_CHANGED_EVENT, listener);
    try {
      let settled = false;
      const notified = notifySkillsChanged().then(() => {
        settled = true;
      });
      await Promise.resolve();
      expect(settled).toBe(false);

      finishRefresh();
      await notified;
      expect(settled).toBe(true);
    } finally {
      window.removeEventListener(SKILLS_CHANGED_EVENT, listener);
    }
  });

  it('ignores tracking on a plain skills-changed event from older senders', () => {
    const listener = jest.fn((event: Event): void => {
      trackSkillsRefresh(event, Promise.resolve());
    });
    window.addEventListener(SKILLS_CHANGED_EVENT, listener);
    try {
      window.dispatchEvent(new Event(SKILLS_CHANGED_EVENT));
      expect(listener).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener(SKILLS_CHANGED_EVENT, listener);
    }
  });
});
