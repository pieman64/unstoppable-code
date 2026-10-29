import { readClaudeApiErrorStatus } from '../provider-errors';

describe('readClaudeApiErrorStatus', () => {
  it.each([100, 402, 429, 599])('reads structured HTTP %s', (status) => {
    expect(readClaudeApiErrorStatus({ api_error_status: status })).toBe(status);
  });
  it.each([null, undefined, '402', 402.5, NaN, 99, 600])(
    'does not fall back for present invalid status %s',
    (status) => {
      expect(
        readClaudeApiErrorStatus({
          api_error_status: status,
          result: 'API Error: 402 refused',
        }),
      ).toBeUndefined();
    },
  );
  it('prefers structured status even when the text conflicts', () => {
    expect(
      readClaudeApiErrorStatus({
        api_error_status: 401,
        result: 'API Error: 402 refused',
      }),
    ).toBe(401);
  });
  it('uses a strict leading result prefix when the field is absent', () => {
    expect(readClaudeApiErrorStatus({ result: 'API Error: 402 refused' })).toBe(
      402,
    );
  });
  it.each([
    null,
    [],
    'API Error: 402 refused',
    {},
    { result: 'quoted API Error: 402 refused' },
    { result: 'API Error: 4020 refused' },
    { result: 'API Error: 402x refused' },
    { message: 'API Error: 402 refused' },
    { result: 'api error: 402 refused' },
    { result: 'API Error: 600 refused' },
  ])('rejects malformed or unsupported input %j', (input) => {
    expect(readClaudeApiErrorStatus(input)).toBeUndefined();
  });
});
