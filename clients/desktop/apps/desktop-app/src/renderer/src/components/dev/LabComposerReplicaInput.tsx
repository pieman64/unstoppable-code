import type { InputHTMLAttributes, JSX } from 'react';

/**
 * The question forms lab's static stand-in for the compact chat composer's
 * editor: a borderless one-line input styled like the composer text. The
 * composer owns its own editor, so this replica is listed as an exception in
 * the legacy field ratchet rather than drawn with a form field.
 */
export function LabComposerReplicaInput(
  props: Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> & {
    readonly 'aria-label': string;
  },
): JSX.Element {
  return <input type="text" {...props} />;
}
