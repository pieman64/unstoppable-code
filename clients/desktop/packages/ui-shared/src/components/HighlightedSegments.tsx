import type { JSX } from 'react';

export interface MatchSegment {
  text: string;
  highlighted: boolean;
}

export interface HighlightedSegmentsProps {
  segments: readonly MatchSegment[];
}

export interface HighlightedTextProps {
  text: string;
  indices: readonly number[];
}

export function splitMatchSegments(
  text: string,
  indices: readonly number[],
): MatchSegment[] {
  if (text.length === 0) return [];
  if (indices.length === 0) return [{ text, highlighted: false }];

  const indexSet = new Set(indices);
  const segments: MatchSegment[] = [];
  let buffer = '';
  let bufferHighlighted = indexSet.has(0);

  for (let index = 0; index < text.length; index += 1) {
    const highlighted = indexSet.has(index);
    if (index === 0 || highlighted === bufferHighlighted) {
      buffer += text[index];
    } else {
      segments.push({ text: buffer, highlighted: bufferHighlighted });
      buffer = text[index];
      bufferHighlighted = highlighted;
    }
  }

  if (buffer.length > 0) {
    segments.push({ text: buffer, highlighted: bufferHighlighted });
  }
  return segments;
}

export function rangesToIndices(
  ranges: readonly { start: number; end: number }[],
): number[] {
  const indices: number[] = [];
  for (const range of ranges) {
    for (let index = Math.max(0, range.start); index < range.end; index += 1) {
      indices.push(index);
    }
  }
  return indices;
}

export function HighlightedSegments({
  segments,
}: HighlightedSegmentsProps): JSX.Element {
  return (
    <>
      {segments.map((segment, index) =>
        segment.highlighted ? (
          <mark key={index} className="bg-transparent font-semibold fg-accent">
            {segment.text}
          </mark>
        ) : (
          <span key={index}>{segment.text}</span>
        ),
      )}
    </>
  );
}

export function HighlightedText({
  text,
  indices,
}: HighlightedTextProps): JSX.Element {
  return <HighlightedSegments segments={splitMatchSegments(text, indices)} />;
}
