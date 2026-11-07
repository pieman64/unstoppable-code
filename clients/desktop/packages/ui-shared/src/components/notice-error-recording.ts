import { useEffect, useRef, type RefObject } from 'react';
import { recordSurfacedError } from '../lib/surfaced-error-port';
import { REPLAY_BLOCK_CLASS, REPLAY_MASK_CLASS } from '../lib/replay-privacy';

/** Which shared surface a destructive notice reports as. */
export type NoticeErrorChokePoint = 'notice' | 'banner';

/**
 * Audited `data-testid` values that may name a surfaced error's source: each
 * is a literal on a destructive notice or banner, never built from a template
 * or user data. Anything else records the bare choke point; do not grow this
 * list just to improve coverage.
 */
const TRUSTED_NOTICE_IDENTIFIERS: ReadonlySet<string> = new Set([
  'add-workspace-error',
  'automations-mutation-error',
  'automations-panel-load-error',
  'chat-add-workspace-error',
  'chat-state-refresh-error',
  'chat-transcript-error',
  'cloud-chat-history-error',
  'feedback-modal-error',
  'file-viewer-download-error',
  'files-tree-mutation-error',
  'harness-save-error',
  'legal-consent-error',
  'mcp-management-error',
  'mcp-servers-card-error',
  'pipeline-editor-save-error',
  'pipeline-execution-panel-load-error',
  'pipeline-run-detail-error',
  'plugins-load-error',
  'portal-chat-send-error',
  'portal-new-task-create-error',
  'project-settings-error',
  'remote-access-pair-error',
  'settings-data-dir-error',
  'settings-mcp-error',
  'workflows-runs-error',
]);

const REPLAY_HIDDEN_SELECTOR = `.${REPLAY_BLOCK_CLASS}, .${REPLAY_MASK_CLASS}`;

/** The nearest audited test ID, from the notice root through its ancestors. */
function trustedIdentifier(root: Element): string | undefined {
  for (let node: Element | null = root; node; node = node.parentElement) {
    const id = node.getAttribute('data-testid');
    if (id !== null && TRUSTED_NOTICE_IDENTIFIERS.has(id)) return id;
  }
  return undefined;
}

function recordSighting(
  copy: Element,
  chokePoint: NoticeErrorChokePoint,
): void {
  const root = copy.closest('[data-notice-intent]') ?? copy;
  const identifier = trustedIdentifier(root);
  recordSurfacedError({
    chokePoint,
    surface: chokePoint === 'banner' ? 'banner' : 'inline',
    ...(identifier === undefined ? {} : { identifier }),
    // Committed text, so a component child counts as what the user read.
    text: copy.textContent ?? '',
    // Text hidden from replay is not cleared for export by being on screen.
    textIsSensitive:
      copy.closest(REPLAY_HIDDEN_SELECTOR) !== null ||
      copy.querySelector(REPLAY_HIDDEN_SELECTOR) !== null,
  });
}

/**
 * Records a sighting of a notice's error after commit, returning the ref for
 * its copy element. `textKey` is what re-sights it: an update inside a child
 * component that the parent's text cannot see is not a new sighting.
 */
export function useNoticeErrorRecording(
  enabled: boolean,
  chokePoint: NoticeErrorChokePoint,
  textKey: string,
): RefObject<HTMLDivElement | null> {
  const copyRef = useRef<HTMLDivElement>(null);
  const lastSighting = useRef<string | null>(null);
  useEffect(() => {
    const copy = copyRef.current;
    if (!enabled || !copy) {
      lastSighting.current = null;
      return;
    }
    // StrictMode replays this effect with the same values and the same ref.
    const sighting = `${chokePoint}\u0000${textKey}`;
    if (lastSighting.current === sighting) return;
    lastSighting.current = sighting;
    recordSighting(copy, chokePoint);
  }, [enabled, chokePoint, textKey]);
  return copyRef;
}
