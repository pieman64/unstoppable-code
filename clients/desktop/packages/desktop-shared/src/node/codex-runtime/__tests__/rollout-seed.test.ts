import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  dropTrailingUserInput,
  loadCodexThreadSeedItemsWithLoadCount,
  readCodexRolloutSeedItems,
  sanitizeSeedItemsForRouteChange,
} from '../rollout-seed';

describe('Codex rollout reconstruction seed', () => {
  it('retains JSON history containing literal Unicode line and paragraph separators', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-rollout-unicode-'));
    const rollout = join(root, 'rollout.jsonl');
    const item = {
      type: 'message',
      role: 'user',
      content: [
        {
          type: 'input_text',
          text: 'stateDiagram-v2\u2028classDef x\u2029[*] --> A',
        },
      ],
    };
    await writeFile(
      rollout,
      JSON.stringify({ type: 'response_item', payload: item }) + '\n',
    );
    await expect(readCodexRolloutSeedItems(rollout)).resolves.toEqual([item]);
  });

  it('drops provider-private reasoning only when the route family changes', () => {
    const message = {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'hello' }],
    };
    const deepSeekReasoning = {
      type: 'reasoning',
      id: 'rs_1787282486656_ycxmhlm1f1a',
      summary: [],
      content: [
        {
          type: 'reasoning_text',
          text: 'The user is asking me to say "hi" in 3 languages…',
        },
      ],
      encrypted_content: null,
      internal_chat_message_metadata_passthrough: {
        turn_id: '01a02256-6132-75e0-822a-827ee0e3a505',
      },
    };
    const functionCall = {
      type: 'function_call',
      name: 'lookup',
      arguments: '{}',
      call_id: 'call-1',
    };
    const openAiReasoning = {
      type: 'reasoning',
      id: 'rs_0a3be',
      summary: [],
      content: [],
      encrypted_content: 'encrypted-provider-payload',
    };
    const functionCallOutput = {
      type: 'function_call_output',
      call_id: 'call-1',
      output: 'result',
    };
    const items = [
      message,
      deepSeekReasoning,
      functionCall,
      openAiReasoning,
      functionCallOutput,
    ];

    expect(sanitizeSeedItemsForRouteChange(items)).toEqual([
      message,
      functionCall,
      functionCallOutput,
    ]);
    expect(
      sanitizeSeedItemsForRouteChange(items, {
        sourceRouteFamily: 'gateway:deepseek',
        targetRouteFamily: 'native',
      }),
    ).toEqual([message, functionCall, functionCallOutput]);
    expect(
      sanitizeSeedItemsForRouteChange(items, {
        sourceRouteFamily: 'gateway:deepseek',
        targetRouteFamily: 'gateway:deepseek',
      }),
    ).toEqual(items);
  });

  it('keeps a tool call and its output when the preceding reasoning item is dropped', () => {
    // Ordering pin. Reasoning items are removed whole, which can leave a
    // `function_call` whose preceding reasoning item is gone. That is the
    // deliberate behavior: the Responses API rejects a *reasoning* item that
    // is not followed by the item it belongs to, and rejects a
    // `function_call_output` with no matching `function_call`. Dropping the
    // orphaned call would strand its output; keeping the pair satisfies both
    // constraints. If this ever needs to change, the output must be removed in
    // the same pass.
    const reasoning = {
      type: 'reasoning',
      id: 'rs_paired',
      summary: [],
      encrypted_content: 'foreign-blob',
    };
    const functionCall = {
      type: 'function_call',
      name: 'shell',
      arguments: '{"command":"ls"}',
      call_id: 'call-42',
    };
    const functionCallOutput = {
      type: 'function_call_output',
      call_id: 'call-42',
      output: 'README.md',
    };
    const assistantMessage = {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'Listed the repo.' }],
    };

    expect(
      sanitizeSeedItemsForRouteChange(
        [reasoning, functionCall, functionCallOutput, assistantMessage],
        { sourceRouteFamily: 'gateway:deepseek', targetRouteFamily: 'native' },
      ),
    ).toEqual([functionCall, functionCallOutput, assistantMessage]);
  });

  it('replays native response_item payloads and ignores a partial tail', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-rollout-seed-'));
    const rollout = join(root, 'rollout.jsonl');
    await writeFile(
      rollout,
      [
        JSON.stringify({ type: 'session_meta', payload: { id: 'thread-1' } }),
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'hello' }],
          },
        }),
        JSON.stringify({ type: 'event_msg', payload: { type: 'token_count' } }),
        '{"type":"response_item"',
      ].join('\n'),
      'utf8',
    );

    await expect(readCodexRolloutSeedItems(rollout)).resolves.toEqual([
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'hello' }],
      },
    ]);
  });

  it('uses compacted replacement history as the base for the later tail', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-rollout-seed-'));
    const rollout = join(root, 'rollout.jsonl');
    const discarded = {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'discarded before compaction' }],
    };
    const compactedSummary = {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'compacted summary' }],
    };
    const retainedTail = {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'after compaction' }],
    };
    await writeFile(
      rollout,
      [
        JSON.stringify({ type: 'response_item', payload: discarded }),
        JSON.stringify({
          type: 'compacted',
          payload: {
            message: 'compacted summary',
            replacement_history: [compactedSummary],
            window_number: 1,
          },
        }),
        JSON.stringify({ type: 'response_item', payload: retainedTail }),
      ].join('\n'),
      'utf8',
    );

    await expect(readCodexRolloutSeedItems(rollout)).resolves.toEqual([
      compactedSummary,
      retainedTail,
    ]);
  });

  it('applies the newest replacement history across repeated compactions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-rollout-seed-'));
    const rollout = join(root, 'rollout.jsonl');
    const latestSummary = {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'latest compacted summary' }],
    };
    const latestTail = {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'latest tail' }],
    };
    await writeFile(
      rollout,
      [
        JSON.stringify({
          type: 'response_item',
          payload: { type: 'message', role: 'user', content: [] },
        }),
        JSON.stringify({
          type: 'compacted',
          payload: {
            message: 'first summary',
            replacement_history: [
              {
                type: 'message',
                role: 'user',
                content: [{ type: 'input_text', text: 'first summary' }],
              },
            ],
          },
        }),
        JSON.stringify({
          type: 'response_item',
          payload: { type: 'message', role: 'assistant', content: [] },
        }),
        JSON.stringify({
          type: 'compacted',
          payload: {
            message: 'latest compacted summary',
            replacement_history: [latestSummary],
          },
        }),
        JSON.stringify({ type: 'response_item', payload: latestTail }),
      ].join('\n'),
      'utf8',
    );

    await expect(readCodexRolloutSeedItems(rollout)).resolves.toEqual([
      latestSummary,
      latestTail,
    ]);
  });

  it('uses a legacy compaction summary without restoring discarded history', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-rollout-seed-'));
    const rollout = join(root, 'rollout.jsonl');
    const retainedTail = {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'legacy tail' }],
    };
    await writeFile(
      rollout,
      [
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'discarded original' }],
          },
        }),
        JSON.stringify({
          type: 'compacted',
          payload: { message: 'legacy summary' },
        }),
        JSON.stringify({ type: 'response_item', payload: retainedTail }),
      ].join('\n'),
      'utf8',
    );

    await expect(readCodexRolloutSeedItems(rollout)).resolves.toEqual([
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'legacy summary' }],
      },
      retainedTail,
    ]);
  });

  it('finds a canonical rollout by thread id and falls back when absent', async () => {
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-home-seed-'));
    const sessions = join(codexHome, 'sessions', '2026', '07', '22');
    await mkdir(sessions, { recursive: true });
    await writeFile(
      join(sessions, 'rollout-2026-07-22-thread-native.jsonl'),
      `${JSON.stringify({
        type: 'response_item',
        payload: { type: 'message', role: 'assistant', content: [] },
      })}\n`,
      'utf8',
    );

    // The reported `source` is not cosmetic: `dropTrailingUserInput` may only
    // run on rollout-sourced items, because the renderer fallback already
    // excludes the pending message by id while the rollout does not.
    await expect(
      loadCodexThreadSeedItemsWithLoadCount({
        codexHome,
        threadId: 'thread-native',
      }),
    ).resolves.toEqual({
      items: [{ type: 'message', role: 'assistant', content: [] }],
      loadedItemCount: 1,
      source: 'rollout',
    });
    await expect(
      loadCodexThreadSeedItemsWithLoadCount({
        codexHome,
        threadId: 'missing',
        fallbackItems: [{ type: 'message', role: 'user', content: [] }],
      }),
    ).resolves.toEqual({
      items: [{ type: 'message', role: 'user', content: [] }],
      loadedItemCount: 1,
      source: 'fallback',
    });
  });

  it('reports the fallback source when a rollout sanitizes down to nothing', async () => {
    // A rollout was found, but every item in it was provider-private reasoning
    // the target route cannot decode, so the loader falls through to the
    // renderer transcript. The returned items are the fallback's, and the
    // reported source must say so — trimming the trailing input here would
    // delete a genuine earlier message the fallback loader already vetted.
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-home-source-'));
    const sessions = join(codexHome, 'sessions', '2026', '08', '21');
    await mkdir(sessions, { recursive: true });
    await writeFile(
      join(sessions, 'rollout-2026-08-21-thread-foreign.jsonl'),
      `${JSON.stringify({
        type: 'response_item',
        payload: {
          type: 'reasoning',
          id: 'rs_foreign_1',
          summary: [],
          encrypted_content: 'gAAAAAB-foreign-blob',
        },
      })}\n`,
      'utf8',
    );

    await expect(
      loadCodexThreadSeedItemsWithLoadCount({
        codexHome,
        threadId: 'thread-foreign',
        fallbackItems: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'Continue' }],
          },
        ],
        targetRouteFamily: 'native',
      }),
    ).resolves.toEqual({
      items: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'Continue' }],
        },
      ],
      loadedItemCount: 1,
      source: 'fallback',
    });
  });
  it('drops reasoning of unknown provenance, including native encrypted items', () => {
    const nativeEncryptedReasoning = {
      type: 'reasoning',
      id: 'rs_native_1',
      summary: [],
      encrypted_content: 'gAAAAAB-native-blob',
    };
    const message = {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'done' }],
    };

    // An absent sourceRouteFamily means the lease predates route-family
    // tracking, so provenance is unknown. Fail closed and drop the reasoning
    // even though the target is native and the item may well be native too:
    // replaying reasoning the provider rejects breaks the turn outright, while
    // dropping it only costs cached thinking context.
    expect(
      sanitizeSeedItemsForRouteChange([nativeEncryptedReasoning, message], {
        targetRouteFamily: 'native',
      }),
    ).toEqual([message]);

    // A known, matching provenance still retains it.
    expect(
      sanitizeSeedItemsForRouteChange([nativeEncryptedReasoning, message], {
        targetRouteFamily: 'native',
        sourceRouteFamily: 'native',
      }),
    ).toEqual([nativeEncryptedReasoning, message]);
  });

  it('drops every reasoning item on a route change, not only populated ones', () => {
    // CHANGED EXPECTATION. This test previously asserted that a reasoning item
    // with empty `content` SURVIVES a route change. That encoded a bug: the
    // upstream rejections this sanitizer exists to prevent also name
    // `input[N].internal_chat_message_metadata_passthrough` and
    // `input[N].type` (see `isIncompatibleReasoningHistoryError()` in
    // `agents/codex-session.ts`), so a metadata-only or type-only reasoning
    // item survived the rebuild, was reinjected verbatim, burned the retry
    // budget, and surfaced the original error to the user anyway. Reasoning
    // items are optional in a Responses input list, so dropping all of them on
    // a changed/unknown family is always safe.
    const stringContentReasoning = {
      type: 'reasoning',
      id: 'rs_odd_1',
      content: 'raw provider reasoning',
    };
    const emptyArrayReasoning = {
      type: 'reasoning',
      id: 'rs_empty_1',
      content: [],
    };
    const metadataOnlyReasoning = {
      type: 'reasoning',
      id: 'rs_metadata_1',
      summary: [],
      content: [],
      encrypted_content: null,
      internal_chat_message_metadata_passthrough: {
        turn_id: '01a02256-6132-75e0-822a-827ee0e3a505',
      },
    };
    const typeOnlyReasoning = { type: 'reasoning', id: 'rs_bare_1' };
    const message = {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'kept' }],
    };

    expect(
      sanitizeSeedItemsForRouteChange(
        [
          stringContentReasoning,
          emptyArrayReasoning,
          metadataOnlyReasoning,
          typeOnlyReasoning,
          message,
        ],
        { targetRouteFamily: 'native', sourceRouteFamily: 'gateway:deepseek' },
      ),
    ).toEqual([message]);

    // The same-family retention path is untouched: nothing is dropped when the
    // provenance is known and matches.
    expect(
      sanitizeSeedItemsForRouteChange(
        [metadataOnlyReasoning, typeOnlyReasoning, message],
        {
          targetRouteFamily: 'gateway:deepseek',
          sourceRouteFamily: 'gateway:deepseek',
        },
      ),
    ).toEqual([metadataOnlyReasoning, typeOnlyReasoning, message]);
  });

  it('reports the pre-sanitization load count so an all-reasoning tail is not "no history"', async () => {
    // A caller that treats an empty result as a fatal "no persisted history"
    // error must be able to tell "nothing was ever persisted" from "everything
    // persisted was provider-private reasoning".
    const codexHome = await mkdtemp(join(tmpdir(), 'codex-home-load-count-'));
    const sessions = join(codexHome, 'sessions', '2026', '08', '21');
    await mkdir(sessions, { recursive: true });
    await writeFile(
      join(sessions, 'rollout-2026-08-21-thread-all-reasoning.jsonl'),
      `${[
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'reasoning',
            id: 'rs_only_1',
            summary: [],
            encrypted_content: 'gAAAAAB-foreign',
          },
        }),
        JSON.stringify({
          type: 'response_item',
          payload: {
            type: 'reasoning',
            id: 'rs_only_2',
            internal_chat_message_metadata_passthrough: { turn_id: 'x' },
          },
        }),
      ].join('\n')}\n`,
      'utf8',
    );

    await expect(
      loadCodexThreadSeedItemsWithLoadCount({
        codexHome,
        threadId: 'thread-all-reasoning',
        targetRouteFamily: 'native',
      }),
      // The rollout was found but sanitized to nothing, so the (empty) result
      // is the fallback's — and the trailing-input trim must not run on it.
    ).resolves.toEqual({ items: [], loadedItemCount: 2, source: 'fallback' });

    // Nothing persisted at all stays distinguishable.
    await expect(
      loadCodexThreadSeedItemsWithLoadCount({
        codexHome,
        threadId: 'thread-missing',
        targetRouteFamily: 'native',
      }),
    ).resolves.toEqual({ items: [], loadedItemCount: 0, source: 'fallback' });
  });

  it('trims only a trailing user message that repeats the pending input', () => {
    const earlierSamePrompt = {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'retry me' }],
    };
    const assistantReply = {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text: 'ok' }],
    };
    const persistedFailedInput = {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'retry me' }],
    };

    // The rollout already persisted the input of the turn that failed; the
    // caller is about to re-send it, so only that trailing copy is removed.
    expect(
      dropTrailingUserInput(
        [earlierSamePrompt, assistantReply, persistedFailedInput],
        'retry me',
      ),
    ).toEqual([earlierSamePrompt, assistantReply]);

    // A trailing assistant message means the failed input was never persisted.
    expect(
      dropTrailingUserInput([earlierSamePrompt, assistantReply], 'retry me'),
    ).toEqual([earlierSamePrompt, assistantReply]);

    // A different trailing prompt is left alone.
    expect(
      dropTrailingUserInput([persistedFailedInput], 'something else'),
    ).toEqual([persistedFailedInput]);

    // No pending input: nothing is trimmed.
    expect(dropTrailingUserInput([persistedFailedInput], undefined)).toEqual([
      persistedFailedInput,
    ]);
  });
  it('removes at most one trailing input and never a multimodal message', () => {
    const repeated = {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'retry me' }],
    };

    // A user who genuinely sent the same prompt twice in a row has a real run
    // of identical messages. Only the single copy attributable to the failed
    // turn may be removed.
    expect(
      dropTrailingUserInput([repeated, repeated, repeated], 'retry me'),
    ).toEqual([repeated, repeated]);

    // A trailing message carrying an attachment is never dropped, even when
    // its text matches — trimming it would silently discard the attachment.
    const multimodal = {
      type: 'message',
      role: 'user',
      content: [
        { type: 'input_text', text: 'retry me' },
        { type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
      ],
    };
    expect(dropTrailingUserInput([repeated, multimodal], 'retry me')).toEqual([
      repeated,
      multimodal,
    ]);

    // An unrecognized part shape is likewise refused rather than guessed at.
    const unknownPart = {
      type: 'message',
      role: 'user',
      content: [{ type: 'some_future_part', text: 'retry me' }],
    };
    expect(dropTrailingUserInput([unknownPart], 'retry me')).toEqual([
      unknownPart,
    ]);
  });
});
