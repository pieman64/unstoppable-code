import type { JSX } from 'react';
import { Heading, Notice, NoticeButton } from '@canopy/ui-shared/components';
import { isNoticeStatesPageEnabled } from '@/components/sidebar/notice-states-page-flag';
import { NoticeComposerPreview } from './NoticeComposerPreview';
import { ToastTestBench } from './ToastTestBench';
import {
  NOTICE_GALLERY_SECTIONS,
  type NoticeGalleryEntry,
} from './noticeStateGalleryData';

/**
 * Reference page for every inline notice the app can raise, reachable from
 * the sidebar More menu in dev and E2E builds. Each row is the shared
 * `Notice` with the props the shipping component hands it (copy, intent,
 * actions, dismissal), so the family can be swept in one place with hot
 * reload while iterating. Buttons are inert.
 */

const INTENTS = ['neutral', 'attention', 'destructive', 'positive'] as const;

function GalleryNotice({ entry }: { entry: NoticeGalleryEntry }): JSX.Element {
  const actions = entry.actions?.length ? (
    <>
      {entry.aside}
      {entry.actions.map((action) => (
        <NoticeButton
          key={action.label}
          variant={action.variant ?? 'secondary'}
          disabled={action.disabled}
        >
          {action.label}
        </NoticeButton>
      ))}
    </>
  ) : (
    entry.aside
  );
  return (
    <Notice
      intent={entry.intent}
      {...(entry.icon !== undefined ? { icon: entry.icon } : {})}
      {...(entry.heading !== undefined ? { title: entry.heading } : {})}
      {...(entry.detail !== undefined ? { detail: entry.detail } : {})}
      {...(actions !== undefined ? { actions } : {})}
      {...(entry.actionsPlacement !== undefined
        ? { actionsPlacement: entry.actionsPlacement }
        : {})}
      {...(entry.dismissible
        ? { onDismiss: (): void => undefined, dismissLabel: 'Dismiss' }
        : {})}
      {...(entry.live === false ? { role: 'none' as const } : {})}
      data-testid={`notice-gallery-${entry.id}`}
    >
      {entry.message}
    </Notice>
  );
}

/**
 * Flag gate at the PAGE as well as the menu entry: `notice-states` stays in
 * the App Advisor navigation allowlist, so a packaged build could still be
 * navigated here by name. With the flag off the page renders a placeholder.
 */
export function NoticeStateGalleryPage(): JSX.Element {
  if (!isNoticeStatesPageEnabled()) {
    return (
      <div
        className="flex h-full items-center justify-center bg-base"
        data-testid="notice-states-page-disabled"
      >
        <p className="text-xs fg-secondary">
          This page is a development-only reference and is not enabled in this
          build.
        </p>
      </div>
    );
  }
  return <NoticeStateGalleryContent />;
}

function NoticeStateGalleryContent(): JSX.Element {
  return (
    // The page sits inside `<main>`, which already scrolls; one constrained
    // scroller owns the overflow, as on the other state galleries.
    <div
      className="flex h-full flex-col bg-base fg-primary"
      data-testid="page-notice-states"
    >
      <header className="px-8 pt-8 pb-4">
        <Heading level={1} variant="page">
          Notices — all states
        </Heading>
        <p className="mt-1 max-w-3xl text-xs fg-secondary">
          The composer notices and the other notices that follow the title-first
          shape, rendered through the shared <code>Notice</code> with the copy
          and actions the real component passes; plain single-sentence notices
          elsewhere are not listed. Names, counts, and times in the copy are
          examples. Buttons do nothing here.
        </p>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-8 pb-12">
        <ToastTestBench />

        <NoticeComposerPreview
          renderNotice={(entry): JSX.Element => <GalleryNotice entry={entry} />}
        />

        <section
          className="mb-12"
          data-testid="notice-gallery-section-primitive"
        >
          <Heading level={2} variant="title" className="mb-1">
            Primitive
          </Heading>
          <p className="mb-3 max-w-3xl text-xs fg-secondary">
            One surface for every intent; only the glyph ink changes. A short
            title in the primary ink leads the line and the message follows it
            in the tertiary ink. Trailing actions sit on that row; three or more
            drop to their own row aligned with the copy.
          </p>
          <div className="flex max-w-3xl flex-col gap-2">
            {INTENTS.map((intent) => (
              <Notice
                key={intent}
                intent={intent}
                onDismiss={(): void => undefined}
                actions={
                  <>
                    <NoticeButton>Alternative</NoticeButton>
                    <NoticeButton variant="primary">Recommended</NoticeButton>
                  </>
                }
                data-testid={`notice-gallery-intent-${intent}`}
              >
                {intent.charAt(0).toUpperCase() + intent.slice(1)} notice with a
                trailing action pair.
              </Notice>
            ))}
            <Notice
              intent="attention"
              title="A short title"
              detail="A detail line under the message, for post-action feedback only."
              actionsPlacement="below"
              onDismiss={(): void => undefined}
              actions={
                <>
                  <NoticeButton>First alternative</NoticeButton>
                  <NoticeButton>Second alternative</NoticeButton>
                  <NoticeButton variant="primary">Recommended</NoticeButton>
                </>
              }
              data-testid="notice-gallery-intent-below"
            >
              The message follows the title on the same line in the tertiary ink
              and wraps as one paragraph.
            </Notice>
          </div>
        </section>

        {NOTICE_GALLERY_SECTIONS.map((section) => (
          <section
            key={section.id}
            className="mb-12"
            data-testid={`notice-gallery-section-${section.id}`}
          >
            <Heading level={2} variant="title" className="mb-1">
              {section.title}
            </Heading>
            <p className="mb-3 max-w-3xl text-xs fg-secondary">
              {section.note}
            </p>
            <div className="flex max-w-3xl flex-col gap-6">
              {section.entries.map((entry) => (
                <div
                  key={entry.id}
                  data-testid={`notice-gallery-row-${entry.id}`}
                >
                  <div className="mb-1.5 flex items-baseline gap-2">
                    <span className="text-xs font-medium">{entry.title}</span>
                    {entry.note && (
                      <span className="text-2xs fg-secondary">
                        {entry.note}
                      </span>
                    )}
                  </div>
                  <GalleryNotice entry={entry} />
                </div>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
