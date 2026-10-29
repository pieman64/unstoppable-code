function errorDetails(error) {
  return error instanceof Error
    ? (error.stack ?? error.message)
    : String(error);
}

/** Preserve an attempted replay even when its foreground admission fails before capture. */
export function failedDiagnosticReplay(error) {
  return diagnosticReplayOutcome({
    ...error?.performanceDetails,
    status: 'error',
    error: errorDetails(error),
  });
}

export function diagnosticReplayError(diagnostics) {
  if (!diagnostics) return 'unknown error';
  if (diagnostics.replay?.status === 'error') {
    return diagnostics.replay.error ?? 'unknown error';
  }
  if (diagnostics.status === 'error') {
    return diagnostics.error ?? 'unknown error';
  }
  return undefined;
}

/** Capture success and scenario outcome are independent; retain all available evidence. */
export function diagnosticReplayOutcome(result) {
  const { diagnostics, ...replay } = result;
  return { ...(diagnostics ?? { status: 'not-started' }), replay };
}
