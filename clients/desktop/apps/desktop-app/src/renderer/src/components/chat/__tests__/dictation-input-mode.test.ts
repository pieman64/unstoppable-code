import { shouldMarkFinalTranscriptAsVoiceInput } from '../dictation-input-mode';

describe('shouldMarkFinalTranscriptAsVoiceInput', () => {
  it('returns false for an empty final transcript', () => {
    expect(shouldMarkFinalTranscriptAsVoiceInput('')).toBe(false);
    expect(shouldMarkFinalTranscriptAsVoiceInput('   ')).toBe(false);
  });

  it('returns true when dictation produced spoken text', () => {
    expect(shouldMarkFinalTranscriptAsVoiceInput('hello world')).toBe(true);
  });
});
