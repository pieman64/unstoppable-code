/** @jest-environment jsdom */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  PortalAskUserQuestion,
  PortalAskUserQuestionAnswer,
} from '@canopy/protocol/portal';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { QuestionPrompt, QuestionSkipButton } from '../QuestionPrompt';
import {
  questionAcceptsText,
  questionStepKind,
  useQuestionPrompt,
  type QuestionPromptState,
} from '../useQuestionPrompt';
import {
  readQuestionPromptProgress,
  resetQuestionPromptProgressForTests,
  saveQuestionPromptProgress,
} from '../question-prompt-progress';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

describe('questionStepKind', () => {
  it('maps each control to how the composer asks it', () => {
    const choice = {
      question: 'Q',
      options: ['A', 'B'],
      control: 'buttons' as const,
    };
    expect(questionStepKind(choice)).toBe('choice');
    expect(questionStepKind({ ...choice, multiSelect: true })).toBe('multi');
    expect(
      questionStepKind({
        question: 'Q',
        options: ['A', 'B'],
        control: 'select',
      }),
    ).toBe('choice');
    expect(
      questionStepKind({
        question: 'Q',
        options: ['1', '2', '3', '4', '5', '6'],
        control: 'select',
      }),
    ).toBe('choice');
    expect(
      questionStepKind({
        question: 'Q',
        options: ['1', '2', '3', '4', '5', '6'],
        control: 'select',
        multiSelect: true,
      }),
    ).toBe('multi');
    expect(
      questionStepKind({ question: 'Q', options: [], control: 'text' }),
    ).toBe('text');
    expect(
      questionStepKind({ question: 'Q', options: [], control: 'textarea' }),
    ).toBe('text');
    expect(
      questionStepKind({
        question: 'Q',
        options: [],
        control: 'text',
        secret: true,
      }),
    ).toBe('field');
    expect(
      questionStepKind({ question: 'Q', options: [], control: 'number' }),
    ).toBe('field');
    expect(
      questionStepKind({ question: 'Q', options: [], control: 'date' }),
    ).toBe('field');
    // A private value never reaches the composer: with no options it asks in
    // the masked field (the Codex shape has no control), and its choices take
    // no typed answer.
    expect(questionStepKind({ question: 'Q', options: [], secret: true })).toBe(
      'field',
    );
    expect(
      questionAcceptsText({ question: 'Q', options: [], secret: true }),
    ).toBe(false);
    expect(
      questionStepKind({ question: 'Q', options: ['A', 'B'], secret: true }),
    ).toBe('choice');
    expect(
      questionAcceptsText({ question: 'Q', options: ['A', 'B'], secret: true }),
    ).toBe(false);
    // A classic question: rows, or only its Other text when it has no options.
    expect(questionStepKind({ question: 'Q', options: ['A'] })).toBe('choice');
    expect(questionStepKind({ question: 'Q', options: [] })).toBe('text');
  });

  it('lets the composer answer every question but fields and closed providers', () => {
    expect(
      questionAcceptsText({ question: 'Q', options: [], control: 'text' }),
    ).toBe(true);
    expect(questionAcceptsText({ question: 'Q', options: ['A'] })).toBe(true);
    expect(
      questionAcceptsText({ question: 'Q', options: ['A'], allowOther: false }),
    ).toBe(false);
    expect(
      questionAcceptsText({
        question: 'Q',
        options: ['A'],
        control: 'buttons',
      }),
    ).toBe(true);
    expect(
      questionAcceptsText({ question: 'Q', options: [], control: 'number' }),
    ).toBe(false);
  });
});

describe('QuestionPrompt', () => {
  let container: HTMLDivElement;
  let root: Root;
  let latest: QuestionPromptState | null;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    latest = null;
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    resetQuestionPromptProgressForTests();
  });

  function Harness({
    requestId = 'r1',
    questions,
    onSubmit,
    onSkip = jest.fn(),
    onClose = jest.fn(),
  }: {
    requestId?: string;
    questions: PortalAskUserQuestion[];
    onSubmit: (answers: PortalAskUserQuestionAnswer[]) => void;
    onSkip?: () => void;
    onClose?: () => void;
  }): JSX.Element {
    const prompt = useQuestionPrompt({ requestId, questions, onSubmit });
    latest = prompt;
    return (
      <QuestionPrompt
        prompt={prompt}
        busy={null}
        errorKind={null}
        onRetry={jest.fn()}
        onClose={onClose}
      >
        <div data-testid="text-row" />
        {prompt.skips('') && <QuestionSkipButton busy={null} onSkip={onSkip} />}
      </QuestionPrompt>
    );
  }

  function row(index: number): HTMLButtonElement {
    const element = container.querySelector(
      `[data-testid="chat-question-option-${index}"]`,
    );
    if (!(element instanceof HTMLButtonElement)) throw new Error('no row');
    return element;
  }

  function prompt(): QuestionPromptState {
    if (!latest) throw new Error('no prompt');
    return latest;
  }

  it('renders a control-free secret in a masked field', () => {
    act(() =>
      root.render(
        <Harness
          questions={[{ question: 'API token?', options: [], secret: true }]}
          onSubmit={jest.fn()}
        />,
      ),
    );
    const field = container.querySelector(
      '[data-testid="chat-question-field"]',
    );
    expect(field).toBeInstanceOf(HTMLInputElement);
    expect(field?.getAttribute('type')).toBe('password');
    const questionPrompt = container.querySelector(
      '[data-testid="chat-question-prompt"]',
    );
    expect(questionPrompt?.classList.contains(POSTHOG_REPLAY_BLOCK_CLASS)).toBe(
      true,
    );
    expect(field?.closest(`.${POSTHOG_REPLAY_BLOCK_CLASS}`)).toBe(
      questionPrompt,
    );
    expect(prompt().acceptsText).toBe(false);
  });

  it('answers a single choice as soon as it is clicked', () => {
    const onSubmit = jest.fn();
    act(() =>
      root.render(
        <Harness
          questions={[
            {
              question: 'Next?',
              options: ['Review', 'Test'],
              control: 'buttons',
              required: true,
            },
          ]}
          onSubmit={onSubmit}
        />,
      ),
    );
    expect(container.textContent).toContain('Next?');
    expect(row(0).textContent).toContain('1');
    expect(container.querySelector('[data-testid="text-row"]')).not.toBeNull();
    act(() => row(1).click());
    expect(onSubmit).toHaveBeenCalledWith([
      { question: 'Next?', selectedOptions: ['Test'] },
    ]);
  });

  it('picks an answer by its number while a row is focused', () => {
    const onSubmit = jest.fn();
    act(() =>
      root.render(
        <Harness
          questions={[
            { question: 'Next?', options: ['A', 'B'], control: 'buttons' },
          ]}
          onSubmit={onSubmit}
        />,
      ),
    );
    act(() => {
      row(0).dispatchEvent(
        new KeyboardEvent('keydown', { key: '2', bubbles: true }),
      );
    });
    expect(onSubmit).toHaveBeenCalledWith([
      { question: 'Next?', selectedOptions: ['B'] },
    ]);
  });

  it('toggles multiple choices and sends them with the composer send', () => {
    const onSubmit = jest.fn();
    act(() =>
      root.render(
        <Harness
          questions={[
            {
              question: 'Ship?',
              options: ['Search', 'Analytics', 'Teams'],
              control: 'buttons',
              multiSelect: true,
              required: true,
            },
          ]}
          onSubmit={onSubmit}
        />,
      ),
    );
    expect(prompt().sendAnswers('')).toBe(true);
    expect(prompt().canSend('')).toBe(false);
    expect(prompt().skips('')).toBe(true);
    act(() => row(0).click());
    act(() => row(2).click());
    expect(prompt().skips('')).toBe(false);
    expect(prompt().skips('hello')).toBe(false);
    expect(row(0).getAttribute('aria-pressed')).toBe('true');
    expect(row(1).getAttribute('aria-pressed')).toBe('false');
    expect(onSubmit).not.toHaveBeenCalled();
    // Typed text joins the picks as the person's own answer.
    expect(prompt().sendAnswers('hello')).toBe(true);
    expect(prompt().canSend('')).toBe(true);
    act(() => prompt().send(''));
    expect(onSubmit).toHaveBeenCalledWith([
      { question: 'Ship?', selectedOptions: ['Search', 'Teams'] },
    ]);
  });

  it('takes a typed answer on a list of choices', () => {
    const onSubmit = jest.fn();
    act(() =>
      root.render(
        <Harness
          questions={[
            {
              question: 'Next?',
              options: ['Review', 'Test'],
              control: 'buttons',
              required: true,
            },
          ]}
          onSubmit={onSubmit}
        />,
      ),
    );
    expect(prompt().sendAnswers('Ship it')).toBe(true);
    expect(prompt().canSend('Ship it')).toBe(true);
    act(() => prompt().send('Ship it'));
    expect(onSubmit).toHaveBeenCalledWith([
      { question: 'Next?', selectedOptions: [], freeformText: 'Ship it' },
    ]);
  });

  it('takes a classic Other answer from the composer text', () => {
    const onSubmit = jest.fn();
    act(() =>
      root.render(
        <Harness
          questions={[{ question: 'Manager?', options: ['npm', 'pnpm'] }]}
          onSubmit={onSubmit}
        />,
      ),
    );
    expect(prompt().sendAnswers('')).toBe(false);
    expect(prompt().sendAnswers('bun')).toBe(true);
    act(() => prompt().send('bun'));
    expect(onSubmit).toHaveBeenCalledWith([
      { question: 'Manager?', selectedOptions: [], freeformText: 'bun' },
    ]);
  });

  it('leads the text row with a pen unless the provider takes no typed answer', () => {
    const glyph = (): Element | null =>
      container.querySelector('[data-testid="composer-prompt-pen"]');
    act(() =>
      root.render(
        <Harness
          questions={[{ question: 'Manager?', options: ['npm', 'pnpm'] }]}
          onSubmit={jest.fn()}
        />,
      ),
    );
    expect(glyph()).not.toBeNull();
    act(() =>
      root.render(
        <Harness
          questions={[
            {
              question: 'Next?',
              options: ['A', 'B'],
              control: 'buttons',
              allowOther: false,
            },
          ]}
          onSubmit={jest.fn()}
        />,
      ),
    );
    expect(glyph()).toBeNull();
  });

  it("puts the cursor in a step's own field", () => {
    act(() =>
      root.render(
        <Harness
          questions={[{ question: 'Rollout?', options: [], control: 'number' }]}
          onSubmit={jest.fn()}
        />,
      ),
    );
    expect(document.activeElement).toBe(
      container.querySelector('[data-testid="chat-question-field"]'),
    );
  });

  it('steps through several questions, keeps answers on Back, and submits on the last', () => {
    const onSubmit = jest.fn();
    act(() =>
      root.render(
        <Harness
          questions={[
            { question: 'Name?', options: [], control: 'text', required: true },
            {
              question: 'Env?',
              options: ['Staging', 'Production'],
              control: 'select',
              required: true,
            },
          ]}
          onSubmit={onSubmit}
        />,
      ),
    );
    expect(
      container
        .querySelector('[aria-current="step"]')
        ?.getAttribute('aria-label'),
    ).toBe('Question 1 of 2');
    expect(
      container.querySelector('[data-testid="chat-question-back"]'),
    ).toBeNull();
    expect(prompt().canSend('')).toBe(false);
    act(() => prompt().send('Atlas'));
    expect(container.textContent).toContain('Env?');
    expect(
      container.querySelector('[data-testid="chat-question-back"]'),
    ).not.toBeNull();
    act(() => row(1).click());
    expect(onSubmit).toHaveBeenCalledWith([
      { question: 'Name?', selectedOptions: [], freeformText: 'Atlas' },
      { question: 'Env?', selectedOptions: ['Production'] },
    ]);
  });

  describe('progress across remounts', () => {
    const steps: PortalAskUserQuestion[] = [
      {
        question: 'Continue?',
        options: ['Yes', 'No'],
        control: 'buttons',
        required: true,
      },
      { question: 'Project name', options: [], control: 'text' },
      {
        question: 'Environment',
        options: ['Staging', 'Production'],
        control: 'select',
      },
    ];

    function remount(element: JSX.Element): void {
      act(() => root.unmount());
      root = createRoot(container);
      act(() => root.render(element));
    }

    it('keeps progress across a remount of the same request', () => {
      act(() =>
        root.render(<Harness questions={steps} onSubmit={jest.fn()} />),
      );
      act(() => row(0).click());
      expect(prompt().step).toBe(1);
      remount(<Harness questions={steps} onSubmit={jest.fn()} />);
      expect(prompt().step).toBe(1);
      expect(prompt().question.question).toBe('Project name');
      act(() => prompt().back());
      expect(prompt().selected).toEqual(['Yes']);
    });

    it('starts fresh after submit', () => {
      const onSubmit = jest.fn();
      act(() => root.render(<Harness questions={steps} onSubmit={onSubmit} />));
      act(() => row(0).click());
      act(() => prompt().send('Atlas'));
      act(() => row(1).click());
      expect(onSubmit).toHaveBeenCalledTimes(1);
      remount(<Harness questions={steps} onSubmit={onSubmit} />);
      expect(prompt().step).toBe(0);
      expect(prompt().selected).toEqual([]);
      act(() => root.render(<Harness questions={steps} onSubmit={onSubmit} />));
      expect(readQuestionPromptProgress('r1')).toBeUndefined();
    });

    it('starts fresh for another request', () => {
      act(() =>
        root.render(<Harness questions={steps} onSubmit={jest.fn()} />),
      );
      act(() => row(0).click());
      remount(
        <Harness requestId="r2" questions={steps} onSubmit={jest.fn()} />,
      );
      expect(prompt().step).toBe(0);
    });

    it("an in-place request change keeps each request's own progress", () => {
      act(() =>
        root.render(<Harness questions={steps} onSubmit={jest.fn()} />),
      );
      act(() => row(0).click());
      act(() =>
        root.render(
          <Harness requestId="r2" questions={steps} onSubmit={jest.fn()} />,
        ),
      );
      expect(prompt().step).toBe(0);
      expect(readQuestionPromptProgress('r2')).toBeUndefined();
      act(() =>
        root.render(<Harness questions={steps} onSubmit={jest.fn()} />),
      );
      expect(prompt().step).toBe(1);
      act(() => prompt().back());
      expect(prompt().selected).toEqual(['Yes']);
    });

    it('clamps a restored out-of-range step', () => {
      saveQuestionPromptProgress('r1', {
        step: 9,
        selections: new Map(),
        texts: new Map(),
      });
      act(() =>
        root.render(<Harness questions={steps} onSubmit={jest.fn()} />),
      );
      expect(prompt().step).toBe(2);
    });
  });

  it('collects a number in its field and checks it before sending', () => {
    const onSubmit = jest.fn();
    act(() =>
      root.render(
        <Harness
          questions={[
            {
              question: 'Rollout?',
              options: [],
              control: 'number',
              required: true,
            },
          ]}
          onSubmit={onSubmit}
        />,
      ),
    );
    const field = container.querySelector(
      '[data-testid="chat-question-field"]',
    );
    expect(field?.getAttribute('type')).toBe('number');
    act(() => prompt().setFieldValue('25'));
    expect(prompt().canSend('')).toBe(true);
    act(() => prompt().send(''));
    expect(onSubmit).toHaveBeenCalledWith([
      { question: 'Rollout?', selectedOptions: [], freeformText: '25' },
    ]);
  });

  it('offers Skip until something is answered, and closes on x or Escape', () => {
    const onSubmit = jest.fn();
    const onSkip = jest.fn();
    const onClose = jest.fn();
    act(() =>
      root.render(
        <Harness
          questions={[
            { question: 'Next?', options: ['A'], control: 'buttons' },
          ]}
          onSubmit={onSubmit}
          onSkip={onSkip}
          onClose={onClose}
        />,
      ),
    );
    const click = (testId: string): void => {
      const element = container.querySelector(`[data-testid="${testId}"]`);
      if (!(element instanceof HTMLButtonElement)) throw new Error(testId);
      act(() => element.click());
    };
    click('chat-question-skip');
    expect(onSkip).toHaveBeenCalledTimes(1);
    click('chat-question-close');
    expect(onClose).toHaveBeenCalledTimes(1);
    act(() => {
      row(0).dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      );
    });
    expect(onClose).toHaveBeenCalledTimes(2);
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
