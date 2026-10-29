import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SOURCE = readFileSync(
  join(__dirname, '..', 'services', 'chat-state-v2-backend.ts'),
  'utf8',
);

describe('ChatStateV2Backend performance instrumentation', () => {
  it('estimates page bytes from descriptor metadata without serializing the payload', () => {
    const pageStart = SOURCE.indexOf('public async page(');
    const pageEnd = SOURCE.indexOf('public async toolOutput(', pageStart);
    const pageSource = SOURCE.slice(pageStart, pageEnd);

    expect(pageSource).toContain('estimateTranscriptWindowBytes');
    expect(pageSource).not.toContain('JSON.stringify(page)');
  });
});
