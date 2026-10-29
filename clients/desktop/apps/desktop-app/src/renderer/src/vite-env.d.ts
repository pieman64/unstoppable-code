/// <reference types="vite/client" />

export {};

declare global {
  interface ImportMeta {
    hot?: {
      dispose: (callback: () => void) => void;
    };
  }

  var MonacoEnvironment:
    | {
        getWorker: (_workerId: string, label: string) => Worker;
      }
    | undefined;
}
