/**
 * @jest-environment jsdom
 */
/**
 * Interaction coverage for the shared `@canopy/ui-shared` AskUserQuestionCard:
 * radio/checkbox semantics, Other freeform, exact answer payloads, dismiss,
 * in-flight/disabled/disconnected/error states, secret masking, and the touch-target / no-hover-only accessibility requirements.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  AskUserQuestionCard,
  type AskUserQuestionDraft,
} from '../AskUserQuestionCard';
import type {
  PortalAskUserQuestionAnswer,
  PortalAskUserQuestionState,
} from '@canopy/protocol/portal';

Reflect.set(globalThis, 'IS_REACT_ACT_ENVIRONMENT', true);

describe('AskUserQuestionCard', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  function mount(
    state: PortalAskUserQuestionState,
    props: Partial<Parameters<typeof AskUserQuestionCard>[0]> = {},
  ): {
    onSubmit: ((answers: PortalAskUserQuestionAnswer[]) => void) &
      jest.Mock<void, [PortalAskUserQuestionAnswer[]]>;
    onDismiss: (() => void) & jest.Mock<void, []>;
  } {
    const onSubmit = jest.fn<void, [PortalAskUserQuestionAnswer[]]>();
    const onDismiss = jest.fn<void, []>();
    act(() => {
      root.render(
        <AskUserQuestionCard
          state={state}
          onSubmit={onSubmit}
          onDismiss={onDismiss}
          {...props}
        />,
      );
    });
    return { onSubmit, onDismiss };
  }

  function click(el: Element | null | undefined): void {
    act(() => {
      el?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
  }

  function typeInto(
    el: HTMLInputElement | HTMLTextAreaElement,
    value: string,
  ): void {
    const proto =
      el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set?.bind(
      el,
    );
    act(() => {
      setter?.(value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  const singleSelect: PortalAskUserQuestionState = {
    requestId: 'r1',
    questions: [
      {
        question: 'Pick a color',
        options: ['Red', 'Blue'],
        optionDescriptions: ['warm', 'cool'],
      },
    ],
    answered: false,
  };

  it('renders agent buttons, direct form fields and a select, then submits structured answers', () => {
    const { onSubmit } = mount({
      requestId: 'form',
      answered: false,
      questions: [
        { question: 'Continue?', options: ['Yes', 'No'], control: 'buttons' },
        {
          question: 'Project name',
          options: [],
          control: 'text',
          required: true,
        },
        {
          question: 'Environment',
          options: ['Staging', 'Production'],
          control: 'select',
        },
      ],
    });
    const yes = Array.from(container.querySelectorAll('button')).find(
      (b) => b.getAttribute('aria-label') === 'Yes',
    );
    expect(yes).toBeDefined();
    expect(container.querySelectorAll('[role="group"]')).toHaveLength(1);
    click(yes);
    click(submitBtn());
    const name = container.querySelector<HTMLInputElement>(
      'input[aria-label="Project name"]',
    );
    expect(name).not.toBeNull();
    if (!name) throw new Error('Project name field not found');
    typeInto(name, 'My project');
    click(submitBtn());
    // A short select list renders as rows instead of a dropdown.
    expect(container.querySelector('select')).toBeNull();
    click(
      Array.from(container.querySelectorAll('button')).find(
        (b) => b.getAttribute('aria-label') === 'Staging',
      ),
    );
    click(container.querySelector('[data-testid="ask-user-question-submit"]'));
    expect(onSubmit).toHaveBeenCalledWith([
      { question: 'Continue?', selectedOptions: ['Yes'] },
      {
        question: 'Project name',
        selectedOptions: [],
        freeformText: 'My project',
      },
      { question: 'Environment', selectedOptions: ['Staging'] },
    ]);
  });

  it('validates the current step, retains answers on Back, and resets a new request', () => {
    const state: PortalAskUserQuestionState = {
      requestId: 'steps',
      answered: false,
      questions: [
        {
          question: 'Pick one',
          options: ['Yes'],
          control: 'buttons',
          required: true,
        },
        { question: 'Details', options: [], control: 'text' },
      ],
    };
    const { onSubmit } = mount(state);
    // An unanswered required step keeps its action disabled.
    expect(submitBtn().disabled).toBe(true);
    click(submitBtn());
    expect(onSubmit).not.toHaveBeenCalled();
    expect(
      container
        .querySelector('[aria-current="step"]')
        ?.getAttribute('aria-label'),
    ).toBe('Question 1 of 2');
    click(
      Array.from(container.querySelectorAll('button')).find(
        (b) => b.getAttribute('aria-label') === 'Yes',
      ),
    );
    click(submitBtn());
    expect(onSubmit).not.toHaveBeenCalled();
    expect(
      container
        .querySelector('[aria-current="step"]')
        ?.getAttribute('aria-label'),
    ).toBe('Question 2 of 2');
    const detailsInput = container.querySelector('input');
    if (!detailsInput) throw new Error('Details field not found');
    typeInto(detailsInput, 'Saved draft');
    click(
      Array.from(container.querySelectorAll('button')).find(
        (b) => b.textContent === 'Back',
      ),
    );
    expect(
      container
        .querySelector('[aria-pressed="true"]')
        ?.getAttribute('aria-label'),
    ).toBe('Yes');
    click(submitBtn());
    expect(container.querySelector('input')?.value).toBe('Saved draft');
    click(container.querySelector('[data-testid="ask-user-question-close"]'));
    expect(
      container.querySelector('[data-testid="ask-user-question-minimized"]')
        ?.textContent,
    ).toContain('2 questions');
    click(
      container.querySelector('[data-testid="ask-user-question-minimized"]'),
    );
    expect(container.querySelector('input')?.value).toBe('Saved draft');
    expect(
      container
        .querySelector('[aria-current="step"]')
        ?.getAttribute('aria-label'),
    ).toBe('Question 2 of 2');
    click(container.querySelector('[data-testid="ask-user-question-close"]'));
    mount({ ...state, requestId: 'new-steps' });
    expect(
      container
        .querySelector('[aria-current="step"]')
        ?.getAttribute('aria-label'),
    ).toBe('Question 1 of 2');
    expect(container.querySelector('[aria-pressed="true"]')).toBeNull();
  });

  it('uses letters only outside editable fields and ignores composition and repeats', () => {
    mount(singleSelect);
    const form = container.querySelector('form');
    if (!form) throw new Error('Question form not found');
    const key = (target: Element, options: KeyboardEventInit = {}): void =>
      act(() => {
        target.dispatchEvent(
          new KeyboardEvent('keydown', {
            key: 'b',
            bubbles: true,
            cancelable: true,
            ...options,
          }),
        );
      });
    key(form);
    expect(inputs()[1].checked).toBe(true);
    key(form, { key: 'a', isComposing: true });
    key(form, { key: 'a', repeat: true });
    expect(inputs()[1].checked).toBe(true);
    click(inputs()[2]);
    const textarea = container.querySelector('textarea');
    if (!textarea) throw new Error('Other answer field not found');
    key(textarea, { key: 'a' });
    expect(inputs()[2].checked).toBe(true);
    expect(inputs()[0].checked).toBe(false);
  });

  it('keeps a required choice pending until explicitly selected and submitted', () => {
    const { onSubmit } = mount({
      requestId: 'required',
      answered: false,
      questions: [
        {
          question: 'Continue?',
          options: ['Yes', 'No'],
          control: 'buttons',
          required: true,
        },
      ],
    });
    expect(submitBtn().disabled).toBe(true);
    click(container.querySelector('[data-testid="ask-user-question-submit"]'));
    expect(onSubmit).not.toHaveBeenCalled();
    click(
      Array.from(container.querySelectorAll('button')).find(
        (button) => button.getAttribute('aria-label') === 'No',
      ),
    );
    expect(onSubmit).not.toHaveBeenCalled();
    click(container.querySelector('[data-testid="ask-user-question-submit"]'));
    expect(onSubmit).toHaveBeenCalledWith([
      { question: 'Continue?', selectedOptions: ['No'] },
    ]);
  });

  const directFieldControls: readonly (
    | 'text'
    | 'textarea'
    | 'number'
    | 'date'
  )[] = ['text', 'textarea', 'number', 'date'];

  it.each(directFieldControls)(
    'submits a direct %s field without choosing Other',
    (control) => {
      const value =
        control === 'date'
          ? '2026-09-14'
          : control === 'number'
            ? '-3.5'
            : 'Example value';
      const { onSubmit } = mount({
        requestId: `field-${control}`,
        answered: false,
        questions: [
          { question: 'Value', options: [], control, required: true },
        ],
      });
      const input = container.querySelector<
        HTMLInputElement | HTMLTextAreaElement
      >('input, textarea');
      expect(input).not.toBeNull();
      if (!input) throw new Error('Direct answer field not found');
      expect(input.tagName).toBe(control === 'textarea' ? 'TEXTAREA' : 'INPUT');
      typeInto(input, value);
      click(
        container.querySelector('[data-testid="ask-user-question-submit"]'),
      );
      expect(onSubmit).toHaveBeenCalledWith([
        { question: 'Value', selectedOptions: [], freeformText: value },
      ]);
    },
  );

  const multiSelect: PortalAskUserQuestionState = {
    requestId: 'r2',
    questions: [
      { question: 'Pick fruit', options: ['Apple', 'Pear'], multiSelect: true },
    ],
    answered: false,
  };

  function inputs(): HTMLInputElement[] {
    return Array.from(container.querySelectorAll('input'));
  }
  function submitBtn(): HTMLButtonElement {
    const button = container.querySelector(
      '[data-testid="ask-user-question-submit"]',
    );
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error('Submit button not found');
    }
    return button;
  }
  function dismissBtn(): HTMLButtonElement {
    const button = container.querySelector(
      '[data-testid="ask-user-question-dismiss"]',
    );
    if (!(button instanceof HTMLButtonElement)) {
      throw new Error('Dismiss button not found');
    }
    return button;
  }

  it('renders radios, option descriptions, and an Other choice for single-select', () => {
    mount(singleSelect);
    const radios = inputs();
    // Two options + Other, all radios.
    expect(radios.length).toBe(3);
    expect(radios.every((i) => i.type === 'radio')).toBe(true);
    expect(container.textContent).toContain('Red');
    expect(container.textContent).toContain('Blue');
    expect(container.textContent).toContain('warm');
    expect(container.textContent).toContain('cool');
    expect(container.textContent).toContain('Other');
    expect(submitBtn().textContent).toBe('Send');
    expect(dismissBtn().textContent).toBe('Skip');
  });

  it('keeps an empty required reply disabled and closes through the dismiss action', () => {
    const { onSubmit, onDismiss } = mount({
      requestId: 'reply',
      answered: false,
      questions: [
        {
          question: 'What should change?',
          control: 'text',
          options: [],
          required: true,
        },
      ],
    });
    expect(submitBtn().disabled).toBe(true);
    const input = container.querySelector<HTMLInputElement>('input');
    if (!input) throw new Error('Reply field not found');
    expect(input.placeholder).toBe('Reply…');
    typeInto(input, 'Make the controls clearer.');
    expect(submitBtn().disabled).toBe(false);
    click(submitBtn());
    expect(onSubmit).toHaveBeenCalledWith([
      {
        question: 'What should change?',
        selectedOptions: [],
        freeformText: 'Make the controls clearer.',
      },
    ]);
    click(container.querySelector('[data-testid="ask-user-question-close"]'));
    expect(onDismiss).not.toHaveBeenCalled();
    expect(container.querySelector('form')).toBeNull();
    click(
      container.querySelector('[data-testid="ask-user-question-minimized"]'),
    );
    expect(container.querySelector('input')?.value).toBe(
      'Make the controls clearer.',
    );
    click(dismissBtn());
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('renders checkboxes for multi-select', () => {
    mount(multiSelect);
    const boxes = inputs();
    expect(boxes.every((i) => i.type === 'checkbox')).toBe(true);
  });

  it('submits the exact structured answer for a single selection', () => {
    const { onSubmit } = mount(singleSelect);
    // index 1 is Blue (0 Red, 1 Blue, 2 Other)
    click(inputs()[1]);
    click(submitBtn());
    expect(onSubmit).toHaveBeenCalledTimes(1);
    expect(onSubmit.mock.calls[0][0]).toEqual([
      { question: 'Pick a color', selectedOptions: ['Blue'] },
    ]);
  });

  it('submits selected options plus trimmed Other freeform for multi-select', () => {
    const { onSubmit } = mount(multiSelect);
    click(inputs()[0]); // Apple
    click(inputs()[2]); // Other
    const textarea = container.querySelector('textarea');
    expect(textarea).not.toBeNull();
    if (!textarea) throw new Error('Other freeform field not found');
    typeInto(textarea, '  kiwi  ');
    click(submitBtn());
    expect(onSubmit.mock.calls[0][0]).toEqual([
      {
        question: 'Pick fruit',
        selectedOptions: ['Apple'],
        freeformText: 'kiwi',
      },
    ]);
  });

  it('permits submitting with no selection', () => {
    const { onSubmit } = mount(singleSelect);
    click(submitBtn());
    expect(onSubmit.mock.calls[0][0]).toEqual([
      { question: 'Pick a color', selectedOptions: [] },
    ]);
  });

  it('includes questionId only when present', () => {
    const { onSubmit } = mount({
      requestId: 'r3',
      questions: [{ id: 'q-1', question: 'Named', options: ['Yes'] }],
      answered: false,
    });
    click(inputs()[0]);
    click(submitBtn());
    expect(onSubmit.mock.calls[0][0]).toEqual([
      { questionId: 'q-1', question: 'Named', selectedOptions: ['Yes'] },
    ]);
  });

  it('invokes onDismiss when Dismiss is clicked', () => {
    const { onDismiss } = mount(singleSelect);
    click(dismissBtn());
    expect(onDismiss).toHaveBeenCalledTimes(1);
  });

  it('shows in-flight labels and disables controls while submitting', () => {
    mount(singleSelect, { busy: 'answer' });
    expect(submitBtn().textContent).toBe('Sending…');
    expect(submitBtn().disabled).toBe(true);
    expect(submitBtn().getAttribute('aria-busy')).toBe('true');
    expect(inputs().every((i) => i.disabled)).toBe(true);
  });

  it('shows the dismissing label while dismissing', () => {
    mount(singleSelect, { busy: 'dismiss' });
    expect(dismissBtn().textContent).toBe('Skipping…');
    expect(dismissBtn().disabled).toBe(true);
  });

  it('renders the reconnect helper and read-only controls when disconnected', () => {
    mount(singleSelect, { disconnected: true });
    expect(container.textContent).toContain(
      'Reconnect to answer this question.',
    );
    expect(submitBtn().disabled).toBe(true);
    expect(inputs().every((i) => i.disabled)).toBe(true);
  });

  it('renders the submit-error copy', () => {
    mount(singleSelect, { errorKind: 'submit' });
    expect(container.textContent).toContain(
      "Couldn't send your answer. Try again.",
    );
  });

  it('renders the dismiss-error copy', () => {
    mount(singleSelect, { errorKind: 'dismiss' });
    expect(container.textContent).toContain(
      "Couldn't skip this question. Try again.",
    );
  });

  it('uses a password input for a secret Other freeform', () => {
    mount({
      requestId: 'r4',
      questions: [
        { question: 'Enter secret', options: ['Skip'], secret: true },
      ],
      answered: false,
    });
    click(inputs()[1]); // Other
    const secret = container.querySelector('input[type="password"]');
    expect(secret).not.toBeNull();
    expect(container.querySelector('textarea')).toBeNull();
  });

  it('groups full questions and answers under one Answers heading', () => {
    const question =
      'Which stack should we use for this application, including the frontend, backend, and deployment platform that your team will maintain?';
    mount({
      requestId: 'answered-group',
      answered: true,
      questions: [],
      answers: [
        {
          question,
          selectedOptions: ['Next.js'],
          freeformText: 'Deploy on our existing infrastructure.',
        },
        {
          question: 'What is the core feature?',
          selectedOptions: ['Dashboard with charts'],
        },
      ],
    });
    expect(container.textContent).toContain('Answers');
    expect(container.textContent).toContain(question);
    expect(
      container.querySelectorAll('[data-testid="answered-questions"]'),
    ).toHaveLength(1);
    expect(
      container.querySelectorAll('[data-testid="answered-question"]'),
    ).toHaveLength(2);
    expect(container.textContent).toContain(
      'Next.js, Deploy on our existing infrastructure.',
    );
    expect(container.textContent).toContain('Dashboard with charts');
    expect(container.querySelector('button, input, textarea')).toBeNull();
  });

  it('masks secret freeform as [hidden] in the answered display', () => {
    mount({
      requestId: 'r5',
      questions: [
        { question: 'Enter secret', options: ['Skip'], secret: true },
      ],
      answered: true,
      answers: [
        { question: 'Enter secret', selectedOptions: [], freeformText: 'p@ss' },
      ],
    });
    expect(container.textContent).toContain('[hidden]');
    expect(container.textContent).not.toContain('p@ss');
  });

  it('gives every option label and action button a coarse-pointer touch target and no hover-only gating', () => {
    mount(singleSelect);
    const labels = Array.from(container.querySelectorAll('label'));
    expect(labels.length).toBeGreaterThan(0);
    for (const el of labels) {
      expect(el.className).toContain('pointer-coarse:min-h-11');
    }
    // Shared header action keeps a 28px visual height and expands its coarse hit area to 44px.
    for (const button of [submitBtn(), dismissBtn()]) {
      expect(button.className).toContain('pointer-coarse:before:-inset-y-2');
      expect(button.className).toContain('focus-ring');
    }
    // Skip/Send are always visible — never hidden behind hover/opacity. Only
    // the decorative letter hints wait for hover or focus.
    for (const button of [submitBtn(), dismissBtn()]) {
      let node: HTMLElement | null = button;
      while (node && node !== container) {
        expect(node.className).not.toContain('opacity-0');
        node = node.parentElement;
      }
    }
    const hints = Array.from(container.querySelectorAll('kbd'));
    expect(hints.length).toBeGreaterThan(0);
    for (const hint of hints) {
      expect(hint.closest('[aria-hidden="true"]')).toBeInstanceOf(Element);
    }
  });

  it('renders a long multi-select as option rows, never a native list box', () => {
    const { onSubmit } = mount({
      requestId: 'long-multi',
      answered: false,
      questions: [
        {
          question: 'Regions',
          control: 'select',
          multiSelect: true,
          options: [
            'us-east',
            'us-west',
            'eu-west',
            'eu-central',
            'ap-south',
            'ap-east',
          ],
          required: true,
        },
      ],
    });
    expect(container.querySelector('select')).toBeNull();
    for (const name of ['eu-west', 'ap-south']) {
      click(
        Array.from(container.querySelectorAll('button')).find(
          (b) => b.getAttribute('aria-label') === name,
        ),
      );
    }
    click(submitBtn());
    expect(onSubmit).toHaveBeenCalledWith([
      { question: 'Regions', selectedOptions: ['eu-west', 'ap-south'] },
    ]);
  });

  it('uses the Canopy select, not a native one, for longer option lists', () => {
    mount({
      requestId: 'long-select',
      answered: false,
      questions: [
        {
          question: 'Region',
          control: 'select',
          options: [
            'us-east',
            'us-west',
            'eu-west',
            'eu-central',
            'ap-south',
            'ap-east',
          ],
          required: true,
        },
      ],
    });
    expect(container.querySelector('select')).toBeNull();
    const trigger = container.querySelector('[role="combobox"]');
    expect(trigger?.getAttribute('aria-label')).toBe('Region');
    expect(trigger?.textContent).toBe('Choose an option');
  });

  it('marks optional controls instead of required ones', () => {
    mount({
      requestId: 'optional',
      answered: false,
      questions: [
        { question: 'Name', options: [], control: 'text', required: true },
        { question: 'Notes', options: [], control: 'text' },
      ],
    });
    expect(container.textContent).not.toContain('Required');
    expect(container.textContent).not.toContain('Optional');
    const nameInput = container.querySelector('input');
    if (!nameInput) throw new Error('Name field not found');
    typeInto(nameInput, 'Atlas');
    click(submitBtn());
    expect(container.textContent).toContain('Optional');
  });

  describe('draft', () => {
    const twoSteps: PortalAskUserQuestionState = {
      requestId: 'steps',
      answered: false,
      questions: [
        {
          question: 'Pick one',
          options: ['Yes'],
          control: 'buttons',
          required: true,
        },
        { question: 'Details', options: [], control: 'text' },
      ],
    };

    function optionButton(label: string): HTMLButtonElement | undefined {
      return Array.from(container.querySelectorAll('button')).find(
        (b) => b.getAttribute('aria-label') === label,
      );
    }

    function currentStepLabel(): string | null | undefined {
      return container
        .querySelector('[aria-current="step"]')
        ?.getAttribute('aria-label');
    }

    function lastDraft(
      onDraftChange: jest.Mock<void, [AskUserQuestionDraft]>,
    ): AskUserQuestionDraft {
      const draft = onDraftChange.mock.calls.at(-1)?.[0];
      if (!draft) throw new Error('No draft reported');
      return draft;
    }

    it('restores a draft and reports changes', () => {
      const onDraftChange = jest.fn<void, [AskUserQuestionDraft]>();
      mount(twoSteps, { onDraftChange });
      click(optionButton('Yes'));
      click(submitBtn());
      const details = container.querySelector('input');
      if (!details) throw new Error('Details field not found');
      typeInto(details, 'Saved draft');
      const draft = lastDraft(onDraftChange);

      act(() => {
        root.unmount();
      });
      root = createRoot(container);
      mount(twoSteps, { draft });

      expect(currentStepLabel()).toBe('Question 2 of 2');
      expect(container.querySelector('input')?.value).toBe('Saved draft');
      click(
        Array.from(container.querySelectorAll('button')).find(
          (b) => b.textContent === 'Back',
        ),
      );
      expect(optionButton('Yes')?.getAttribute('aria-pressed')).toBe('true');
    });

    it('a draft wins over defaultFirstOption seeding', () => {
      mount(twoSteps, {
        defaultFirstOption: true,
        draft: { step: 0, selections: {}, otherSelected: [], otherTexts: {} },
      });
      expect(container.querySelector('[aria-pressed="true"]')).toBeNull();
    });

    it('a draft for a new request replaces the reset', () => {
      mount(twoSteps);
      expect(currentStepLabel()).toBe('Question 1 of 2');
      mount(
        { ...twoSteps, requestId: 'other' },
        {
          draft: {
            step: 1,
            selections: { 0: ['Yes'] },
            otherSelected: [],
            otherTexts: { 1: 'From draft' },
          },
        },
      );
      expect(currentStepLabel()).toBe('Question 2 of 2');
      expect(container.querySelector('input')?.value).toBe('From draft');
    });

    it('an in-place request change does not report the old form under the new id', () => {
      const onDraftChange = jest.fn<void, [AskUserQuestionDraft]>();
      mount({ ...twoSteps, requestId: 'r1' }, { onDraftChange });
      click(optionButton('Yes'));
      expect(onDraftChange).toHaveBeenCalledTimes(1);
      mount({ ...twoSteps, requestId: 'r2' }, { onDraftChange });
      expect(onDraftChange).toHaveBeenCalledTimes(1);
      expect(container.querySelector('[aria-pressed="true"]')).toBeNull();
      click(container.querySelector('[data-testid="ask-user-question-close"]'));
      expect(onDraftChange).toHaveBeenCalledTimes(2);
      expect(lastDraft(onDraftChange)).toEqual({
        step: 0,
        selections: {},
        otherSelected: [],
        otherTexts: {},
        minimized: true,
      });
    });

    it('clamps an out-of-range draft step', () => {
      mount(twoSteps, {
        draft: { step: 5, selections: {}, otherSelected: [], otherTexts: {} },
      });
      expect(currentStepLabel()).toBe('Question 2 of 2');
    });

    it('restores minimized', () => {
      mount(twoSteps, {
        draft: {
          step: 0,
          selections: {},
          otherSelected: [],
          otherTexts: {},
          minimized: true,
        },
      });
      const pill = container.querySelector(
        '[data-testid="ask-user-question-minimized"]',
      );
      expect(pill).not.toBeNull();
      // Restoring is not a user toggle, so focus stays where it was.
      expect(container.contains(document.activeElement)).toBe(false);
    });

    it('does not report after submit', () => {
      const onDraftChange = jest.fn<void, [AskUserQuestionDraft]>();
      const { onSubmit } = mount(twoSteps, { onDraftChange });
      click(optionButton('Yes'));
      click(submitBtn());
      const details = container.querySelector('input');
      if (!details) throw new Error('Details field not found');
      typeInto(details, 'Done');
      const reportsBeforeSubmit = onDraftChange.mock.calls.length;
      expect(reportsBeforeSubmit).toBeGreaterThan(0);
      click(submitBtn());
      expect(onSubmit).toHaveBeenCalledTimes(1);
      expect(onDraftChange).toHaveBeenCalledTimes(reportsBeforeSubmit);
      expect(Math.max(...onDraftChange.mock.invocationCallOrder)).toBeLessThan(
        onSubmit.mock.invocationCallOrder[0],
      );
    });
  });
});
