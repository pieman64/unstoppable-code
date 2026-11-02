import { formatDateTime } from '../format-date';

describe('formatDateTime', (): void => {
  it('renders a parseable timestamp as locale date and time', (): void => {
    const iso = '2026-03-04T15:06:07.000Z';
    expect(formatDateTime(iso)).toBe(new Date(iso).toLocaleString());
  });

  it('returns unparseable input unchanged', (): void => {
    expect(formatDateTime('not-a-date')).toBe('not-a-date');
  });
});
