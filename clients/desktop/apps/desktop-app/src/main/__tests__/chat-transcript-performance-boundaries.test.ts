// The transcript log is intentionally large; source-level assertions protect
// the exact timing boundary without coupling storage tests to a global clock.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SOURCE = readFileSync(
  join(__dirname, '..', 'lib', 'chat-transcript-log.ts'),
  'utf8',
);

describe('chat transcript performance timing boundaries', () => {
  it('finishes read/reconstruction stages before byte estimation work', () => {
    const activeStart = SOURCE.indexOf('public async activeMessages');
    const activeEnd = SOURCE.indexOf(
      'public async ownsToolOutputReference',
      activeStart,
    );
    const pageStart = SOURCE.indexOf('public async page(', activeEnd);
    const pageEnd = SOURCE.indexOf('public async *iterate(', pageStart);

    const activeSource = SOURCE.slice(activeStart, activeEnd);
    const pageSource = SOURCE.slice(pageStart, pageEnd);

    expect(activeSource).not.toContain('JSON.stringify(messages)');
    expect(pageSource).not.toContain('JSON.stringify(result.messages)');
    expect(pageSource).toContain(
      'finishRangeRead({ loadedRows: result.messages.length });',
    );
  });
});
