/**
 * @jest-environment jsdom
 */
(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SharedContainerPublicationState } from '@canopy/desktop-shared/types';
import { SharePublishIssue, SharePublishStatus } from '../SharePublishStatus';

const BASE: Omit<SharedContainerPublicationState, 'status'> = {
  projectId: 'project-1',
  worktreeId: 'worktree-1',
  organizationId: 'org-1',
  containerId: 'container-1',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

function record(
  status: SharedContainerPublicationState['status'],
  extra: Partial<SharedContainerPublicationState> = {},
): SharedContainerPublicationState {
  return { ...BASE, status, ...extra };
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function render(
  publicationState: SharedContainerPublicationState | undefined,
  serverRevision: number | null,
  recipientsKnownEmpty = false,
): HTMLElement | null {
  // Tear down any previous render first. The lookup below is document-wide, so
  // a leftover root from an earlier call in the same test would shadow this
  // one as soon as a multi-render case expects a non-null result.
  teardown();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(
      <>
        <SharePublishStatus
          publicationState={publicationState}
          serverRevision={serverRevision}
          recipientsKnownEmpty={recipientsKnownEmpty}
        />
        <SharePublishIssue
          publicationState={publicationState}
          serverRevision={serverRevision}
          recipientsKnownEmpty={recipientsKnownEmpty}
          onRetry={() => {}}
        />
      </>,
    );
  });
  return document.querySelector<HTMLElement>(
    '[data-testid="shared-container-invite-modal-publication-state"]',
  );
}

function teardown(): void {
  if (root) {
    const current = root;
    act(() => {
      current.unmount();
    });
  }
  container?.remove();
  root = null;
  container = null;
}

afterEach(teardown);

describe('SharePublishStatus', () => {
  it('renders nothing when neither side knows a publish state', () => {
    expect(render(undefined, null)).toBeNull();
  });

  it('shows the spinner while a publish is running locally', () => {
    const block = render(record('publishing'), null);

    expect(block?.dataset.publishStatus).toBe('publishing');
    expect(block?.textContent).toContain('Publishing');
  });

  it('settles the heading status to Up to date once a revision exists', () => {
    const block = render(record('published', { revision: 3 }), 3);

    expect(block?.dataset.publishStatus).toBe('published');
    expect(block?.textContent).toContain('Up to date');
    expect(block?.textContent).not.toContain('Publishing');
    expect(block?.getAttribute('title')).toBe('Revision 3');
  });

  it('names the failure and what the owner can do about it', () => {
    const block = render(
      record('error', { errorReason: 'unpushed-head', revision: 2 }),
      null,
    );

    expect(block?.dataset.publishStatus).toBe('error');
    expect(block?.textContent).toContain("Couldn't publish");
    expect(
      document.querySelector(
        '[data-testid="shared-container-invite-modal-publication-error-reason"]',
      )?.textContent,
    ).toContain('not on GitHub yet');
    expect(
      document.querySelector(
        '[data-testid="shared-container-invite-modal-publication-retry"]',
      )?.textContent,
    ).toBe('Try again');
  });

  describe('the two not-published paths', () => {
    // `resolvePublishStatus` reaches `not-published` two ways and only one of
    // them means work is pending. Keying the spinner off the resolved status
    // alone would leave the manage view spinning forever on the other.

    it('spins for a local record — the invite handler queued the publish', () => {
      const block = render(record('not-published'), null);

      expect(block?.dataset.publishStatus).toBe('not-published');
      expect(block?.dataset.publishQueued).toBe('true');
      expect(block?.textContent).toContain('Publishing');
      expect(block?.textContent).not.toContain('been published yet');
    });

    it('rests for revision 0 with no local record — nothing is queued here', () => {
      const block = render(undefined, 0);

      expect(block?.dataset.publishStatus).toBe('not-published');
      expect(block?.dataset.publishQueued).toBe('false');
      expect(container?.textContent).toContain("haven't been published yet");
      expect(block?.textContent).not.toContain('Publishing');
      // The old line promised a timing this path cannot deliver on.
      expect(block?.textContent).not.toContain(
        'published shortly after the first invite',
      );
    });

    it('does not report a queued publish once the server says published', () => {
      // A stale local record can still read `not-published` while the server
      // already reports `revision >= 1` — published from another machine, or a
      // `listSharedByMe` result landing ahead of the local write. The rendered
      // copy was always correct here because it keys off the resolved status;
      // the diagnostic attribute was the part that contradicted it.
      const block = render(record('not-published'), 3);

      expect(block?.dataset.publishStatus).toBe('published');
      expect(block?.dataset.publishQueued).toBe('false');
      expect(block?.textContent).toContain('Up to date');
      expect(block?.textContent).not.toContain('Publishing');
    });

    it('still spins for a local record once the server reports revision 0', () => {
      // The ordinary post-invite steady state once `listSharedByMe` returns:
      // step 4 of `resolvePublishStatus` wins over step 5, and the record half
      // of the derivation is what has to keep the spinner up. This is the
      // hinge case for the two-half `publishQueued` check — reorder those
      // steps and this is the assertion that catches it.
      const block = render(record('not-published'), 0);

      expect(block?.dataset.publishStatus).toBe('not-published');
      expect(block?.dataset.publishQueued).toBe('true');
      expect(block?.textContent).toContain('Publishing');
    });
  });

  describe('when nobody has access', () => {
    // `SharedContainerPublishScheduler.run()` returns early for a target with
    // no recipients without rewriting the record, and revoking never touches
    // it — so invite → revoke the only recipient inside the publish debounce
    // leaves a `not-published` record with nothing queued behind it. Claiming
    // "Publishing…" forever there is the exact dishonesty this block exists to
    // avoid.

    it('says nothing about publishing rather than spinning forever', () => {
      expect(render(record('not-published'), 0, true)).toBeNull();
      expect(render(record('not-published'), null, true)).toBeNull();
      expect(render(undefined, 0, true)).toBeNull();
    });

    it('keeps reporting contents that were already published', () => {
      // Revoking everyone does not un-publish a revision, so this stays true.
      const block = render(record('published', { revision: 2 }), 2, true);

      expect(block?.dataset.publishStatus).toBe('published');
      expect(block?.textContent).toContain('Up to date');
    });

    it('keeps reporting a failed publish', () => {
      const block = render(
        record('error', { errorReason: 'unpushed-head', revision: 1 }),
        1,
        true,
      );

      expect(block?.dataset.publishStatus).toBe('error');
      expect(block?.textContent).toContain("Couldn't publish");
      // The scope line is a claim about access, so with nobody holding a grant
      // it has to talk about the contents instead. Asserting only the headline
      // would let "Recipients can still access revision 1" pass unnoticed —
      // naming recipients the owner just removed.
      const scope = document.querySelector(
        '[data-testid="shared-container-invite-modal-publication-error-scope"]',
      );
      expect(scope?.textContent).toContain('Revision 1 was published');
      expect(scope?.textContent).not.toContain('Recipients can still access');
      expect(scope?.textContent).not.toContain('Access remains granted');
    });

    it('says the contents were never published when no revision ever landed', () => {
      // Reachable whenever a first publish attempt fails before any revision
      // lands. `publication-state.ts` carries `revision` forward across status
      // rewrites for the same container, so an absent revision really does
      // mean "never published" rather than "we lost track".
      const block = render(
        record('error', { errorReason: 'unpushed-head' }),
        0,
        true,
      );

      expect(block?.dataset.publishStatus).toBe('error');
      const scope = document.querySelector(
        '[data-testid="shared-container-invite-modal-publication-error-scope"]',
      );
      expect(scope?.textContent).toContain('contents were never published');
      expect(scope?.textContent).not.toContain('Access remains granted');
    });

    it('still reports access honestly when recipients do hold a grant', () => {
      const block = render(
        record('error', { errorReason: 'unpushed-head', revision: 2 }),
        2,
        false,
      );

      expect(block?.dataset.publishStatus).toBe('error');
      const scope = document.querySelector(
        '[data-testid="shared-container-invite-modal-publication-error-scope"]',
      );
      expect(scope?.textContent).toContain('Recipients can still access');
    });

    it('keeps the access claim with a grant but no revision yet', () => {
      const block = render(
        record('error', { errorReason: 'unpushed-head' }),
        0,
        false,
      );

      expect(block?.dataset.publishStatus).toBe('error');
      const scope = document.querySelector(
        '[data-testid="shared-container-invite-modal-publication-error-scope"]',
      );
      expect(scope?.textContent).toContain('Access remains granted');
    });

    it('does not blank the block while the recipient list is still loading', () => {
      // The caller passes `recipientsKnownEmpty` only for loaded-and-empty. An
      // in-flight refetch must not read as "nobody has access", or the block
      // blinks off mid-invite.
      const block = render(record('not-published'), 0, false);

      expect(block?.dataset.publishQueued).toBe('true');
      expect(block?.textContent).toContain('Publishing');
    });
  });
});
