/** @jest-environment jsdom */
import { revealDisclosure } from '../reveal-disclosure';

describe('disclosure reveal', () => {
  const frames: FrameRequestCallback[] = [];
  const animate = jest.fn();
  let trigger: HTMLButtonElement;
  let body: HTMLDivElement;
  let reduced = false;

  beforeEach(() => {
    frames.length = 0;
    animate.mockClear();
    reduced = false;
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: jest.fn(() => ({ matches: reduced })),
    });
    jest
      .spyOn(window, 'requestAnimationFrame')
      .mockImplementation((callback) => {
        frames.push(callback);
        return frames.length;
      });
    trigger = document.createElement('button');
    trigger.setAttribute('aria-expanded', 'true');
    body = document.createElement('div');
    body.setAttribute('data-chat-reveal-body', '');
    Object.defineProperty(body, 'animate', { value: animate });
    Object.defineProperty(body, 'getAnimations', { value: () => [] });
    const root = document.createElement('div');
    root.setAttribute('data-chat-disclosure', '');
    root.append(trigger, body);
    document.body.append(root);
  });

  afterEach(() => {
    document.body.replaceChildren();
    jest.restoreAllMocks();
  });

  it('reveals an opened body with a short transform and opacity animation', () => {
    revealDisclosure(trigger, 'local');
    frames.forEach((callback) => callback(0));
    expect(animate).toHaveBeenCalledWith(
      [
        { opacity: 0, transform: 'translateY(2px)' },
        { opacity: 1, transform: 'translateY(0)' },
      ],
      {
        duration: 180,
        delay: 0,
        fill: 'backwards',
        easing: 'cubic-bezier(0.215, 0.61, 0.355, 1)',
      },
    );
  });

  it('staggers revealed tool rows with a bounded delay, without animating their stack', () => {
    const rows = Array.from({ length: 8 }, () => {
      const row = document.createElement('div');
      row.setAttribute('data-chat-disclosure', '');
      const animation = jest.fn();
      Object.defineProperty(row, 'animate', { value: animation });
      Object.defineProperty(row, 'getAnimations', { value: () => [] });
      body.append(row);
      return animation;
    });
    revealDisclosure(trigger, 'local');
    frames.forEach((callback) => callback(0));
    expect(animate).not.toHaveBeenCalled();
    rows.forEach((animation, index) => {
      expect(animation).toHaveBeenCalledWith(
        [
          { opacity: 0, transform: 'translateY(2px)' },
          { opacity: 1, transform: 'translateY(0)' },
        ],
        {
          duration: 180,
          delay: Math.min(index * 24, 96),
          fill: 'backwards',
          easing: 'cubic-bezier(0.215, 0.61, 0.355, 1)',
        },
      );
    });
  });

  it('does not reveal content closed again before the next frame', () => {
    revealDisclosure(trigger, 'local');
    trigger.setAttribute('aria-expanded', 'false');
    frames.forEach((callback) => callback(0));
    expect(animate).not.toHaveBeenCalled();
  });

  it('reveals new turn content without animating the already visible reply', () => {
    const root = trigger.parentElement;
    if (!root) throw new Error('Missing disclosure root');
    // jsdom cannot resolve :scope on slash-containing Tailwind classes.
    jest.spyOn(trigger, 'closest').mockReturnValue(root);
    body.setAttribute('data-role', 'assistant');
    revealDisclosure(trigger, 'turn');
    const revealed = document.createElement('div');
    revealed.setAttribute('data-role', 'assistant');
    const revealAnimation = jest.fn();
    Object.defineProperty(revealed, 'animate', { value: revealAnimation });
    Object.defineProperty(revealed, 'getAnimations', { value: () => [] });
    root.insertBefore(revealed, body);
    frames.forEach((callback) => callback(0));
    expect(revealAnimation).toHaveBeenCalledTimes(1);
    expect(animate).not.toHaveBeenCalled();
  });

  it('does not animate a trigger removed before the next frame', () => {
    revealDisclosure(trigger, 'local');
    trigger.remove();
    frames.forEach((callback) => callback(0));
    expect(animate).not.toHaveBeenCalled();
  });

  it('skips motion entirely when reduced motion is requested', () => {
    reduced = true;
    revealDisclosure(trigger, 'local');
    expect(frames).toHaveLength(0);
    expect(animate).not.toHaveBeenCalled();
  });
});
