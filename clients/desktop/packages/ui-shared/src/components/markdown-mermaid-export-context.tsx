'use client';

import {
  createContext,
  useContext,
  useMemo,
  type JSX,
  type ReactNode,
} from 'react';

/**
 * One clipboard item: a PNG and HTML embedding the sanitized SVG as a data
 * URL. Both are promises so the write can begin inside the user's gesture
 * while the image is still being prepared.
 */
export interface MermaidClipboardImage {
  readonly png: Promise<Blob>;
  readonly html: Promise<Blob>;
}

export type MermaidImageClipboard =
  | {
      readonly status: 'available';
      /** Starts the write synchronously; rejects on denial or failure. */
      readonly write: (
        image: MermaidClipboardImage,
        ownerDocument: Document,
      ) => Promise<void>;
    }
  | { readonly status: 'unavailable'; readonly reason: string };

export type MermaidExportFormat = 'png' | 'svg';

export interface MermaidSiblingSaveRequest {
  readonly filename: string;
  readonly format: MermaidExportFormat;
  readonly body: Blob;
}

/**
 * The host's answer to one create-only attempt. Only `conflict` lets the
 * caller try the next name; every other failure must be thrown.
 */
export type MermaidSiblingSaveResult =
  | {
      readonly status: 'saved';
      /** The name the host actually created. */
      readonly filename: string;
      /** Opens the saved file with the preview host's own opener. */
      readonly open: () => void;
    }
  | { readonly status: 'conflict' };

export type MermaidSaveDestination =
  | {
      readonly kind: 'download';
      /** Stable source-document identity, including workspace and path when applicable. */
      readonly documentId?: string;
      /** Prefixes download names when the diagram belongs to a document. */
      readonly documentName?: string;
    }
  | {
      readonly kind: 'sibling';
      readonly documentId?: string;
      readonly documentName: string;
      /** Formats the host creates atomically beside the document. */
      readonly formats: Readonly<Record<MermaidExportFormat, boolean>>;
      readonly save: (
        request: MermaidSiblingSaveRequest,
      ) => Promise<MermaidSiblingSaveResult>;
    };

/**
 * Feedback for one finished export, raised in the host's toast stack so the
 * diagram's own layout never moves.
 */
export interface MermaidExportToast {
  readonly tone: 'success' | 'error';
  readonly message: string;
  /** A follow-up the toast offers, such as opening a saved file. */
  readonly action?: { readonly label: string; readonly run: () => void };
  /**
   * The message names a file taken from document text, so a host with
   * session replay blocks it. Hosts without replay ignore it.
   */
  readonly blockMessageFromReplay?: boolean;
}

/** Posts a diagram export toast in the host's toast system. */
export type MermaidExportNotify = (toast: MermaidExportToast) => void;

export interface MermaidExportServices {
  readonly clipboard: MermaidImageClipboard;
  readonly destination: MermaidSaveDestination;
  /** Absent outside a host toast stack; results are then announced only. */
  readonly notify?: MermaidExportNotify;
}

export const MERMAID_IMAGE_CLIPBOARD_UNAVAILABLE =
  'Copying images isn’t available here.';

const DEFAULT_SERVICES: MermaidExportServices = {
  clipboard: {
    status: 'unavailable',
    reason: MERMAID_IMAGE_CLIPBOARD_UNAVAILABLE,
  },
  destination: { kind: 'download' },
};

const MermaidExportContext =
  createContext<MermaidExportServices>(DEFAULT_SERVICES);

/**
 * Supplies diagram export services. Omitted members inherit from the nearest
 * enclosing provider, so a file preview can replace the destination while
 * keeping the host's clipboard, and a host can add its toast stack lower down.
 */
export function MermaidExportProvider({
  clipboard,
  destination,
  notify,
  children,
}: {
  readonly clipboard?: MermaidImageClipboard;
  readonly destination?: MermaidSaveDestination;
  readonly notify?: MermaidExportNotify;
  readonly children: ReactNode;
}): JSX.Element {
  const inherited = useContext(MermaidExportContext);
  const resolvedClipboard = clipboard ?? inherited.clipboard;
  const resolvedDestination = destination ?? inherited.destination;
  const resolvedNotify = notify ?? inherited.notify;
  const value = useMemo(
    (): MermaidExportServices => ({
      clipboard: resolvedClipboard,
      destination: resolvedDestination,
      ...(resolvedNotify ? { notify: resolvedNotify } : {}),
    }),
    [resolvedClipboard, resolvedDestination, resolvedNotify],
  );
  return (
    <MermaidExportContext.Provider value={value}>
      {children}
    </MermaidExportContext.Provider>
  );
}

export function useMermaidExport(): MermaidExportServices {
  return useContext(MermaidExportContext);
}
