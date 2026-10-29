import {
  initialPlaygroundMachine,
  reduceQuestionPlayground,
} from '../chatQuestionPlaygroundData';

it('retains an answer through failure and retry, and rejects late transitions', () => {
  const answers = [
    { question: 'Name', selectedOptions: [], freeformText: 'Atlas' },
  ];
  let state = reduceQuestionPlayground(initialPlaygroundMachine, {
    type: 'submit',
    answers,
  });
  expect(state.phase).toBe('submitting');
  expect(reduceQuestionPlayground(state, { type: 'disconnect' })).toBe(state);
  state = reduceQuestionPlayground(state, { type: 'fail' });
  expect(state.failedAction).toBe('submit');
  expect(state.answers).toEqual(answers);
  state = reduceQuestionPlayground(state, { type: 'submit', answers });
  state = reduceQuestionPlayground(state, { type: 'resolve' });
  expect(state.phase).toBe('answered');
  expect(reduceQuestionPlayground(state, { type: 'fail' })).toBe(state);
});

it('supports dismissal recovery and isolates a new question from old answers', () => {
  let state = reduceQuestionPlayground(initialPlaygroundMachine, {
    type: 'dismiss',
  });
  state = reduceQuestionPlayground(state, { type: 'fail' });
  expect(state.failedAction).toBe('dismiss');
  state = reduceQuestionPlayground(state, { type: 'disconnect' });
  expect(state.phase).toBe('disconnected');
  state = reduceQuestionPlayground(state, { type: 'reconnect' });
  expect(state.failedAction).toBeNull();
  state = reduceQuestionPlayground(state, { type: 'dismiss' });
  state = reduceQuestionPlayground(state, { type: 'resolve' });
  expect(state.phase).toBe('dismissed');
  state = reduceQuestionPlayground(state, { type: 'preset', id: 'brief' });
  expect(state).toMatchObject({
    phase: 'pending',
    presetId: 'brief',
    generation: 1,
    answers: [],
  });
});
