export function shouldSubscribeResourceMonitor(
  preferencesLoaded: boolean,
  showDiagnosticsPill: boolean,
): boolean {
  return preferencesLoaded && showDiagnosticsPill;
}
