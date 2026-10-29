import { parseMaxIterationsInput } from '../lib/jobDetailPanel';

describe('JobDetailPanel max iterations input', () => {
  it('preserves explicit 0 as a skip value', () => {
    expect(parseMaxIterationsInput('0')).toBe(0);
  });

  it('treats a blank value as clearing max_iterations', () => {
    expect(parseMaxIterationsInput('')).toBeUndefined();
    expect(parseMaxIterationsInput('   ')).toBeUndefined();
  });

  it('rejects invalid values without coercing them', () => {
    expect(parseMaxIterationsInput('-1')).toBeNull();
    expect(parseMaxIterationsInput('1.5')).toBeNull();
    expect(parseMaxIterationsInput('abc')).toBeNull();
  });
});
