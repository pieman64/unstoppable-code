/**
 * @jest-environment jsdom
 *
 * Server-rendered tests for the shared plan/review comment-thread primitives.
 * Covers the canonical "Not sent" badge (chip shape, warning color — the
 * single source of truth both the Plan Explore and Code Review surfaces
 * consume) and the shared edit/delete action buttons.
 */
import { renderToString } from 'react-dom/server';
import {
  CommentAvatar,
  PlanReviewComment,
  PlanReviewCommentActions,
  type PlanReviewAuthor,
} from '../PlanReviewThread';
import { REPLAY_BLOCK_CLASS } from '../../lib/replay-privacy';

const AUTHOR: PlanReviewAuthor = { name: 'You', kind: 'user', isYou: true };

describe('PlanReviewComment unsent badge', () => {
  it('labels an unsent comment "Not sent" with a decorative warning icon', () => {
    const html = renderToString(
      <ul>
        <PlanReviewComment author={AUTHOR} pending>
          body
        </PlanReviewComment>
      </ul>,
    );
    expect(html).toContain('Not sent');
    expect(html).not.toContain('>pending<');
    expect(html).toContain('fg-warning');
    expect(html).toMatch(/<svg[^>]*aria-hidden="true"/);
    expect(html).toMatch(/<svg[^>]*width="12px"[^>]*height="12px"/);
  });

  it('omits the badge when the comment was sent', () => {
    const html = renderToString(
      <ul>
        <PlanReviewComment author={AUTHOR}>body</PlanReviewComment>
      </ul>,
    );
    expect(html).not.toContain('Not sent');
    expect(html).not.toContain('bg-warning-subtle');
  });
});

describe('CommentAvatar', () => {
  it('keeps its card backing the size of the avatar beside a tall comment', () => {
    const html = renderToString(<CommentAvatar author={AUTHOR} />);
    expect(html).toContain('self-start');
  });
});

describe('PlanReviewCommentActions', () => {
  it('renders edit and delete buttons wired to the provided callbacks', () => {
    const html = renderToString(
      <PlanReviewCommentActions
        onEdit={() => undefined}
        onDelete={() => undefined}
        editTestId="edit-test-id"
        deleteTestId="delete-test-id"
      />,
    );
    expect(html).toContain('data-testid="edit-test-id"');
    expect(html).toContain('data-testid="delete-test-id"');
    expect(html).toContain('aria-label="Edit comment"');
    expect(html).toContain('aria-label="Delete comment"');
  });
});

describe('PlanReviewComment session-replay privacy', () => {
  /** The comment's server-rendered markup, parsed into a detached element. */
  function renderComment(author: PlanReviewAuthor): HTMLElement {
    const host = document.createElement('div');
    host.innerHTML = renderToString(
      <ul>
        <PlanReviewComment author={author} timestamp="2026-10-06T12:00:00Z">
          body
        </PlanReviewComment>
      </ul>,
    );
    return host;
  }

  /** The innermost element whose whole text is `text`. */
  function textElement(host: HTMLElement, text: string): Element {
    const match = Array.from(host.querySelectorAll('*'))
      .reverse()
      .find((element) => element.textContent === text);
    if (match === undefined) throw new Error(`Missing ${text}`);
    return match;
  }

  function replayBlocked(element: Element): boolean {
    return element.closest(`.${REPLAY_BLOCK_CLASS}`) !== null;
  }

  it.each<PlanReviewAuthor>([
    { name: 'Grace Hopper', kind: 'user' },
    { name: 'Grace Hopper', kind: 'remote' },
    { name: 'Grace Hopper', kind: 'user', isYou: true },
  ])("blocks a $kind author's name and initials, not the comment", (author) => {
    const host = renderComment(author);
    expect(replayBlocked(textElement(host, 'Grace Hopper'))).toBe(true);
    expect(replayBlocked(textElement(host, 'GH'))).toBe(true);
    const comment = host.querySelector('li');
    if (comment === null) throw new Error('Missing comment');
    expect(replayBlocked(comment)).toBe(false);
    expect(replayBlocked(textElement(host, 'body'))).toBe(false);
    if (author.isYou === true) {
      expect(replayBlocked(textElement(host, 'you'))).toBe(false);
    }
  });

  it("records an agent author's name and glyph", () => {
    const host = renderComment({ name: 'Claude', kind: 'agent' });
    expect(replayBlocked(textElement(host, 'Claude'))).toBe(false);
    expect(host.querySelector(`.${REPLAY_BLOCK_CLASS}`)).toBeNull();
  });
});
