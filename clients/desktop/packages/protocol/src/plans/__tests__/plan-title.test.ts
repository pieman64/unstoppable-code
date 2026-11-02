import { derivePlanTitle } from '../index';

describe('derivePlanTitle', () => {
  it('uses the first non-empty line without its heading marker', () => {
    expect(derivePlanTitle('\n\n# Ship the importer\n\nBody')).toBe(
      'Ship the importer',
    );
  });

  it('strips list bullets and ordered-list numbering', () => {
    expect(derivePlanTitle('- First step')).toBe('First step');
    expect(derivePlanTitle('* First step')).toBe('First step');
    expect(derivePlanTitle('1. First step')).toBe('First step');
  });

  it('trims surrounding whitespace on the chosen line', () => {
    expect(derivePlanTitle('   ## Spaced title   \nmore')).toBe('Spaced title');
  });

  it('caps the title at 120 characters', () => {
    const long = `# ${'a'.repeat(200)}`;
    expect(derivePlanTitle(long)).toBe('a'.repeat(120));
  });

  it('falls back to Untitled plan for empty or marker-only content', () => {
    expect(derivePlanTitle('')).toBe('Untitled plan');
    expect(derivePlanTitle('   \n\t\n')).toBe('Untitled plan');
    expect(derivePlanTitle('###')).toBe('Untitled plan');
  });
});
