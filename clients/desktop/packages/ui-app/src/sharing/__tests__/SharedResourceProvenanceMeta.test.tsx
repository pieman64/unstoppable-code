/**
 * @jest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { REPLAY_BLOCK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import type { SharedResourceProvenance } from '../sharedResourceProvenance';
import {
  sharedResourceProvenanceMeta,
  type SharedResourceProvenanceMetaOptions,
} from '../SharedResourceProvenanceMeta';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const TEST_ID = 'shared-skill-detail-audience';

describe('sharedResourceProvenanceMeta', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(
    provenance: SharedResourceProvenance,
    options?: SharedResourceProvenanceMetaOptions,
  ): void {
    act(() =>
      root.render(
        <p>{sharedResourceProvenanceMeta(provenance, TEST_ID, options)}</p>,
      ),
    );
  }

  function fact(suffix = ''): HTMLElement | null {
    return container.querySelector<HTMLElement>(
      `[data-testid="${TEST_ID}${suffix}"]`,
    );
  }

  it('renders author, organization and audience in order', () => {
    render({
      author: 'Lena Park',
      organizationName: 'Acme',
      audience: { audience: 'organization' },
    });

    const facts = [fact('-author'), fact('-organization'), fact()];
    expect(facts.map((node) => node?.textContent)).toEqual([
      'By Lena Park',
      'Acme',
      'Organization',
    ]);
    expect(
      Array.from(container.querySelectorAll('[data-testid]')).map((node) =>
        node.getAttribute('data-testid'),
      ),
    ).toEqual([`${TEST_ID}-author`, `${TEST_ID}-organization`, TEST_ID]);
  });

  it('replay-blocks the author value only', () => {
    render({ author: 'Lena Park', organizationName: 'Acme', audience: null });

    const author = fact('-author');
    expect(author?.classList.contains(REPLAY_BLOCK_CLASS)).toBe(false);
    expect(author?.querySelector(`.${REPLAY_BLOCK_CLASS}`)?.textContent).toBe(
      'Lena Park',
    );
    expect(
      fact('-organization')?.querySelector(`.${REPLAY_BLOCK_CLASS}`),
    ).toBeNull();
  });

  it('renders a team audience with its name', () => {
    render({
      author: null,
      organizationName: 'Acme',
      audience: { audience: 'team', teamName: 'Platform' },
    });

    expect(fact('-author')).toBeNull();
    expect(fact()?.textContent).toBe('Team: Platform');
  });

  it('returns no node for an omitted fact', () => {
    const meta = sharedResourceProvenanceMeta(
      { author: null, organizationName: null, audience: null },
      TEST_ID,
    );
    expect(meta.filter(Boolean)).toEqual([]);
    expect(meta).toHaveLength(3);
  });

  it('renders markup-like names as text', () => {
    render({
      author: '<b>Lena</b>',
      organizationName: '<img src=x> & Co.',
      audience: { audience: 'public' },
    });

    expect(fact('-author')?.textContent).toBe('By <b>Lena</b>');
    expect(fact('-organization')?.textContent).toBe('<img src=x> & Co.');
    expect(container.querySelector('b, img')).toBeNull();
    expect(fact()?.textContent).toBe('Public');
  });

  describe('when Shared by you lists the audiences (CAN-5224)', () => {
    it.each([
      ['public', { audience: 'public' }],
      ['organization', { audience: 'organization' }],
      ['team', { audience: 'team', teamName: 'Platform' }],
      ['personal', { audience: 'organization', personal: true }],
    ] as const)(
      'drops a %s audience and keeps author and organization',
      (_label, audience) => {
        render(
          { author: 'Lena Park', organizationName: 'Acme', audience },
          { audienceListedBelow: true },
        );

        expect(fact()).toBeNull();
        expect(fact('-author')?.textContent).toBe('By Lena Park');
        expect(fact('-organization')?.textContent).toBe('Acme');
        expect(container.textContent).toBe('By Lena ParkAcme');
      },
    );

    it('keeps the audience when the option is omitted or false', () => {
      const provenance: SharedResourceProvenance = {
        author: 'Lena Park',
        organizationName: 'Acme',
        audience: { audience: 'organization' },
      };
      render(provenance);
      expect(fact()?.textContent).toBe('Organization');

      render(provenance, { audienceListedBelow: false });
      expect(fact()?.textContent).toBe('Organization');
    });

    it('renders nothing when the audience was the only fact', () => {
      render(
        {
          author: null,
          organizationName: null,
          audience: { audience: 'public' },
        },
        { audienceListedBelow: true },
      );

      expect(container.querySelector('p')?.childNodes).toHaveLength(0);
    });
  });
});
