// Preconditions for the live primary output flows, read through the desktop's
// existing transcript page: what the provider returned and Canopy stored.
import { expect } from '@playwright/test';

/**
 * Asserts each released stage's canonical result: `stored` is kept apart and
 * larger than the inline limit, `inline` is inline and longer than the
 * Portal preview. Returns each result's row id and absolute block ordinal.
 */
export async function expectPrimaryLiveResults(window, scope, chatId, stages) {
  let results = {};
  await expect(async () => {
    const page = await window.evaluate(
      (request) => window.api.chat.getTranscriptPage(request),
      { ...scope, chatId },
    );
    results = {};
    for (const message of page.messages)
      (message.blocks ?? []).forEach((block, blockOrdinal) => {
        const stage = /^primary-live-(stored|inline)/.exec(
          block.type === 'tool_result' ? (block.toolUseId ?? '') : '',
        )?.[1];
        if (stage)
          results[stage] = {
            messageId: message.id,
            blockOrdinal,
            outputLength: block.output?.length ?? 0,
            storedByteLength: block.fullOutputRef?.byteLength,
          };
      });
    expect(Object.keys(results).sort()).toEqual([...stages].sort());
  }).toPass({ timeout: 30_000 });
  if (results.stored)
    expect(results.stored.storedByteLength).toBeGreaterThan(65_536);
  if (results.inline) {
    expect(results.inline.storedByteLength).toBeUndefined();
    expect(results.inline.outputLength).toBeGreaterThan(4_000);
  }
  return results;
}
