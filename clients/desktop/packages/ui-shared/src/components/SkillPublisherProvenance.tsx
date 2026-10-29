import type { JSX } from 'react';
import type { SkillPublisherProvenance as Provenance } from '@canopy/protocol';

/** Publisher terms and the exact reviewed upstream source, shared by both hosts. */
export function SkillPublisherProvenance({
  publisher,
}: {
  publisher: Provenance;
}): JSX.Element {
  return (
    <div
      className="space-y-3 text-s fg-secondary"
      data-testid="publisher-skill-provenance"
    >
      <p>License: {publisher.license ?? 'See source for license terms'}</p>
      <a
        href={publisher.sourceUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="fg-accent hover:underline"
      >
        View source
      </a>
    </div>
  );
}
