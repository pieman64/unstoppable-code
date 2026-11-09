import type { StageVisualDocument } from '../lib/chat-visual-contracts';
import type { z } from 'zod/v4';
import type { showVisualSchema } from './definitions';
import type {
  PreparedVisual,
  VisualMeasureRequest,
  VisualMeasureResult,
} from '../browser/visual-preview-types';
import { VISUAL_PREVIEW_LIMITS } from '../browser/visual-preview-types';
import { randomUUID } from 'node:crypto';
import {
  VISUAL_TITLE_MAX_LENGTH,
  clampVisualHeight,
  isValidVisualHeights,
} from '@canopy/agent-transcript/lib/visual-ref';
import { inlineVisualImages, validateVisualHtml } from './prepare-visual-html';

export type ShowVisualInput = z.infer<typeof showVisualSchema>;

/** Main-owned host authority; none of these fields may come from tool arguments. */
export interface ShowVisualHost {
  scope: { projectId: string; worktreeId: string };
  chatId: string;
  cwd: string;
  stageVisual(document: StageVisualDocument): Promise<unknown>;
  measureVisual?(
    prepared: PreparedVisual,
    options: Omit<VisualMeasureRequest, 'prepared' | 'appearance'>,
  ): Promise<VisualMeasureResult>;
  codexCallId?: string;
}

export interface ShowVisualResult {
  text: string;
  isError?: boolean;
}

function failure(text: string): ShowVisualResult {
  return { text, isError: true };
}

function acceptedHeights(
  result: VisualMeasureResult | undefined,
  widths: readonly number[],
  maxHeight: number,
): ReadonlyArray<readonly [number, number]> | undefined {
  if (result?.status !== 'ok' || !isValidVisualHeights(result.heights))
    return undefined;
  if (result.heights.length !== widths.length) return undefined;
  const byWidth = new Map<number, number>();
  for (const [width, height] of result.heights) {
    if (
      !widths.includes(width) ||
      byWidth.has(width) ||
      height < 80 ||
      height > maxHeight
    )
      return undefined;
    byWidth.set(width, height);
  }
  return widths.map((width): readonly [number, number] => [
    width,
    byWidth.get(width) ?? maxHeight,
  ]);
}

async function measureHeights(
  host: ShowVisualHost,
  prepared: PreparedVisual,
  maxHeight: number,
): Promise<ReadonlyArray<readonly [number, number]> | undefined> {
  if (!host.measureVisual) return undefined;
  const controller = new AbortController();
  const widths = VISUAL_PREVIEW_LIMITS.measureWidths;
  const deadlineMs = VISUAL_PREVIEW_LIMITS.measureDeadlineMs;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<undefined>((resolve): void => {
    timer = setTimeout((): void => resolve(undefined), deadlineMs);
  });
  // Catch the loser too: a defensive host may reject even after timeout.
  const measurement = Promise.resolve()
    .then(() =>
      host.measureVisual?.(prepared, {
        maxHeight,
        widths,
        deadlineMs,
        signal: controller.signal,
      }),
    )
    .catch((): undefined => undefined);
  try {
    const result = await Promise.race([measurement, timeout]);
    return acceptedHeights(result, widths, maxHeight);
  } finally {
    if (timer) clearTimeout(timer);
    controller.abort();
  }
}

/** Prepare and stage a visual for this trusted chat. */
export async function executeShowVisual(
  input: ShowVisualInput,
  host: ShowVisualHost,
): Promise<ShowVisualResult> {
  if (!host.chatId || !host.scope.projectId || !host.scope.worktreeId)
    return failure('A current chat is required to show a visual.');
  const validated = validateVisualHtml(input.html);
  if (!validated.ok) return failure(validated.error);
  const title = input.title.trim();
  if (!title || title.length > VISUAL_TITLE_MAX_LENGTH)
    return failure('Give the visual a title of 1 to 120 characters.');
  const inlined = await inlineVisualImages(validated.value, host, {
    unresolved: 'error',
  });
  if (!inlined.ok) return failure(inlined.error);
  const prepared = inlined.value.html;
  const maxHeight = clampVisualHeight(input.height);
  const heights = await measureHeights(host, inlined.value, maxHeight);
  const visualId = `vis_${randomUUID().toLowerCase()}`;
  try {
    await host.stageVisual({
      visualId,
      html: prepared,
      title,
      maxHeight,
      ...(heights ? { heights } : {}),
      ...(host.codexCallId ? { codexCallId: host.codexCallId } : {}),
    });
  } catch {
    return failure(
      'The visual could not be shown in this chat. Check that the chat is still open, then try again.',
    );
  }
  return {
    text: `${visualId} Shown to the user above your reply. Don't announce, describe, or restate it; add only what it doesn't show.`,
  };
}
