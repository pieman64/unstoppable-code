/**
 * @jest-environment jsdom
 *
 * `reportRendererConsoleError` diagnostic fidelity.
 *
 * Electron's renderer console-message capture stringifies every argument after
 * the first, so a structured `details` object passed as a second argument
 * landed in `app-events` as the literal text `[object Object]`. The fields that
 * exist specifically to triage an incident never arrived. These tests pin the
 * single-argument contract that keeps them.
 */
import { reportRendererConsoleError } from '../renderer-error-logging';

describe('reportRendererConsoleError', () => {
  let calls: unknown[][];
  let consoleError: jest.SpyInstance<void, unknown[]>;

  beforeEach(() => {
    calls = [];
    consoleError = jest
      .spyOn(console, 'error')
      .mockImplementation((...args: unknown[]): void => {
        calls.push(args);
      });
  });

  afterEach(() => {
    consoleError.mockRestore();
  });

  function loggedLine(): string {
    expect(calls).toHaveLength(1);
    const call = calls[0] ?? [];
    // One argument only: a second one is exactly what Electron flattens.
    expect(call).toHaveLength(1);
    const line = call[0];
    expect(typeof line).toBe('string');
    return String(line);
  }

  it('logs the bare message when there are no details', () => {
    reportRendererConsoleError('Something went wrong');

    expect(loggedLine()).toBe('[renderer] Something went wrong');
  });

  it('serializes details into the message string', () => {
    reportRendererConsoleError('Shared-container listing failed', {
      attempted: 2,
      rejected: 2,
      reason: 'CanopyCloudClientError',
    });

    const line = loggedLine();
    expect(line).toContain('[renderer] Shared-container listing failed');
    expect(line).toContain('"attempted":2');
    expect(line).toContain('"rejected":2');
    expect(line).toContain('"reason":"CanopyCloudClientError"');
    expect(line).not.toContain('[object Object]');
  });

  it('expands a nested Error rather than flattening it to {}', () => {
    reportRendererConsoleError('Chart error boundary caught an error', {
      error: new TypeError('boom'),
    });

    const line = loggedLine();
    expect(line).toContain('"name":"TypeError"');
    expect(line).toContain('"message":"boom"');
  });

  it('survives a circular details payload', () => {
    const circular: Record<string, unknown> = { id: 'c1' };
    circular.self = circular;

    reportRendererConsoleError('Circular payload', { circular });

    const line = loggedLine();
    expect(line).toContain('[renderer] Circular payload');
    expect(line).not.toBe('[renderer] Circular payload');
  });
});
