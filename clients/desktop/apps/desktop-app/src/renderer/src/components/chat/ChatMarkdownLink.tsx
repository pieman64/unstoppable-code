import {
  useContext,
  useEffect,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type JSX,
} from 'react';
import { parseFileLinkLineSuffix } from '@canopy/ui-shared/lib/file-link-line-suffix';
import { useChatStore } from '@/stores/chatStore';
import { useAgentFilePresentationStore } from '@/stores/agentFilePresentationStore';
import { requestFilePanelPlacementBesideChat } from '@/lib/panels/chat-panel-sync';
import { initialFileTabViewMode } from '@/lib/file-viewer/initial-view-mode';
import {
  isBrowserRenderedFile,
  openFileInBrowserPanel,
} from '@/lib/openFileInBrowserPanel';
import { ChatMarkdownFileTargetContext } from './chat-markdown-file-target';

interface ChatMarkdownLinkProps extends ComponentPropsWithoutRef<'a'> {
  originChatTabId?: string;
}

export function ChatMarkdownLink({
  href,
  children,
  originChatTabId,
}: ChatMarkdownLinkProps): JSX.Element {
  const target = useContext(ChatMarkdownFileTargetContext);
  const [error, setError] = useState(false);
  const [opening, setOpening] = useState(false);
  const openRequestRef = useRef(0);
  useEffect(() => {
    setOpening(false);
    setError(false);
    return (): void => {
      openRequestRef.current += 1;
    };
  }, [href, target?.projectId, target?.worktreeId, originChatTabId]);
  if (typeof href !== 'string') return <span>{children}</span>;
  if (/^(https?:|mailto:)/i.test(href))
    return (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    );
  const { href: fileHref, location } = parseFileLinkLineSuffix(href);
  const isDrivePath = /^[a-zA-Z]:[\\/]/.test(fileHref);
  const slashlessLineLink =
    location !== null &&
    !fileHref.includes(':') &&
    !/^[a-z][a-z0-9+-]*$/i.test(fileHref);
  // Local file links resolve through the scope's file roots, so they stay
  // active in read-only scopes too (the shared-container recipient opens the
  // replica file beside the chat). Remote images are governed separately by
  // `allowRemoteImages` in the block renderer, not by this link gate.
  if (
    !target ||
    !href ||
    href.startsWith('#') ||
    /^[\\/]{2}/.test(href) ||
    href.split('').some((character) => character.charCodeAt(0) < 32) ||
    (!isDrivePath &&
      !slashlessLineLink &&
      /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(href))
  )
    return <span>{children}</span>;

  const open = async (): Promise<void> => {
    const requestRevision = ++openRequestRef.current;
    const isMountedRequest = (): boolean =>
      requestRevision === openRequestRef.current;
    const isLatestTranscriptOpen = useAgentFilePresentationStore
      .getState()
      .beginTranscriptOpen(target, originChatTabId);
    const isCurrent = (): boolean =>
      isMountedRequest() && isLatestTranscriptOpen();
    setOpening(true);
    setError(false);
    try {
      // URL resolution otherwise mistakes a Windows drive for a URI scheme.
      const resolverHref = /^[a-zA-Z]:[\\/]/.test(fileHref)
        ? `/${fileHref.replace(/\\/g, '/')}`
        : fileHref;
      const absolute =
        /^\/(?!\/)/.test(fileHref) || /^[a-zA-Z]:[\\/]/.test(fileHref);
      const roots = absolute
        ? []
        : (await window.api.getFileTreeRoots(target)).roots;
      if (!isCurrent()) return;
      // A relative path in a multi-repo workspace must resolve unambiguously.
      const bases = absolute
        ? [fileHref]
        : roots.map((root) => `${root.absolutePath}/.chat-link`);
      const matches = await Promise.all(
        bases.map((baseFilePath) =>
          window.api.resolveFileReference({
            ...target,
            baseFilePath,
            href: resolverHref,
          }),
        ),
      );
      if (!isCurrent()) return;
      const unique = new Map(
        matches
          .filter((value) => value !== null)
          .map((value) => [value.absolutePath, value]),
      );
      if (unique.size !== 1)
        throw new Error('File target is unavailable or ambiguous');
      const resolved = Array.from(unique.values())[0];
      // A linked page opens rendered in the browser beside the chat. A link
      // to one of its lines is about the source, so that keeps the viewer.
      if (location === null && isBrowserRenderedFile(resolved.filename)) {
        const browserId = await openFileInBrowserPanel(
          target.projectId,
          target.worktreeId,
          resolved.absolutePath,
          originChatTabId ? { originChatTabId } : {},
        );
        if (browserId === null) throw new Error('Browser unavailable');
        return;
      }
      // A link in chat points at something to read: a file type with a
      // rendered view opens rendered, unless it is already open elsewhere.
      const tabId = useChatStore.getState().openFileTab(
        {
          ...resolved,
          initialViewMode: initialFileTabViewMode(resolved.filename),
        },
        target,
      );
      if (!tabId) throw new Error('File panel unavailable');
      useAgentFilePresentationStore.getState().present(tabId, location ?? {});
      if (originChatTabId)
        requestFilePanelPlacementBesideChat(tabId, originChatTabId);
    } catch {
      if (isCurrent()) setError(true);
    } finally {
      // A superseded link remains mounted and can be tried again.
      if (isMountedRequest()) setOpening(false);
    }
  };
  return (
    <>
      <button
        type="button"
        data-testid="chat-local-file-link"
        className="focus-ring cursor-pointer fg-accent underline decoration-accent/40 underline-offset-2 hover:decoration-accent"
        disabled={opening}
        title={href}
        data-file-link-line={
          location
            ? `${location.line}${location.lineEnd !== undefined ? `-${location.lineEnd}` : ''}`
            : undefined
        }
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          void open();
        }}
      >
        {children}
      </button>
      {error && (
        <span role="status" className="ml-2 text-xs fg-secondary">
          Couldn't open file
        </span>
      )}
    </>
  );
}
