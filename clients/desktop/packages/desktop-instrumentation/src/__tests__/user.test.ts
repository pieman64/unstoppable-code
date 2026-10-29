import { buildDesktopInstrumentationUser } from '../user';

describe('buildDesktopInstrumentationUser', () => {
  it('derives a short non-PII display name from the install id', () => {
    expect(
      buildDesktopInstrumentationUser('d7b997cc-b1dd-4b4a-ac00-b00c7c007118'),
    ).toEqual({
      id: 'd7b997cc-b1dd-4b4a-ac00-b00c7c007118',
      name: 'anon-d7b997cc',
    });
  });
});
