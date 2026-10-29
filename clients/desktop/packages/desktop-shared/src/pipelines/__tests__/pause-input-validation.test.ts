import {
  validatePauseInputAnswerErrors,
  validatePauseInputAnswers,
  validatePauseInputRequest,
} from '../pause-input-validation';
import type { PauseInputRequest } from '../../types/pipeline';

const request: PauseInputRequest = {
  fields: [
    { key: 'scope', label: 'Scope', type: 'string', required: true },
    {
      key: 'decision',
      label: 'Decision',
      type: 'choice',
      options: ['continue', 'revise'],
      required: true,
    },
    { key: 'passes', label: 'Passes', type: 'number', min: 1, max: 3 },
    { key: 'approved', label: 'Approved', type: 'boolean' },
  ],
};

describe('validatePauseInputRequest', () => {
  it('returns a sanitized request for valid input', () => {
    expect(
      validatePauseInputRequest({
        title: 'Review',
        message: 'Confirm details',
        ignored: 'drop me',
        fields: [
          {
            key: 'scope',
            label: 'Scope',
            type: 'string',
            description: 'Release scope',
            required: true,
            multiline: true,
            default: 'desktop',
            ignored: 'drop me',
          },
          {
            key: 'decision',
            label: 'Decision',
            type: 'choice',
            options: ['continue', 'revise'],
            default: 'continue',
          },
        ],
      }),
    ).toEqual({
      title: 'Review',
      message: 'Confirm details',
      fields: [
        {
          key: 'scope',
          label: 'Scope',
          type: 'string',
          description: 'Release scope',
          required: true,
          multiline: true,
          default: 'desktop',
        },
        {
          key: 'decision',
          label: 'Decision',
          type: 'choice',
          options: ['continue', 'revise'],
          default: 'continue',
        },
      ],
    });
  });

  it('rejects malformed requests', () => {
    expect(validatePauseInputRequest(null)).toBeUndefined();
    expect(validatePauseInputRequest({})).toBeUndefined();
    expect(
      validatePauseInputRequest({ fields: [{ key: 'x', label: 'X' }] }),
    ).toBeUndefined();
  });

  it('rejects json fields because pause inputs remain scalar-only', () => {
    expect(
      validatePauseInputRequest({
        fields: [{ key: 'payload', label: 'Payload', type: 'json' }],
      }),
    ).toBeUndefined();
  });

  it('rejects duplicate or invalid field keys', () => {
    expect(
      validatePauseInputRequest({
        fields: [
          { key: 'scope', label: 'Scope', type: 'string' },
          { key: 'scope', label: 'Scope again', type: 'string' },
        ],
      }),
    ).toBeUndefined();
    expect(
      validatePauseInputRequest({
        fields: [{ key: 'bad-key', label: 'Bad', type: 'string' }],
      }),
    ).toBeUndefined();
  });

  it('rejects invalid choices and number bounds', () => {
    expect(
      validatePauseInputRequest({
        fields: [{ key: 'decision', label: 'Decision', type: 'choice' }],
      }),
    ).toBeUndefined();
    expect(
      validatePauseInputRequest({
        fields: [
          { key: 'passes', label: 'Passes', type: 'number', min: 3, max: 1 },
        ],
      }),
    ).toBeUndefined();
  });

  it('rejects non-string defaults for string fields', () => {
    expect(
      validatePauseInputRequest({
        fields: [{ key: 'scope', label: 'Scope', type: 'string', default: 12 }],
      }),
    ).toBeUndefined();
    expect(
      validatePauseInputRequest({
        fields: [
          { key: 'scope', label: 'Scope', type: 'string', default: false },
        ],
      }),
    ).toBeUndefined();
  });

  it('drops options metadata from non-choice fields', () => {
    expect(
      validatePauseInputRequest({
        fields: [
          {
            key: 'scope',
            label: 'Scope',
            type: 'string',
            options: ['desktop', 'web'],
          },
        ],
      }),
    ).toEqual({
      fields: [{ key: 'scope', label: 'Scope', type: 'string' }],
    });
  });

  it('drops type-specific metadata from fields with other types', () => {
    expect(
      validatePauseInputRequest({
        fields: [
          {
            key: 'scope',
            label: 'Scope',
            type: 'string',
            min: 1,
            max: 5,
          },
          {
            key: 'passes',
            label: 'Passes',
            type: 'number',
            multiline: true,
          },
          {
            key: 'decision',
            label: 'Decision',
            type: 'choice',
            options: ['continue', 'revise'],
            min: 1,
            max: 5,
            multiline: true,
          },
        ],
      }),
    ).toEqual({
      fields: [
        { key: 'scope', label: 'Scope', type: 'string' },
        { key: 'passes', label: 'Passes', type: 'number' },
        {
          key: 'decision',
          label: 'Decision',
          type: 'choice',
          options: ['continue', 'revise'],
        },
      ],
    });
  });
});

describe('validatePauseInputAnswers', () => {
  it('returns no errors for valid answers', () => {
    expect(
      validatePauseInputAnswers(request, {
        scope: 'desktop',
        decision: 'continue',
        passes: 2,
        approved: true,
      }),
    ).toEqual([]);
  });

  it('flags missing required answers and unknown keys', () => {
    expect(
      validatePauseInputAnswers(request, {
        decision: 'continue',
        extra: 'value',
      }),
    ).toEqual(['extra is not an expected field', 'scope is required']);
  });

  it('validates choice answers', () => {
    expect(
      validatePauseInputAnswers(request, {
        scope: 'desktop',
        decision: 'skip',
      }),
    ).toContain('decision must be one of: continue, revise');
  });

  it('validates number answers', () => {
    expect(
      validatePauseInputAnswers(request, {
        scope: 'desktop',
        decision: 'continue',
        passes: 'two',
      }),
    ).toContain('passes must be a number');
    expect(
      validatePauseInputAnswers(request, {
        scope: 'desktop',
        decision: 'continue',
        passes: 4,
      }),
    ).toContain('passes must be between 1 and 3');
    expect(
      validatePauseInputAnswers(request, {
        scope: 'desktop',
        decision: 'continue',
        passes: '2',
      }),
    ).toEqual([]);
  });

  it('validates boolean answers', () => {
    expect(
      validatePauseInputAnswers(request, {
        scope: 'desktop',
        decision: 'continue',
        approved: 'true',
      }),
    ).toContain('approved must be true or false');
  });

  it('validates string answers', () => {
    expect(
      validatePauseInputAnswers(request, {
        scope: 12,
        decision: 'continue',
      }),
    ).toContain('scope must be text');
    expect(
      validatePauseInputAnswers(request, {
        scope: false,
        decision: 'continue',
      }),
    ).toContain('scope must be text');
  });

  it('returns structured validation errors', () => {
    expect(
      validatePauseInputAnswerErrors(request, {
        decision: 'skip',
        extra: 'value',
      }),
    ).toEqual([
      { field: 'extra', message: 'extra is not an expected field' },
      { field: 'scope', message: 'scope is required' },
      {
        field: 'decision',
        message: 'decision must be one of: continue, revise',
      },
    ]);
  });
});
