'use client';

import type { JSX, ReactNode } from 'react';
import type { ShareAudience } from '@canopy/protocol/sharing';
import type { PipelinePackageProgressEvent } from '@canopy/protocol/pipelines';
import {
  CopyLinkButton,
  DialogModal,
  ProgressBar,
  Notice,
} from '@canopy/ui-shared/components';
import { PUBLIC_SHARE_RETRY_LABEL } from './capability-package/share-copy';
import { ShareFooter, type ShareFooterSecondaryAction } from './ShareFooter';

/**
 * The common share-dialog structure. Every share surface renders it: the one
 * `ShareResourceDialog` (skills, pipelines, automations, collections, agents,
 * plugins, plans, runs) and the worktree / Cowork container Share modal.
 *
 * Top to bottom it owns: the chrome (title, subtitle, a locked X and backdrop
 * while busy), exactly one of a gate or the main layout (notes, the scope
 * slot, the resource content slot, a trailing `after` section), a status
 * region pinned above the footer that carries only the error and the
 * partial-success notices, and the footer. Progress lives in the primary
 * button; success is a toast the host raises through its `notify` port, never
 * a sentence in the dialog.
 */

/**
 * A share toast: feedback the host raises for an outcome the dialog does not
 * stay open for (a removed public link, an unconfirmed delivery).
 */
export interface ShareToast {
  readonly tone: 'success' | 'warning';
  readonly message: string;
  /** A link the toast offers through `CopyLinkButton`; never auto-copied. */
  readonly link?: string;
  /**
   * The message names a person, so a host with session replay blocks it.
   * Hosts without replay ignore it.
   */
  readonly blockMessageFromReplay?: boolean;
}

/** Posts a share toast in the host's toast system. */
export type ShareNotify = (toast: ShareToast) => void;

/** Where a share dialog is in its lifecycle. */
export interface ShareDialogLifecycle {
  /**
   * `sharing` locks the form and spins the primary; `error` pins the error
   * notice above the footer; `partial` means the share landed but its public
   * link did not; `success` means it landed and pins the success notice.
   */
  readonly status: 'idle' | 'sharing' | 'error' | 'partial' | 'success';
  /** Something already landed in this session: show Done in the footer. */
  readonly committed: boolean;
}

/** The resource's existing link, shown as Copy link in the footer. */
export interface ShareDialogLink {
  readonly url: string;
  readonly kind: 'public' | 'scoped' | 'item';
}

function capitalize(value: string): string {
  return `${value.charAt(0).toUpperCase()}${value.slice(1)}`;
}

/** The success notice a landed share keeps the dialog open on. */
export interface ShareSuccessNotice {
  readonly tone: 'success' | 'warning';
  readonly message: string;
  /** The share's link, shown under the message; never auto-copied. */
  readonly link?: string;
}

/** Inputs for the standard success notice after a share. */
export interface ShareSuccessNoticeInput {
  readonly noun: string;
  readonly scope: ShareAudience | null;
  readonly targetName?: string;
  readonly isUpdate: boolean;
  /**
   * The dialog opened on a share that already existed rather than one it
   * just made, so a public share reads "is public", not "is now public".
   */
  readonly reopened?: boolean;
  /** Host-supplied sentence (e.g. a pending delivery): a warning notice. */
  readonly message?: string;
  readonly shareUrl?: string;
}

/**
 * The standard success copy. It names the audience and never says
 * "successfully"; a host message replaces the sentence as a warning.
 */
export function shareSuccessNotice({
  noun,
  scope,
  targetName,
  isUpdate,
  reopened = false,
  message,
  shareUrl,
}: ShareSuccessNoticeInput): ShareSuccessNotice {
  const Noun = capitalize(noun);
  const link =
    shareUrl !== undefined && shareUrl !== '' ? { link: shareUrl } : {};
  if (message !== undefined && message !== '') {
    return { tone: 'warning', message, ...link };
  }
  let sentence: string;
  if (isUpdate) {
    sentence = `${Noun} updated`;
  } else if (scope === 'public') {
    sentence = reopened ? `${Noun} is public` : `${Noun} is now public`;
  } else if (targetName !== undefined && targetName !== '') {
    sentence = `${Noun} shared with ${targetName}`;
  } else if (scope === 'team') {
    sentence = `${Noun} shared with your team`;
  } else if (scope === 'organization') {
    sentence = `${Noun} shared with your organization`;
  } else {
    sentence = `${Noun} shared`;
  }
  return { tone: 'success', message: sentence, ...link };
}

/** Toast after Remove public link. */
export const PUBLIC_LINK_REMOVED_TOAST = 'Public link removed';

/** Partial success: the share landed, its public link didn't. */
export function sharePartialMessage(noun: string, targetName?: string): string {
  return targetName !== undefined && targetName !== ''
    ? `Shared with ${targetName}, but the public link couldn't be created.`
    : `${capitalize(noun)} saved, but the public link couldn't be created.`;
}

/**
 * Stages this renderer can caption. Older desktops still emit the first
 * three; a string not listed here (a newer producer) gets the generic caption.
 */
const KNOWN_SHARE_STAGES: ReadonlySet<string> = new Set([
  'Preparing package…',
  'Uploading dependencies…',
  'Publishing pipeline…',
  'Preparing files…',
  'Uploading files…',
  'Finishing upload…',
  'Retrying upload…',
]);
const GENERIC_STAGE_CAPTION = 'Sharing…';

/**
 * Stages whose wire value keeps a former name; the caption uses the current
 * one (CAN-4651: workflows were called pipelines).
 */
const SHARE_STAGE_DISPLAY: ReadonlyMap<string, string> = new Map([
  ['Publishing pipeline…', 'Publishing workflow…'],
]);

/** Caption for a capability-package stage, e.g. `Uploading files · 3 of 12`. */
export function shareStageCaption(stage: PipelinePackageProgressEvent): string {
  const caption = KNOWN_SHARE_STAGES.has(stage.stage)
    ? (SHARE_STAGE_DISPLAY.get(stage.stage) ?? stage.stage)
    : GENERIC_STAGE_CAPTION;
  // A count only means something with work to count: never "0 of 0".
  if (
    stage.completed !== undefined &&
    stage.total !== undefined &&
    stage.total > 0
  ) {
    return `${caption.replace(/…$/, '')} · ${String(stage.completed)} of ${String(stage.total)}`;
  }
  return caption;
}

export interface ShareDialogFrameProps {
  /** `Share <noun>`, or a host title such as a management-only heading. */
  readonly title: string;
  readonly subtitle?: string;
  readonly maxWidth?: 'md' | 'lg' | '2xl';
  /** Test-id prefix: the root is `${prefix}-modal`. */
  readonly testIdPrefix: string;
  readonly ownerDocument?: Document;
  /** Closes the dialog (X, backdrop, Escape and Done). */
  readonly onDismiss: () => void;
  readonly lifecycle: ShareDialogLifecycle;
  /**
   * Extra host work that locks the dialog like a share does (removing a
   * public link, retrying one). The primary does not spin for it.
   */
  readonly busy?: boolean;

  /** Loading or blocked body. When set, it replaces the whole main layout. */
  readonly gate?: ReactNode;
  /** Resource notes above the scope selector. */
  readonly notes?: ReactNode;
  /** The scope selector plus its team / organization pickers. */
  readonly scope?: ReactNode;
  /** The resource-specific section. */
  readonly content?: ReactNode;
  /** A trailing section outside the locked form, e.g. People with access. */
  readonly after?: ReactNode;

  /** The error sentence, shown when `lifecycle.status` is `error`. */
  readonly errorMessage?: string;
  /** Recovery for the error, e.g. Sign in. Rendered in the error notice. */
  readonly errorAction?: ReactNode;
  /**
   * A failed action on the dialog's current state (removing a public link),
   * shown in the error notice without leaving that state.
   */
  readonly actionErrorMessage?: string;
  /** The partial-success sentence, shown when `lifecycle.status` is `partial`. */
  readonly partialMessage?: string;
  /** The success notice, shown when `lifecycle.status` is `success`. */
  readonly success?: ShareSuccessNotice;
  /**
   * A control at the end of the success notice's link line (its message
   * line when there is no link), e.g. the Remove public link icon button.
   */
  readonly successLinkAction?: ReactNode;
  /** Retries the public link after a partial success. */
  readonly onRetryPublic?: () => void;
  readonly retryingPublic?: boolean;

  /** Hides the primary (a gate with no recovery action, management-only). */
  readonly showSubmit?: boolean;
  readonly submitLabel: string;
  /** Primary label while sharing, e.g. `Sharing…`. */
  readonly sharingLabel: string;
  readonly submitDisabled?: boolean;
  readonly submitTestId?: string;
  readonly onSubmit: () => void;
  readonly secondaryAction?: ShareFooterSecondaryAction;
  /** The capability-package stage, shown in the footer while sharing. */
  readonly stage?: PipelinePackageProgressEvent | null;
  /** The resource's existing link: Copy link in the footer. */
  readonly link?: ShareDialogLink;
  /** Host clipboard writer for Copy link. */
  readonly copyText?: (text: string) => Promise<boolean>;
  /** Fires after Copy link wrote the link. */
  readonly onLinkCopied?: () => void;
  /** Overlays (confirm dialogs) rendered inside the modal. */
  readonly children?: ReactNode;
}

export function ShareDialogFrame({
  title,
  subtitle,
  maxWidth = 'md',
  testIdPrefix: p,
  ownerDocument,
  onDismiss,
  lifecycle,
  busy: extraBusy = false,
  gate,
  notes,
  scope,
  content,
  after,
  errorMessage,
  errorAction,
  actionErrorMessage,
  partialMessage,
  success,
  successLinkAction,
  onRetryPublic,
  retryingPublic = false,
  showSubmit = true,
  submitLabel,
  sharingLabel,
  submitDisabled = false,
  submitTestId,
  onSubmit,
  secondaryAction,
  stage,
  link,
  copyText,
  onLinkCopied,
  children,
}: ShareDialogFrameProps): JSX.Element {
  const sharing = lifecycle.status === 'sharing';
  const busy = sharing || retryingPublic || extraBusy;
  const gated = gate !== undefined && gate !== null && gate !== false;
  const partial = lifecycle.status === 'partial';

  const leading = ((): ReactNode => {
    if (sharing && stage) {
      const determinate =
        stage.completed !== undefined &&
        stage.total !== undefined &&
        stage.total > 0;
      return (
        <div
          className="min-w-0 flex-1 space-y-1 pr-3"
          data-testid={`${p}-stage`}
        >
          <p className="truncate text-xs fg-secondary">
            {shareStageCaption(stage)}
          </p>
          {determinate && (
            <ProgressBar
              value={((stage.completed ?? 0) / (stage.total ?? 1)) * 100}
              label={shareStageCaption(stage)}
              hideLabel
            />
          )}
        </div>
      );
    }
    if (!sharing && !gated && link) {
      return (
        <CopyLinkButton
          url={link.url}
          size="compact"
          dataTestId={`${p}-copy-link`}
          {...(copyText ? { write: copyText } : {})}
          {...(onLinkCopied ? { onCopy: onLinkCopied } : {})}
        />
      );
    }
    return null;
  })();

  // The footer renders only when one of the actions it would show survives
  // the same rules ShareFooter is given below, so no empty strip remains.
  const showPrimary = partial ? onRetryPublic !== undefined : showSubmit;
  const showSecondary = secondaryAction !== undefined && !partial;
  const hasFooterActions =
    lifecycle.committed || showPrimary || Boolean(leading) || showSecondary;

  return (
    <DialogModal
      inset="flush"
      onClose={busy ? (): void => {} : onDismiss}
      title={title}
      {...(subtitle !== undefined ? { subtitle } : {})}
      maxWidth={maxWidth}
      closeOnBackdrop={!busy}
      closeButtonDisabled={busy}
      dataTestId={`${p}-modal`}
      ownerDocument={ownerDocument}
      scrollableBody={false}
      trapFocus
    >
      <div
        className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain px-6 py-4"
        data-testid={`${p}-body`}
      >
        {gated ? (
          <div data-testid={`${p}-unavailable`}>{gate}</div>
        ) : (
          <>
            {notes}
            {/*
              `mx-0`, not `m-0`: the parent's `space-y-4` spaces `after` by
              giving this fieldset a bottom margin, which `m-0` would win over.
            */}
            <fieldset
              disabled={busy}
              className="mx-0 min-w-0 space-y-4 border-0 p-0"
              data-testid={`${p}-form`}
            >
              {scope}
              {content}
            </fieldset>
            {after}
          </>
        )}
      </div>

      {actionErrorMessage !== undefined && actionErrorMessage !== '' && (
        <div className="px-6 pb-3">
          <Notice intent="destructive" data-testid={`${p}-error`}>
            {actionErrorMessage}
          </Notice>
        </div>
      )}
      {lifecycle.status === 'error' && errorMessage && (
        <div className="px-6 pb-3">
          <Notice
            intent="destructive"
            data-testid={`${p}-error`}
            {...(errorAction !== undefined ? { actions: errorAction } : {})}
          >
            {errorMessage}
          </Notice>
        </div>
      )}
      {partial && partialMessage && (
        <div className="px-6 pb-3">
          <Notice intent="attention" data-testid={`${p}-partial`}>
            {partialMessage}
          </Notice>
        </div>
      )}

      {lifecycle.status === 'success' && success && (
        <div className="px-6 pb-3">
          {success.link !== undefined ? (
            <Notice
              intent={success.tone === 'success' ? 'positive' : 'attention'}
              title={success.message}
              titleLayout="stacked"
              data-testid={`${p}-success`}
            >
              <span className="flex items-center gap-1">
                <span
                  className="min-w-0 flex-1 break-all select-all"
                  data-testid={`${p}-link`}
                >
                  {success.link}
                </span>
                {successLinkAction}
              </span>
            </Notice>
          ) : (
            <Notice
              intent={success.tone === 'success' ? 'positive' : 'attention'}
              data-testid={`${p}-success`}
            >
              {successLinkAction ? (
                <span className="flex items-center gap-1">
                  <span className="min-w-0 flex-1">{success.message}</span>
                  {successLinkAction}
                </span>
              ) : (
                success.message
              )}
            </Notice>
          )}
        </div>
      )}

      {hasFooterActions && (
        <ShareFooter
          onCancel={onDismiss}
          showCancel={lifecycle.committed}
          cancelLabel="Done"
          cancelDisabled={busy}
          cancelTestId={`${p}-done`}
          showPrimary={showPrimary}
          onSubmit={partial && onRetryPublic ? onRetryPublic : onSubmit}
          submitLabel={partial ? PUBLIC_SHARE_RETRY_LABEL : submitLabel}
          submitDisabled={partial ? retryingPublic : submitDisabled}
          submitTestId={
            partial ? `${p}-retry-public` : (submitTestId ?? `${p}-submit`)
          }
          loading={partial ? retryingPublic : sharing}
          loadingLabel={partial ? PUBLIC_SHARE_RETRY_LABEL : sharingLabel}
          {...(showSecondary ? { secondaryAction } : {})}
          leading={leading}
          testIdPrefix={p}
        />
      )}
      {children}
    </DialogModal>
  );
}
