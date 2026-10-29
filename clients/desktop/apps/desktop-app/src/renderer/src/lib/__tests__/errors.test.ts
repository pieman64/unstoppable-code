import { extractIpcErrorMessage } from '../errors';

describe('extractIpcErrorMessage', () => {
  it('returns the verbatim message for an Error instance', () => {
    const guardText =
      'Canopy is already running 4 chat turns. Wait for one to finish before starting another.';
    expect(extractIpcErrorMessage(new Error(guardText))).toBe(guardText);
  });

  it('returns a plain string input verbatim', () => {
    const guardText =
      'Canopy is under high memory pressure. Stop an active chat or pipeline execution before starting another pipeline.';
    expect(extractIpcErrorMessage(guardText)).toBe(guardText);
  });

  it('returns a stable fallback for unknown inputs', () => {
    expect(extractIpcErrorMessage(undefined)).toBe('Unknown error');
    expect(extractIpcErrorMessage(null)).toBe('Unknown error');
    expect(extractIpcErrorMessage(42)).toBe('Unknown error');
    expect(extractIpcErrorMessage({ foo: 'bar' })).toBe('Unknown error');
  });

  it('does not prefix the message with "Error:" or wrap it', () => {
    const guardText =
      'Canopy is under high memory pressure. Wait for active work to finish before starting another chat.';
    const message = extractIpcErrorMessage(new Error(guardText));
    expect(message.startsWith('Error:')).toBe(false);
    expect(message).toBe(guardText);
  });

  it('falls back when an Error has an empty message', () => {
    expect(extractIpcErrorMessage(new Error(''))).toBe('Unknown error');
  });

  it('strips the Electron IPC wrapper and class-name prefix', () => {
    const wrapped = new Error(
      "Error invoking remote method 'chat:send-message': ResourceGuardError: Canopy is under high memory pressure. Wait for active work to finish before starting another chat.",
    );
    expect(extractIpcErrorMessage(wrapped)).toBe(
      'Canopy is under high memory pressure. Wait for active work to finish before starting another chat.',
    );
  });

  it('strips the Electron IPC wrapper and plain Error prefix', () => {
    const wrapped = new Error(
      "Error invoking remote method 'chat:session-export': Error: Export canceled",
    );
    expect(extractIpcErrorMessage(wrapped)).toBe('Export canceled');
  });

  it('strips the IPC wrapper even without a class-name prefix', () => {
    const wrapped = new Error("Error invoking remote method 'foo:bar': boom");
    expect(extractIpcErrorMessage(wrapped)).toBe('boom');
  });

  it('strips the IPC wrapper and a plain Error prefix', () => {
    const wrapped = new Error(
      "Error invoking remote method 'file:save-content': Error: File changed on disk since it was loaded.",
    );
    expect(extractIpcErrorMessage(wrapped)).toBe(
      'File changed on disk since it was loaded.',
    );
  });

  it('strips a bare class-name prefix from a thrown error message', () => {
    const wrapped = new Error('ResourceGuardError: limit reached');
    expect(extractIpcErrorMessage(wrapped)).toBe('limit reached');
  });

  it('falls back when the wrapper is the only content', () => {
    const wrapped = new Error("Error invoking remote method 'x:y': ");
    expect(extractIpcErrorMessage(wrapped)).toBe('Unknown error');
  });
});
