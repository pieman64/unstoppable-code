/**
 * Coverage for the extension → initial file-tab view mode mapping used when a
 * chat link opens a file the user has not already got open.
 */
import { initialFileTabViewMode } from '../initial-view-mode';

describe('initialFileTabViewMode', () => {
  it.each([
    'report.md',
    'REPORT.MD',
    'notes.markdown',
    'notes.mdx',
    'page.html',
    'page.htm',
  ])('opens %s rendered', (filename) => {
    expect(initialFileTabViewMode(filename)).toBe('preview');
  });

  it.each(['metrics.csv', 'Metrics.CSV'])('opens %s as a table', (filename) => {
    expect(initialFileTabViewMode(filename)).toBe('table');
  });

  it.each([
    'index.ts',
    'styles.css',
    'diagram.png',
    'archive.md.gz',
    'README',
    '',
  ])('leaves %s on the raw default', (filename) => {
    expect(initialFileTabViewMode(filename)).toBeUndefined();
  });

  it('reads the extension from a full path', () => {
    expect(initialFileTabViewMode('/repo/docs/report.md')).toBe('preview');
    expect(initialFileTabViewMode('C:\\repo\\docs\\data.csv')).toBe('table');
  });
});
