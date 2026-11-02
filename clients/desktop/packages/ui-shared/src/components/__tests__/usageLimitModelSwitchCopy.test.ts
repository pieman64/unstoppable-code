import {
  usageLimitModelSwitchActionLabel,
  usageLimitModelSwitchFailureDetail,
  usageLimitModelSwitchMessage,
  usageLimitModelSwitchPurchaseMessage,
} from '../usageLimitModelSwitchCopy';

describe('usageLimitModelSwitchCopy', () => {
  it('names the credits model in the action', () => {
    expect(usageLimitModelSwitchActionLabel('GPT 6 Luna')).toBe(
      'Continue on GPT 6 Luna',
    );
  });

  describe('usageLimitModelSwitchMessage', () => {
    it('offers the credits model or the reset time', () => {
      expect(
        usageLimitModelSwitchMessage({
          modelLabel: 'GPT 6 Sol',
          targetModelLabel: 'GPT 6 Luna',
          resetsLabel: '8:14 PM',
        }),
      ).toBe(
        "GPT 6 Sol can't run on AI Credits. Continue on GPT 6 Luna with your AI Credits, or wait until 8:14 PM.",
      );
    });

    it('includes the balance when one is given', () => {
      expect(
        usageLimitModelSwitchMessage({
          modelLabel: 'GPT 6 Sol',
          targetModelLabel: 'GPT 6 Luna',
          creditsLeft: '1,234',
          resetsLabel: '8:14 PM',
        }),
      ).toBe(
        "GPT 6 Sol can't run on AI Credits. Continue on GPT 6 Luna with your AI Credits (1,234 left), or wait until 8:14 PM.",
      );
    });

    it('falls back to a generic reset when the time is unknown', () => {
      expect(
        usageLimitModelSwitchMessage({
          modelLabel: 'GPT 6 Sol',
          targetModelLabel: 'GPT 6 Luna',
        }),
      ).toBe(
        "GPT 6 Sol can't run on AI Credits. Continue on GPT 6 Luna with your AI Credits, or wait for your quota to reset.",
      );
    });

    it('leads with the scheduled resume when one is set', () => {
      expect(
        usageLimitModelSwitchMessage({
          modelLabel: 'GPT 6 Sol',
          targetModelLabel: 'GPT 6 Luna',
          resetsLabel: '8:14 PM',
          scheduledForLabel: 'Tue 9:00 AM',
        }),
      ).toBe(
        "This chat resumes automatically at Tue 9:00 AM. GPT 6 Sol can't run on AI Credits. Continue on GPT 6 Luna with your AI Credits to keep going now.",
      );
    });

    it('asks for another model when there is no credits model to offer', () => {
      expect(
        usageLimitModelSwitchMessage({
          modelLabel: 'GPT 6 Sol',
          resetsLabel: '8:14 PM',
        }),
      ).toBe(
        "GPT 6 Sol can't run on AI Credits. Choose a model that can, or wait until 8:14 PM.",
      );
      expect(
        usageLimitModelSwitchMessage({
          modelLabel: 'GPT 6 Sol',
          scheduledForLabel: 'Tue 9:00 AM',
        }),
      ).toBe(
        "This chat resumes automatically at Tue 9:00 AM. GPT 6 Sol can't run on AI Credits. Choose a model that can run on AI Credits to keep going now.",
      );
    });
  });

  describe('usageLimitModelSwitchPurchaseMessage', () => {
    it('points the purchase at the credits model', () => {
      expect(
        usageLimitModelSwitchPurchaseMessage({
          modelLabel: 'GPT 6 Sol',
          targetModelLabel: 'GPT 6 Luna',
          resetsLabel: '8:14 PM',
        }),
      ).toBe(
        "GPT 6 Sol can't run on AI Credits. Get AI Credits to continue on GPT 6 Luna, or wait for your quota to reset around 8:14 PM.",
      );
    });

    it('leads with the scheduled resume when one is set', () => {
      expect(
        usageLimitModelSwitchPurchaseMessage({
          modelLabel: 'GPT 6 Sol',
          targetModelLabel: 'GPT 6 Luna',
          resetsLabel: '8:14 PM',
          scheduledForLabel: 'Tue 9:00 AM',
        }),
      ).toBe(
        "This chat resumes automatically at Tue 9:00 AM. GPT 6 Sol can't run on AI Credits. Get AI Credits to continue on GPT 6 Luna to keep going now.",
      );
    });

    it('asks for another model when there is no credits model to offer', () => {
      expect(
        usageLimitModelSwitchPurchaseMessage({ modelLabel: 'GPT 6 Sol' }),
      ).toBe(
        "GPT 6 Sol can't run on AI Credits. Get AI Credits and choose a model that can, or wait for your quota to reset.",
      );
      expect(
        usageLimitModelSwitchPurchaseMessage({
          modelLabel: 'GPT 6 Sol',
          scheduledForLabel: 'Tue 9:00 AM',
        }),
      ).toBe(
        "This chat resumes automatically at Tue 9:00 AM. GPT 6 Sol can't run on AI Credits. Get AI Credits and choose a model that can run on them to keep going now.",
      );
    });
  });

  describe('usageLimitModelSwitchFailureDetail', () => {
    it('offers a retry or the reset time', () => {
      expect(
        usageLimitModelSwitchFailureDetail({
          targetModelLabel: 'GPT 6 Luna',
          resetsLabel: '8:14 PM',
        }),
      ).toBe("Couldn't switch to GPT 6 Luna. Try again or wait until 8:14 PM.");
    });

    it('offers a retry without a reset time', () => {
      expect(
        usageLimitModelSwitchFailureDetail({ targetModelLabel: 'GPT 6 Luna' }),
      ).toBe("Couldn't switch to GPT 6 Luna. Try again.");
    });
  });
});
