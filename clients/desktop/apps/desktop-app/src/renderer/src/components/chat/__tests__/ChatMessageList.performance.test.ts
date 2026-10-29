// Static source coverage follows the established renderer test pattern for
// this large component: it protects hook timing and dependency boundaries
// without mounting the entire chat/store graph.
// eslint-disable-next-line no-restricted-imports
import { readFileSync } from 'node:fs';
// eslint-disable-next-line no-restricted-imports
import { join } from 'node:path';

const SOURCE = readFileSync(
  join(__dirname, '..', 'ChatMessageList.tsx'),
  'utf8',
);

describe('ChatMessageList transcript performance boundaries', () => {
  it('measures commit-to-frame from the commit and reuses its revision correlation', () => {
    const effectStart = SOURCE.indexOf(
      'const commitCorrelationId = finishTranscriptPerformanceCommit',
    );
    const queueStart = SOURCE.indexOf(
      'performanceFrameQueueRef.current?.enqueue',
      effectStart,
    );

    expect(effectStart).toBeGreaterThan(-1);
    expect(queueStart).toBeGreaterThan(effectStart);
    expect(SOURCE.slice(queueStart, queueStart + 300)).toContain(
      'enqueue(commitCorrelationId',
    );
    expect(SOURCE).not.toContain('${chatId}:commit:${messages.length}');
  });

  it('finishes a commit marker when only pending questions change', () => {
    expect(SOURCE).toContain(
      'chatPendingQuestions,\n    stickySections.length,\n    transcriptVirtualItems.length,',
    );
  });

  it('uses bounded byte metadata and a durable frame queue', () => {
    expect(SOURCE).toContain('createTranscriptPerformanceFrameQueue');
    expect(SOURCE).toContain(
      "setTranscriptPerformanceCounter('loaded_bytes', loadedBytesEstimate)",
    );
    expect(SOURCE).not.toContain('JSON.stringify(messages)');
    expect(SOURCE).not.toContain('new TextEncoder()');
    expect(SOURCE).not.toContain('cancelAnimationFrame(animationFrame)');
  });
});
