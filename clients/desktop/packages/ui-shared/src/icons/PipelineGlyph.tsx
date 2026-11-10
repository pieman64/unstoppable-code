import type { JSX } from 'react';
import { TriggerIcon } from './AppIcons';

export interface PipelineGlyphProps {
  /** The pipeline's own glyph, an emoji from its definition. May be empty. */
  readonly icon: string | undefined;
}

/**
 * A pipeline's glyph on a row or header: its own emoji when the definition
 * sets one, else the trigger mark.
 */
export function PipelineGlyph({ icon }: PipelineGlyphProps): JSX.Element {
  return icon ? (
    <span className="shrink-0 text-m">{icon}</span>
  ) : (
    <TriggerIcon size="sm" className="shrink-0 fg-secondary" />
  );
}
