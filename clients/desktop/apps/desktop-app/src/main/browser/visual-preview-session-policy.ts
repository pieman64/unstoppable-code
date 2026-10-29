import { session, type Session } from 'electron';
import { AGENT_VISUAL_CDN_HOSTS } from '@canopy/ui-shared/lib/agent-visual-html';
import { VISUAL_PREVIEW_LIMITS } from './visual-preview-types';

const ALLOWED_ORIGINS: ReadonlySet<string> = new Set(AGENT_VISUAL_CDN_HOSTS);

export function isAllowedVisualPreviewRequest(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      ALLOWED_ORIGINS.has(url.origin) &&
      // URL canonicalizes a trailing dot and uppercase hostname. Reject both
      // non-canonical spellings instead of broadening the trusted host list.
      url.host === new URL(url.origin).host &&
      !value.slice('https://'.length).split('/')[0]?.endsWith('.')
    );
  } catch {
    return false;
  }
}

function safeBlockedUrl(value: string): string {
  try {
    const url = new URL(value);
    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';
    return url.href.slice(0, VISUAL_PREVIEW_LIMITS.diagnostics.chars);
  } catch {
    return '[invalid URL]';
  }
}

export interface VisualPreviewBlockedRequests {
  readonly urls: string[];
  omitted: number;
}

/** Sole, permanent request-policy owner of the non-persistent preview session. */
export class VisualPreviewSessionPolicy {
  readonly native: Session;
  private readonly runs = new Map<number, VisualPreviewBlockedRequests>();

  constructor(native: Session) {
    this.native = native;
    native.webRequest.onBeforeRequest((details, callback) => {
      const cancel = !isAllowedVisualPreviewRequest(details.url);
      if (cancel && details.webContentsId !== undefined) {
        const run = this.runs.get(details.webContentsId);
        if (run) {
          if (
            run.urls.length < VISUAL_PREVIEW_LIMITS.diagnostics.blockedRequests
          ) {
            run.urls.push(safeBlockedUrl(details.url));
          } else {
            run.omitted++;
          }
        }
      }
      callback({ cancel });
    });
    native.setPermissionRequestHandler((_contents, _permission, callback) => {
      callback(false);
    });
    native.setPermissionCheckHandler(() => false);
    native.setDevicePermissionHandler(() => false);
    native.on('will-download', (event) => event.preventDefault());
  }

  register(
    contentsId: number,
    blocked: VisualPreviewBlockedRequests,
  ): () => void {
    this.runs.set(contentsId, blocked);
    return () => {
      this.runs.delete(contentsId);
    };
  }
}

let policy: VisualPreviewSessionPolicy | undefined;

export function getVisualPreviewSessionPolicy(): VisualPreviewSessionPolicy {
  if (!policy)
    policy = new VisualPreviewSessionPolicy(
      session.fromPartition('visual-preview'),
    );
  return policy;
}
