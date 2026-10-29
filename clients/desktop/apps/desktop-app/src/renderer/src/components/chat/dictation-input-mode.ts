export function shouldMarkFinalTranscriptAsVoiceInput(
  transcribed: string,
): boolean {
  return transcribed.trim().length > 0;
}
