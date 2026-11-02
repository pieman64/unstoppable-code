/**
 * @jest-environment jsdom
 *
 * Provenance line wording (CAN-4908): new copies name the source version by
 * its publication time, older records keep the copy date.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SharedContainerForkProvenance } from '@canopy/desktop-shared/types';
import { POSTHOG_REPLAY_BLOCK_CLASS } from '@canopy/desktop-instrumentation/posthog-replay-privacy';
import { ForkedFromNotice } from '../ForkedFromNotice';

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const LEGACY: SharedContainerForkProvenance = {
  sourceContainerId: 'container-1',
  sourceRevisionId: 'revision-2',
  sourceOwnerDisplayName: 'Ada',
  organizationId: 'org-1',
  forkedAt: '2026-09-09T12:00:00.000Z',
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

function line(provenance: SharedContainerForkProvenance): HTMLElement | null {
  act(() => root.render(<ForkedFromNotice provenance={provenance} />));
  return container.querySelector(
    '[data-testid="shared-container-fork-provenance"]',
  );
}

it('anchors a new copy to the source version, not the copy time', () => {
  const notice = line({
    ...LEGACY,
    sourceRevisionCreatedAt: '2026-09-08T08:00:00.000Z',
  });

  expect(notice?.textContent).toMatch(
    /^Copied from Ada’s share \(version of .+\)\. This copy is yours and does not update when theirs does\.$/,
  );
  const time = notice?.querySelector('time');
  expect(time?.getAttribute('dateTime')).toBe('2026-09-08T08:00:00.000Z');
  expect(time?.getAttribute('title')).toBeTruthy();
  expect(
    notice?.querySelector(`.${POSTHOG_REPLAY_BLOCK_CLASS}`)?.textContent,
  ).toBe('Ada');
});

it('keeps the copy date for a legacy record without a source time', () => {
  const notice = line(LEGACY);

  expect(notice?.textContent).toBe(
    `Copied from Ada’s share on ${new Date(LEGACY.forkedAt).toLocaleDateString()}. This copy is yours and does not update when theirs does.`,
  );
  expect(notice?.querySelector('time')).toBeNull();
});

it('falls back to the copy date when the source time is unreadable', () => {
  const notice = line({ ...LEGACY, sourceRevisionCreatedAt: 'later' });

  expect(notice?.textContent).not.toContain('Invalid');
  expect(notice?.textContent).toContain(' on ');
});
