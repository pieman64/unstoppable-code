import {
  clearQuestionPromptProgress,
  readQuestionPromptProgress,
  resetQuestionPromptProgressForTests,
  saveQuestionPromptProgress,
  type QuestionPromptProgress,
} from '../question-prompt-progress';

function progress(step: number, pick = 'Yes'): QuestionPromptProgress {
  return {
    step,
    selections: new Map([[0, [pick]]]),
    texts: new Map([[1, 'name']]),
  };
}

describe('question prompt progress', () => {
  afterEach(() => {
    resetQuestionPromptProgressForTests();
  });

  it('reads back saved progress until it is cleared', () => {
    expect(readQuestionPromptProgress('r1')).toBeUndefined();
    saveQuestionPromptProgress('r1', progress(1));
    expect(readQuestionPromptProgress('r1')).toEqual(progress(1));
    clearQuestionPromptProgress('r1');
    expect(readQuestionPromptProgress('r1')).toBeUndefined();
  });

  it('keeps each request id separate', () => {
    saveQuestionPromptProgress('r1', progress(1, 'Yes'));
    saveQuestionPromptProgress('r2', progress(2, 'No'));
    clearQuestionPromptProgress('r1');
    expect(readQuestionPromptProgress('r1')).toBeUndefined();
    expect(readQuestionPromptProgress('r2')).toEqual(progress(2, 'No'));
  });

  it('replaces progress saved twice for the same id', () => {
    saveQuestionPromptProgress('r1', progress(1, 'Yes'));
    saveQuestionPromptProgress('r1', progress(2, 'No'));
    expect(readQuestionPromptProgress('r1')).toEqual(progress(2, 'No'));
  });

  it('evicts the oldest entry past the cap', () => {
    for (let index = 1; index <= 33; index += 1) {
      saveQuestionPromptProgress(`r${index}`, progress(index));
    }
    expect(readQuestionPromptProgress('r1')).toBeUndefined();
    expect(readQuestionPromptProgress('r2')).toEqual(progress(2));
    expect(readQuestionPromptProgress('r33')).toEqual(progress(33));
  });

  it('treats clearing an unknown id as a no-op', () => {
    saveQuestionPromptProgress('r1', progress(1));
    expect(() => clearQuestionPromptProgress('missing')).not.toThrow();
    expect(readQuestionPromptProgress('r1')).toEqual(progress(1));
  });
});
