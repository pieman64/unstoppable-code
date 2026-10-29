/** @jest-environment jsdom */

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type {
  PortalAskUserQuestionState,
  PortalChatPart,
} from '@canopy/protocol/portal';
import {
  ChatPartView,
  AskUserQuestionInteractionProvider,
  type AskUserQuestionInteraction,
} from '../ChatPartView';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const QUESTIONS = [
  { question: 'Pick a color', options: ['Red', 'Blue'] },
  { question: 'Pick a size', options: ['Small', 'Large'] },
];

const part: PortalChatPart = {
  kind: 'tool_use',
  toolFamily: 'ask-user',
  data: {
    toolName: 'AskUserQuestion',
    input: JSON.stringify({ questions: QUESTIONS }),
  },
};

const state: PortalAskUserQuestionState = {
  requestId: 'r1',
  questions: QUESTIONS,
  answered: false,
};

describe('ChatPartView AskUserQuestion drafts', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(overrides: Partial<AskUserQuestionInteraction>): void {
    const interaction: AskUserQuestionInteraction = {
      states: [state],
      onAnswer: (): void => {},
      onDismiss: (): void => {},
      ...overrides,
    };
    act(() =>
      root.render(
        <AskUserQuestionInteractionProvider value={interaction}>
          <ChatPartView part={part} />
        </AskUserQuestionInteractionProvider>,
      ),
    );
  }

  function currentStepLabel(): string | null | undefined {
    return container
      .querySelector('[aria-current="step"]')
      ?.getAttribute('aria-label');
  }

  it('restores the host draft for the request', () => {
    const getDraft = jest.fn(() => ({
      step: 1,
      selections: { 0: ['Blue'] },
      otherSelected: [],
      otherTexts: {},
    }));
    render({ getDraft });
    expect(getDraft).toHaveBeenCalledWith('r1');
    expect(currentStepLabel()).toBe('Question 2 of 2');
  });

  it('reports draft changes with the request id', () => {
    const onDraftChange = jest.fn();
    render({ onDraftChange });
    const red = Array.from(container.querySelectorAll('label'))
      .find((label) => label.textContent?.startsWith('Red'))
      ?.querySelector('input');
    if (!red) throw new Error('Red option not found');
    act(() => red.click());
    expect(onDraftChange).toHaveBeenCalledWith(
      'r1',
      expect.objectContaining({ step: 0, selections: { 0: ['Red'] } }),
    );
  });

  it('starts on the first question without draft members', () => {
    render({});
    expect(currentStepLabel()).toBe('Question 1 of 2');
  });
});
