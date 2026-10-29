import { titleCaseIdentifier as desktopTitleCaseIdentifier } from '../lib/scoped-config-utils';
import { titleCaseIdentifier as uiTitleCaseIdentifier } from '../../../ui-shared/src/lib/title-case-identifier';

describe('titleCaseIdentifier parity', () => {
  it.each([
    'kebab-case',
    'snake_case',
    'camelCase',
    'API-response-ID',
    '',
    'single',
  ])('matches both package implementations for %p', (value) => {
    expect(uiTitleCaseIdentifier(value)).toBe(
      desktopTitleCaseIdentifier(value),
    );
  });
});
