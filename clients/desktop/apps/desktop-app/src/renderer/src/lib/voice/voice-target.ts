/**
 * Adapter for inserting a finished transcript into an editor surface. One
 * implementation exists today (Slate chat editor). Future phases can add a
 * plain-textarea adapter without touching the provider or hook layers.
 *
 * The target never sees interim transcripts: the hook buffers them while the
 * take records, so keyboard edits made during recording are never touched.
 */
export interface VoiceTarget {
  /**
   * Insert one take's transcript at the current cursor, once, after the take
   * has finished. Blank text leaves the editor unchanged.
   */
  commitFinal(text: string): void;
}
