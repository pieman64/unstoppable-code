export function performanceScenarioStatus(_counters, responsiveness) {
  return responsiveness.passed ? 'ok' : 'unresponsive';
}

export function shouldRunPerformanceDiagnostics(mode, scenario) {
  if (mode === 'off') return false;
  return (
    mode === 'always' ||
    scenario.status === 'error' ||
    scenario.status === 'unresponsive' ||
    (scenario.status === 'diagnostic' &&
      scenario.responsiveness?.passed === false)
  );
}
