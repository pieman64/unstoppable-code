import {
  canOfferCreditsModelSwitch,
  continueOnCreditsModel,
} from '../creditsModelSwitch';

const target = { projectId: 'p1', worktreeId: 'w1', chatId: 'c1' };

describe('canOfferCreditsModelSwitch', () => {
  const offerable = {
    model: 'gpt-6-sol',
    billingProvider: 'codex',
    hasWorktreeTarget: true,
    creditsModelRoutable: true,
  } as const;

  it('offers the switch on a Codex worktree chat', () => {
    expect(canOfferCreditsModelSwitch(offerable)).toBe(true);
  });

  it('never offers it on an Agent, which the plain model would replace', () => {
    expect(
      canOfferCreditsModelSwitch({
        ...offerable,
        model: 'agent_model_reviewer',
      }),
    ).toBe(false);
  });

  it('needs a worktree chat, a Codex chat and a routable credits model', () => {
    expect(
      canOfferCreditsModelSwitch({ ...offerable, hasWorktreeTarget: false }),
    ).toBe(false);
    expect(
      canOfferCreditsModelSwitch({ ...offerable, billingProvider: 'claude' }),
    ).toBe(false);
    expect(
      canOfferCreditsModelSwitch({ ...offerable, creditsModelRoutable: false }),
    ).toBe(false);
  });
});

describe('continueOnCreditsModel', () => {
  it('switches the model before enabling session routing', async () => {
    const calls: string[] = [];
    const setModelAndWait = jest.fn(() => {
      calls.push('setModel');
      return Promise.resolve(true);
    });
    const enableSessionCreditsRouting = jest.fn(() => {
      calls.push('enableRouting');
      return true;
    });

    await expect(
      continueOnCreditsModel({
        target,
        creditsModel: 'gpt-6-luna',
        setModelAndWait,
        enableSessionCreditsRouting,
      }),
    ).resolves.toBe('switched');

    expect(calls).toEqual(['setModel', 'enableRouting']);
    expect(setModelAndWait).toHaveBeenCalledWith('gpt-6-luna', target);
    expect(enableSessionCreditsRouting).toHaveBeenCalledWith(target);
  });

  it('leaves routing untouched when the store rejects the model', async () => {
    const enableSessionCreditsRouting = jest.fn();

    await expect(
      continueOnCreditsModel({
        target,
        creditsModel: 'gpt-6-luna',
        setModelAndWait: () => Promise.resolve(false),
        enableSessionCreditsRouting,
      }),
    ).resolves.toBe('switch-failed');

    expect(enableSessionCreditsRouting).not.toHaveBeenCalled();
  });

  it('reports a failure when the routing could not be saved', async () => {
    await expect(
      continueOnCreditsModel({
        target,
        creditsModel: 'gpt-6-luna',
        setModelAndWait: () => Promise.resolve(true),
        enableSessionCreditsRouting: () => false,
      }),
    ).resolves.toBe('switch-failed');
  });

  it('reports a thrown switch as a failure without enabling routing', async () => {
    const enableSessionCreditsRouting = jest.fn();

    await expect(
      continueOnCreditsModel({
        target,
        creditsModel: 'gpt-6-luna',
        setModelAndWait: () => Promise.reject(new Error('ipc down')),
        enableSessionCreditsRouting,
      }),
    ).resolves.toBe('switch-failed');

    expect(enableSessionCreditsRouting).not.toHaveBeenCalled();
  });
});
