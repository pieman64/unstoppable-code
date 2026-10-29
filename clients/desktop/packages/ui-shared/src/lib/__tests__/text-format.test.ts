import { capitalizeFirstLetter } from '../text-format';

describe('capitalizeFirstLetter', () => {
  it('capitalizes the first letter', () => {
    expect(capitalizeFirstLetter('run the tests')).toBe('Run the tests');
  });

  it('returns an empty string unchanged', () => {
    expect(capitalizeFirstLetter('')).toBe('');
  });

  it('preserves a non-BMP prefix without splitting its surrogate pair', () => {
    expect(capitalizeFirstLetter('🧪 run the tests')).toBe('🧪 run the tests');
  });
});
