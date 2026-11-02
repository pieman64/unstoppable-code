/**
 * The launcher channel a code-graph host serves, shaped like Electron's
 * `ParentPort`: messages arrive as `{ data }`. Each host entry supplies its
 * process's channel, so the engine package stays free of process hosting.
 */
export interface CodeGraphHostChannel {
  postMessage(message: unknown): void;
  on(event: 'message', listener: (event: { data: unknown }) => void): unknown;
  once(event: 'message', listener: (event: { data: unknown }) => void): unknown;
  /** Exits once every message posted before it has been written. */
  exit(code: number): void;
}
