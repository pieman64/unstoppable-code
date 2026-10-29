'use client';

import {
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type JSX,
} from 'react';
import { REPLAY_BLOCK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import { PreviewSearchContext } from './FilePreviewSearch';
import { buildSearchableHtmlSrcDoc } from './html-preview-search';

import {
  HTML_FILE_PREVIEW_CSP,
  buildSandboxedHtmlSrcDoc,
} from '@canopy/ui-shared/lib/sandboxed-html';

export { HTML_FILE_PREVIEW_CSP, buildSandboxedHtmlSrcDoc };

/**
 * Sandboxed read-only preview for `.html` files — a direct port of the desktop
 * `HtmlFilePreview`.
 *
 * The sandbox and injected CSP block file scripts, network access, navigation,
 * forms, nested frames, workers, and plugins. Omitting `allow-same-origin`
 * keeps the frame at an opaque origin.
 */
export interface FileHtmlPreviewProps {
  readonly content: string;
  /** Accessible title for the frame (usually the file name). */
  readonly title: string;
  /** Host-authorized relative images, returned as image data URLs. */
  readonly resolveAssetSrc?: (
    src: string,
  ) => string | Promise<string | null> | null;
  /** Resolve an authorized identity before reading bytes, so aliases share a read. */
  readonly resolveHtmlAsset?: (src: string) => Promise<{
    readonly identity: string;
    readonly read: () => Promise<string | null>;
  } | null>;
}

type AssetResolver = NonNullable<FileHtmlPreviewProps['resolveAssetSrc']>;
type HtmlAssetResolver = NonNullable<FileHtmlPreviewProps['resolveHtmlAsset']>;
const MAX_EMBEDDED_IMAGES = 64;
// Count encoded data URL bytes, including each copy in the serialized HTML.
const MAX_EMBEDDED_IMAGE_BYTES = 16 * 1024 * 1024;

function relativeImageSource(source: string): boolean {
  return (
    source.length > 0 &&
    !/^(?:[a-z][a-z\d+.-]*:|[/\\#])/i.test(source) &&
    !Array.from(source).some((character) => character.charCodeAt(0) < 32)
  );
}

async function embedRelativeImages(
  content: string,
  resolveAssetSrc: AssetResolver | undefined,
  resolveHtmlAsset: HtmlAssetResolver | undefined,
  cancelled: () => boolean,
): Promise<string> {
  // Parse with the restrictive CSP already in place. Use authored attributes,
  // never DOM-resolved URLs or an authored <base>, for host authorization.
  const document = new DOMParser().parseFromString(
    buildSandboxedHtmlSrcDoc(content),
    'text/html',
  );
  const images: Array<{ image: HTMLImageElement; source: string }> = [];
  for (const image of document.images) {
    const source = image.getAttribute('src')?.trim() ?? '';
    if (relativeImageSource(source)) images.push({ image, source });
    if (images.length === MAX_EMBEDDED_IMAGES) break;
  }
  if (images.length === 0) return content;
  const sources = [...new Set(images.map(({ source }) => source))];
  const resolved = new Map<string, string>();
  const reads = new Map<string, Promise<string | null>>();
  let retainedBytes = 0;
  let budgetExhausted = false;
  const readAsset = (
    asset: Awaited<ReturnType<HtmlAssetResolver>>,
  ): Promise<string | null> => {
    if (!asset || cancelled()) return Promise.resolve(null);
    const existing = reads.get(asset.identity);
    if (existing) return existing;
    if (budgetExhausted) return Promise.resolve(null);
    const pending = (async (): Promise<string | null> => {
      try {
        const result = await asset.read();
        if (
          cancelled() ||
          !result ||
          !/^data:image\/[a-z\d.+-]+;base64,/i.test(result)
        )
          return null;
        if (retainedBytes + result.length > MAX_EMBEDDED_IMAGE_BYTES) {
          budgetExhausted = true;
          return null;
        }
        retainedBytes += result.length;
        return result;
      } catch {
        return null;
      }
    })();
    reads.set(asset.identity, pending);
    return pending;
  };
  let next = 0;
  // Bound concurrent IPC/file reads, and resolve repeated gallery images once.
  await Promise.all(
    Array.from({ length: Math.min(4, sources.length) }, async () => {
      while (!cancelled() && !budgetExhausted && next < sources.length) {
        const source = sources[next++];
        try {
          // The shared host resolver also understands Markdown repo prefixes.
          // HTML sources always use document-relative URL semantics.
          const relativeSource = source.startsWith('.')
            ? source
            : `./${source}`;
          const asset = resolveHtmlAsset
            ? await resolveHtmlAsset(relativeSource)
            : {
                identity: source,
                read: (): Promise<string | null> =>
                  Promise.resolve(resolveAssetSrc?.(relativeSource) ?? null),
              };
          const result = await readAsset(asset);
          if (result && !cancelled()) resolved.set(source, result);
        } catch {
          // A missing or disallowed asset leaves the passive preview available.
        }
      }
    }),
  );
  let embeddedBytes = 0;
  for (const { image, source } of images) {
    const result = resolved.get(source);
    if (!result || embeddedBytes + result.length > MAX_EMBEDDED_IMAGE_BYTES)
      continue;
    embeddedBytes += result.length;
    image.setAttribute('src', result);
    // Responsive candidates would override the authorized fallback with URLs
    // the opaque frame cannot read. Keep its local fallback for this preview.
    image.removeAttribute('srcset');
    if (image.parentElement?.tagName === 'PICTURE') {
      for (const source of image.parentElement.querySelectorAll('source'))
        source.removeAttribute('srcset');
    }
  }
  document.querySelectorAll('base').forEach((base) => base.remove());
  return `<!doctype html>\n${document.documentElement.outerHTML}`;
}

function FileHtmlPreviewImpl({
  content,
  title,
  resolveAssetSrc,
  resolveHtmlAsset,
}: FileHtmlPreviewProps): JSX.Element {
  const search = useContext(PreviewSearchContext);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const searchable = search !== null;
  const [assets, setAssets] = useState<{
    content: string;
    resolver: AssetResolver | undefined;
    htmlResolver: HtmlAssetResolver | undefined;
    html: string;
  } | null>(null);
  useEffect(() => {
    if (
      (!resolveAssetSrc && !resolveHtmlAsset) ||
      typeof DOMParser === 'undefined'
    )
      return;
    let cancelled = false;
    void embedRelativeImages(
      content,
      resolveAssetSrc,
      resolveHtmlAsset,
      () => cancelled,
    )
      .then((html) => {
        if (!cancelled)
          setAssets({
            content,
            resolver: resolveAssetSrc,
            htmlResolver: resolveHtmlAsset,
            html,
          });
      })
      .catch(() => undefined);
    return (): void => {
      cancelled = true;
    };
  }, [content, resolveAssetSrc, resolveHtmlAsset]);
  const previewContent =
    assets?.content === content &&
    assets.resolver === resolveAssetSrc &&
    assets.htmlResolver === resolveHtmlAsset
      ? assets.html
      : content;
  const previewDocument = useMemo((): {
    srcDoc: string;
    bridgeToken: string | null;
    frameKey: string;
  } => {
    const frameKey = crypto.randomUUID();
    if (searchable && typeof DOMParser !== 'undefined') {
      const bridgeToken = frameKey;
      return {
        srcDoc: buildSearchableHtmlSrcDoc(previewContent, bridgeToken),
        bridgeToken,
        frameKey,
      };
    }
    return {
      srcDoc: buildSandboxedHtmlSrcDoc(previewContent),
      bridgeToken: null,
      frameKey,
    };
  }, [previewContent, searchable]);
  const { srcDoc, bridgeToken } = previewDocument;
  const latestSearch = useRef(search);
  const trustedBridgeToken = useRef<string | null>(null);
  latestSearch.current = search;
  const postSearch = useCallback((): void => {
    if (!bridgeToken || trustedBridgeToken.current !== bridgeToken) return;
    const current = latestSearch.current;
    if (current)
      frameRef.current?.contentWindow?.postMessage(
        {
          type: 'preview-search-query',
          query: current.query,
          index: current.index,
          highlightColor: frameRef.current
            ? getComputedStyle(frameRef.current)
                .getPropertyValue('--fg-warning')
                .trim()
            : '',
        },
        '*',
      );
  }, [bridgeToken]);
  useEffect(() => {
    if (!searchable) return;
    const receive = (event: MessageEvent<unknown>): void => {
      if (event.source !== frameRef.current?.contentWindow) return;
      const data = event.data;
      if (!data || typeof data !== 'object' || !('type' in data)) return;
      if (!('bridgeToken' in data) || data.bridgeToken !== bridgeToken) return;
      if (data.type === 'preview-search-ready') {
        trustedBridgeToken.current = bridgeToken;
        postSearch();
      } else if (data.type === 'preview-search-unloading') {
        trustedBridgeToken.current = null;
      } else if (data.type === 'preview-search-open')
        latestSearch.current?.open();
      else if (data.type === 'preview-search-close')
        latestSearch.current?.close();
      else if (
        data.type === 'preview-search-result' &&
        'query' in data &&
        typeof data.query === 'string' &&
        'count' in data &&
        typeof data.count === 'number' &&
        Number.isSafeInteger(data.count) &&
        data.count >= 0
      )
        latestSearch.current?.report(data.query, data.count);
    };
    window.addEventListener('message', receive);
    return (): void => window.removeEventListener('message', receive);
  }, [bridgeToken, postSearch, searchable]);
  useEffect(() => {
    if (!searchable) return;
    const timer = window.setTimeout(postSearch, 150);
    return (): void => window.clearTimeout(timer);
  }, [postSearch, searchable, search?.query, search?.index]);
  return (
    <iframe
      // Replace the browsing context when async assets produce a new document.
      // Updating srcdoc in place can leave Chromium's opaque frame unpainted.
      key={previewDocument.frameKey}
      ref={frameRef}
      title={title}
      srcDoc={srcDoc}
      // Search grants execution only to the nonce-bearing app bridge. The
      // frame remains opaque and file-authored scripts are blocked by CSP.
      sandbox={searchable ? 'allow-scripts' : ''}
      referrerPolicy="no-referrer"
      // File content: session replay keeps a same-size placeholder.
      className={`${REPLAY_BLOCK_CLASS} min-h-0 flex-1 border-0 bg-white`}
      data-testid="html-file-preview-frame"
    />
  );
}

export const FileHtmlPreview = memo(FileHtmlPreviewImpl);
