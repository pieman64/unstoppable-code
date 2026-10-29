/**
 * What this launch did with the "Open windows faster" experiment, for the
 * Settings row: whether the windows load over the renderer scheme, whether
 * the launch fell back to `file://` and turned the setting off, and whether
 * it could not copy storage back to `file://` and so turned the setting
 * back on. Main's startup registers the source; preferences IPC reads it.
 */
export interface RendererCodeCacheSchemeStatus {
  active: boolean;
  fellBack: boolean;
  switchBackFailed: boolean;
}

type StatusSource = () => RendererCodeCacheSchemeStatus;

let source: StatusSource | null = null;

export function setRendererCodeCacheSchemeStatusSource(
  next: StatusSource | null,
): void {
  source = next;
}

export function getRendererCodeCacheSchemeStatus(): RendererCodeCacheSchemeStatus {
  return (
    source?.() ?? { active: false, fellBack: false, switchBackFailed: false }
  );
}
