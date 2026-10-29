'use client';

import {
  createContext,
  memo,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from 'react';
import type { PortalChatMessageAttachment } from '@canopy/protocol/portal';
import { FileAttachmentChip } from '@canopy/ui-shared/components';

/**
 * Host-owned behavior for the files a user attached to a message. ui-app stays
 * transport-neutral: the host decides how Open / Download / thumbnails resolve
 * (the web portal routes them through its cloud attachment endpoints).
 */
export interface ChatMessageAttachmentInteraction {
  readonly downloadContext?: object;
  readonly onOpen?: (attachment: PortalChatMessageAttachment) => void;
  readonly onDownload: (
    attachment: PortalChatMessageAttachment,
    signal?: AbortSignal,
  ) => Promise<void>;
  /** Host-renderable URL for an image attachment, or null for no thumbnail. */
  readonly imageSrc: (attachment: PortalChatMessageAttachment) => string | null;
  readonly resolveImage?: (
    reference: ChatAssetImageReference,
    signal: AbortSignal,
  ) => Promise<ChatAssetImageSource | null>;
  readonly onOpenImage?: (reference: ChatAssetImageReference) => void;
}

export interface ChatAssetImageReference {
  readonly assetId: string;
  readonly mediaType?: string;
  readonly filename?: string;
}

export interface ChatAssetImageSource {
  readonly src: string;
  readonly dispose?: () => void;
}

export function useChatAssetImage(reference: ChatAssetImageReference | null): {
  readonly src: string | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly retry: () => void;
} {
  const interaction = useChatMessageAttachmentInteraction();
  const resolve = interaction?.resolveImage;
  const assetId = reference?.assetId;
  const mediaType = reference?.mediaType;
  const filename = reference?.filename;
  const [generation, setGeneration] = useState(0);
  const [state, setState] = useState<{
    resolver: typeof resolve;
    assetId: string;
    mediaType: string | undefined;
    filename: string | undefined;
    generation: number;
    src: string | null;
    error: string | null;
  } | null>(null);
  useEffect(() => {
    if (!resolve || !assetId) return;
    const controller = new AbortController();
    let image: ChatAssetImageSource | null = null;
    void resolve(
      {
        assetId,
        ...(mediaType ? { mediaType } : {}),
        ...(filename ? { filename } : {}),
      },
      controller.signal,
    ).then(
      (result) => {
        if (controller.signal.aborted) {
          result?.dispose?.();
          return;
        }
        image = result;
        setState({
          resolver: resolve,
          assetId,
          mediaType,
          filename,
          generation,
          src: result?.src ?? null,
          error: null,
        });
      },
      (reason: unknown) => {
        if (!controller.signal.aborted)
          setState({
            resolver: resolve,
            assetId,
            mediaType,
            filename,
            generation,
            src: null,
            error:
              reason instanceof Error
                ? reason.message
                : 'Image is unavailable.',
          });
      },
    );
    return (): void => {
      controller.abort();
      image?.dispose?.();
    };
  }, [resolve, assetId, mediaType, filename, generation]);
  const visible =
    state?.resolver === resolve &&
    state?.assetId === assetId &&
    state?.mediaType === mediaType &&
    state?.filename === filename &&
    state?.generation === generation
      ? state
      : null;
  return {
    src: visible?.src ?? null,
    loading: Boolean(resolve && assetId && !visible),
    error: visible?.error ?? null,
    retry: () => setGeneration((value) => value + 1),
  };
}

export function ChatAssetImage({
  reference,
}: {
  readonly reference: ChatAssetImageReference;
}): JSX.Element {
  const image = useChatAssetImage(reference);
  const interaction = useChatMessageAttachmentInteraction();
  return (
    <div className="mt-1" data-testid="chat-asset-image">
      {image.src && (
        <button
          type="button"
          className="focus-ring rounded-md"
          disabled={!interaction?.onOpenImage}
          onClick={() => interaction?.onOpenImage?.(reference)}
        >
          <img
            src={image.src}
            alt={reference.filename ?? 'Tool image'}
            className="max-h-80 max-w-full rounded-md object-contain"
          />
        </button>
      )}
      {image.loading && (
        <span role="status" className="text-xs fg-secondary">
          Loading image from desktop…
        </span>
      )}
      {image.error && (
        <span role="alert" className="text-xs fg-secondary">
          {image.error}{' '}
          <button
            type="button"
            className="focus-ring fg-accent"
            onClick={image.retry}
          >
            Try again
          </button>
        </span>
      )}
    </div>
  );
}

const ChatMessageAttachmentInteractionContext =
  createContext<ChatMessageAttachmentInteraction | null>(null);

export function ChatMessageAttachmentInteractionProvider({
  value,
  children,
}: {
  value: ChatMessageAttachmentInteraction | null;
  children: ReactNode;
}): JSX.Element {
  return (
    <ChatMessageAttachmentInteractionContext.Provider value={value}>
      {children}
    </ChatMessageAttachmentInteractionContext.Provider>
  );
}

export function useChatMessageAttachmentInteraction(): ChatMessageAttachmentInteraction | null {
  return useContext(ChatMessageAttachmentInteractionContext);
}

export interface ChatMessageAttachmentsProps {
  readonly attachments: readonly PortalChatMessageAttachment[];
}

/**
 * The files attached to one user message, rendered as the desktop-parity
 * wrapping chip row: a file icon plus filename per attachment, with a small
 * thumbnail above image chips when the host can resolve one. With a host
 * interaction the chip opens the file and carries a Download control; without
 * one the chips are display-only.
 */
export const ChatMessageAttachments = memo(function ChatMessageAttachments({
  attachments,
}: ChatMessageAttachmentsProps): JSX.Element | null {
  const interaction = useChatMessageAttachmentInteraction();
  if (attachments.length === 0) return null;
  return (
    <div
      className="mt-1 flex flex-wrap items-end gap-1"
      data-testid="chat-message-attachments"
    >
      {attachments.map((attachment) => (
        <ChatMessageAttachmentChip
          key={attachment.attachmentId}
          attachment={attachment}
          interaction={interaction}
        />
      ))}
    </div>
  );
});

const ChatMessageAttachmentChip = memo(function ChatMessageAttachmentChip({
  attachment,
  interaction,
}: {
  attachment: PortalChatMessageAttachment;
  interaction: ChatMessageAttachmentInteraction | null;
}): JSX.Element {
  const downloadOwner = interaction?.downloadContext ?? interaction?.onDownload;
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const [downloadState, setDownloadState] = useState<{
    downloadOwner: typeof downloadOwner;
    assetId: string | undefined;
    attachmentId: string;
    downloading: boolean;
    error: string | null;
  } | null>(null);
  const downloadController = useRef<AbortController | null>(null);
  useLayoutEffect(
    () => (): void => {
      downloadController.current?.abort();
      downloadController.current = null;
    },
    [attachment.assetId, attachment.attachmentId, downloadOwner],
  );
  const currentDownload =
    downloadState?.downloadOwner === downloadOwner &&
    downloadState?.assetId === attachment.assetId &&
    downloadState?.attachmentId === attachment.attachmentId
      ? downloadState
      : null;
  const downloading = currentDownload?.downloading ?? false;
  const downloadError = currentDownload?.error ?? null;
  const { filename } = attachment;
  const image = useChatAssetImage(
    attachment.assetId
      ? {
          assetId: attachment.assetId,
          mediaType: attachment.mediaType,
          filename,
        }
      : null,
  );
  const src = interaction?.imageSrc(attachment) ?? image.src;
  const onOpen = interaction?.onOpen;
  const download = (): void => {
    if (interaction === null || downloading) return;
    const identity = {
      downloadOwner,
      assetId: attachment.assetId,
      attachmentId: attachment.attachmentId,
    };
    setDownloadState({ ...identity, downloading: true, error: null });
    const controller = new AbortController();
    downloadController.current = controller;
    void Promise.resolve()
      .then(() => {
        if (!controller.signal.aborted)
          return interaction.onDownload(attachment, controller.signal);
      })
      .catch(() => {
        if (!controller.signal.aborted)
          setDownloadState({
            ...identity,
            downloading: false,
            error: `Couldn’t download ${filename}. Try again.`,
          });
      })
      .finally(() => {
        if (downloadController.current === controller)
          downloadController.current = null;
        if (!controller.signal.aborted)
          setDownloadState((current) =>
            current ? { ...current, downloading: false } : current,
          );
      });
  };
  return (
    <div
      className="flex max-w-full flex-col items-start gap-1"
      data-testid="chat-message-attachment"
    >
      {src !== null && src !== failedSrc && (
        <img
          src={src}
          alt={filename}
          loading="lazy"
          onError={(): void => setFailedSrc(src)}
          className="max-h-48 max-w-full rounded-md object-contain ring-1 ring-line-base"
        />
      )}
      <FileAttachmentChip
        filename={filename}
        {...(onOpen === undefined
          ? {}
          : { onOpen: (): void => onOpen(attachment) })}
        {...(interaction === null ? {} : { onDownload: download })}
      />
      {image.loading && (
        <span role="status" className="text-2xs fg-secondary">
          Loading image…
        </span>
      )}
      {image.error && (
        <span role="alert" className="text-2xs fg-secondary">
          {image.error}{' '}
          <button
            type="button"
            className="focus-ring fg-accent"
            onClick={image.retry}
          >
            Try again
          </button>
        </span>
      )}
      {downloading && (
        <span role="status" className="text-2xs fg-secondary">
          Downloading {filename}…
        </span>
      )}
      {downloadError !== null && (
        <span role="alert" className="text-2xs fg-destructive">
          {downloadError}
        </span>
      )}
    </div>
  );
});
