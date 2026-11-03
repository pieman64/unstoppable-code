/** @jest-environment jsdom */
import { act, type JSX } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { REPLAY_BLOCK_CLASS } from '@canopy/ui-shared/lib/replay-privacy';
import { DetailPrimaryCta } from '@canopy/ui-shared/components';
import { SkillReadDetail } from '../SkillReadDetail';

Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

function mount(element: JSX.Element): {
  container: HTMLDivElement;
  root: Root;
} {
  const container = document.createElement('div');
  const root = createRoot(container);
  act(() => root.render(element));
  return { container, root };
}

const content = {
  frontmatter: { name: 'Example skill', description: 'Example description' },
  body: '# Main instructions',
};
const emptyRead = (): Promise<{
  content: string;
  truncated: boolean;
  binary: boolean;
}> => Promise.resolve({ content: '', truncated: false, binary: false });

describe('SkillReadDetail', () => {
  // CAN-3119: the skill detail dialogs record their chrome and related
  // content, so the SKILL.md content carries its own session-replay block.
  it('blocks the skill content and records related content in session replay', () => {
    const related = <p data-testid="skill-related">Related skills</p>;
    const single = mount(
      <SkillReadDetail
        skill={{ sourceId: 'custom:app', name: 'single' }}
        content={content}
        files={[]}
        loading={false}
        error=""
        readFile={emptyRead}
        relatedContent={related}
      />,
    );
    const singleHeading = Array.from(
      single.container.querySelectorAll('h1'),
    ).find((heading) => heading.textContent === 'Main instructions');
    expect(singleHeading?.closest(`.${REPLAY_BLOCK_CLASS}`)).not.toBeNull();
    expect(
      single.container
        .querySelector('[data-testid="skill-read-detail"]')
        ?.closest(`.${REPLAY_BLOCK_CLASS}`),
    ).toBeNull();
    expect(
      single.container
        .querySelector('[data-testid="skill-related"]')
        ?.closest(`.${REPLAY_BLOCK_CLASS}`),
    ).toBeNull();
    act(() => single.root.unmount());

    const multi = mount(
      <SkillReadDetail
        skill={{ sourceId: 'custom:app', name: 'multi' }}
        content={content}
        files={['SKILL.md', 'references/notes.md']}
        loading={false}
        error=""
        readFile={emptyRead}
        relatedContent={related}
      />,
    );
    expect(
      multi.container
        .querySelector('[data-testid="skill-related"]')
        ?.closest(`.${REPLAY_BLOCK_CLASS}`),
    ).toBeNull();
    const body = Array.from(multi.container.querySelectorAll('h1')).find(
      (heading) => heading.textContent === 'Main instructions',
    );
    expect(body?.closest(`.${REPLAY_BLOCK_CLASS}`)).not.toBeNull();
    const frontmatter = Array.from(multi.container.querySelectorAll('*')).find(
      (element) => element.textContent === 'Example description',
    );
    expect(frontmatter?.closest(`.${REPLAY_BLOCK_CLASS}`)).not.toBeNull();
    const tabBar = multi.container.querySelector(
      '[data-testid="skill-file-tab-bar"]',
    );
    expect(tabBar?.closest(`.${REPLAY_BLOCK_CLASS}`)).toBeNull();
    act(() => multi.root.unmount());
  });

  it('renders the main skill and multi-file controls', () => {
    const { container, root } = mount(
      <SkillReadDetail
        skill={{ sourceId: 'custom:app', name: 'example' }}
        content={content}
        files={['SKILL.md', 'references/notes.md']}
        filesTruncated
        loading={false}
        error=""
        readFile={emptyRead}
      />,
    );

    expect(container.textContent).toContain('Main instructions');
    expect(
      container.querySelector('[data-testid="skill-file-tab-bar"]'),
    ).not.toBeNull();
    expect(container.textContent).toContain('file list is incomplete');
    act(() => root.unmount());
  });

  it('sits on the page inset by default and on the 24px inset in a dialog', () => {
    const classesFor = (inset?: 'page' | 'dialog'): string[] => {
      const { container, root } = mount(
        <SkillReadDetail
          skill={{ sourceId: 'plugin:test', name: 'inset' }}
          inset={inset}
          content={content}
          files={[]}
          loading={false}
          error=""
          readFile={emptyRead}
        />,
      );
      const classes = (
        container
          .querySelector('[data-testid="skill-read-detail"]')
          ?.getAttribute('class') ?? ''
      ).split(' ');
      act(() => root.unmount());
      return classes;
    };
    expect(classesFor()).toEqual(expect.arrayContaining(['px-5', 'pb-5']));
    expect(classesFor('dialog')).toEqual(
      expect.arrayContaining(['px-6', 'pb-6']),
    );
    expect(classesFor('dialog')).not.toContain('px-5');
  });

  it('renders main-only content without file chrome', () => {
    const { container, root } = mount(
      <SkillReadDetail
        skill={{ sourceId: 'plugin:test', name: 'main-only' }}
        content={content}
        files={[]}
        loading={false}
        error=""
        readFile={emptyRead}
      />,
    );

    expect(container.textContent).toContain('Main instructions');
    expect(
      container.querySelector('[data-testid="skill-file-tab-bar"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="skill-file-tree-toggle"]'),
    ).toBeNull();
    act(() => root.unmount());
  });

  it('loads a supporting file lazily and reports truncation', async () => {
    let resolveRead:
      | ((value: {
          content: string;
          truncated: boolean;
          binary: boolean;
        }) => void)
      | undefined;
    const readFile = jest.fn(
      () =>
        new Promise<{ content: string; truncated: boolean; binary: boolean }>(
          (resolve) => {
            resolveRead = resolve;
          },
        ),
    );
    const { container, root } = mount(
      <SkillReadDetail
        skill={{ sourceId: 'custom:app', name: 'example' }}
        content={content}
        files={['SKILL.md', 'references/notes.md']}
        loading={false}
        error=""
        readFile={readFile}
      />,
    );

    act(() => {
      container
        .querySelector('[data-testid="skill-file-tree-toggle"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    act(() => {
      container
        .querySelector(
          '[data-testid="skill-file-tree-file"][data-path="references/notes.md"]',
        )
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(readFile).toHaveBeenCalledWith('references/notes.md');
    expect(container.textContent).toContain('Loading');

    await act(async () => {
      resolveRead?.({ content: '# Notes', truncated: true, binary: false });
      await Promise.resolve();
    });
    expect(container.textContent).toContain('Notes');
    expect(container.textContent).toContain('only the beginning is shown');
    act(() => root.unmount());
  });

  it('visibly distinguishes the active file tab from inactive tabs', () => {
    const { container, root } = mount(
      <SkillReadDetail
        skill={{ sourceId: 'custom:app', name: 'example' }}
        content={content}
        files={['SKILL.md', 'references/notes.md']}
        loading={false}
        error=""
        readFile={emptyRead}
      />,
    );

    const mainTab = container.querySelector<HTMLElement>(
      '[data-testid="skill-file-tab-main"]',
    );
    expect(mainTab?.className).toContain('bg-secondary fg-primary');

    act(() => {
      container
        .querySelector('[data-testid="skill-file-tree-toggle"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    act(() => {
      container
        .querySelector(
          '[data-testid="skill-file-tree-file"][data-path="references/notes.md"]',
        )
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    const supportingTab = container.querySelector<HTMLElement>(
      '[data-testid="skill-file-tab"]',
    );
    expect(mainTab?.className).toContain('border-transparent fg-secondary');
    expect(supportingTab?.className).toContain('bg-secondary fg-primary');
    expect(supportingTab?.className).not.toBe(mainTab?.className);
    act(() => root.unmount());
  });

  it('hides unavailable edit and shows available edit', () => {
    const props = {
      skill: { sourceId: 'custom:app', name: 'example' },
      content,
      files: [],
      loading: false,
      error: '',
      readFile: emptyRead,
    };
    const onEdit = jest.fn();
    const { container, root } = mount(<SkillReadDetail {...props} />);
    expect(
      container.querySelector('[data-testid="skill-read-detail-edit"]'),
    ).toBeNull();

    act(() => root.render(<SkillReadDetail {...props} onEdit={onEdit} />));
    const edit = container.querySelector(
      '[data-testid="skill-read-detail-edit"]',
    );
    expect(edit).not.toBeNull();
    act(() => {
      edit?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onEdit).toHaveBeenCalledTimes(1);
    act(() => root.unmount());
  });

  it('renders explicit loading and error states', () => {
    const { container, root } = mount(
      <SkillReadDetail
        skill={{ sourceId: 'custom:app', name: 'example' }}
        content={null}
        files={[]}
        loading
        error=""
        readFile={emptyRead}
      />,
    );
    expect(container.textContent).toContain('Loading');

    act(() =>
      root.render(
        <SkillReadDetail
          skill={{ sourceId: 'custom:app', name: 'example' }}
          content={null}
          files={[]}
          loading={false}
          error="Unable to load skill."
          readFile={emptyRead}
        />,
      ),
    );
    expect(container.textContent).toContain('Unable to load skill.');
    act(() => root.unmount());
  });

  // CAN-3704: a skill the host cannot share keeps a visible Share beside Add
  // that explains why and never activates.
  it('renders a blocked Share before Add with its reason', () => {
    const onAdd = jest.fn();
    const { container, root } = mount(
      <SkillReadDetail
        skill={{ sourceId: 'github:acme:skills', name: 'example' }}
        content={content}
        files={[]}
        loading={false}
        error=""
        readFile={emptyRead}
        onAdd={onAdd}
        shareAction={{
          status: 'blocked',
          reason: 'Sharing is unavailable for this item.',
        }}
      />,
    );
    const share = container.querySelector<HTMLButtonElement>(
      '[data-testid="skill-read-detail-share"]',
    );
    const add = container.querySelector(
      '[data-testid="skill-read-detail-add"]',
    );
    expect(share?.getAttribute('aria-disabled')).toBe('true');
    expect(share?.getAttribute('aria-description')).toBe(
      'Sharing is unavailable for this item.',
    );
    expect(
      share && add
        ? share.compareDocumentPosition(add) & Node.DOCUMENT_POSITION_FOLLOWING
        : 0,
    ).toBeTruthy();
    act(() => share?.click());
    expect(onAdd).not.toHaveBeenCalled();
    act(() => root.unmount());
  });

  it('replaces the internal Add with exactly one host primary CTA', () => {
    const onAdd = jest.fn();
    const onTry = jest.fn();
    const { container, root } = mount(
      <SkillReadDetail
        skill={{ sourceId: 'github:acme:skills', name: 'example' }}
        content={content}
        files={[]}
        loading={false}
        error=""
        readFile={emptyRead}
        onAdd={onAdd}
        shareAction={{
          status: 'blocked',
          reason: 'Sharing is unavailable for this item.',
        }}
        primaryAction={
          <DetailPrimaryCta state="try" onTry={onTry} onInstall={onAdd} />
        }
      />,
    );
    expect(
      container.querySelector('[data-testid="skill-read-detail-add"]'),
    ).toBeNull();
    const ctas = container.querySelectorAll<HTMLButtonElement>(
      '[data-testid="detail-primary-cta"]',
    );
    expect(ctas).toHaveLength(1);
    expect(container.querySelectorAll('.bg-accent')).toHaveLength(1);
    const share = container.querySelector(
      '[data-testid="skill-read-detail-share"]',
    );
    expect(
      share
        ? share.compareDocumentPosition(ctas[0]) &
            Node.DOCUMENT_POSITION_FOLLOWING
        : 0,
    ).toBeTruthy();
    act(() => ctas[0].click());
    expect(onTry).toHaveBeenCalledTimes(1);
    expect(onAdd).not.toHaveBeenCalled();
    act(() => root.unmount());
  });

  it('renders Share and Delete/Remove only when the host supplies them', () => {
    const onShare = jest.fn();
    const onRemove = jest.fn();
    const { container, root } = mount(
      <SkillReadDetail
        skill={{ sourceId: 'custom:app', name: 'example' }}
        content={content}
        files={[]}
        loading={false}
        error=""
        readFile={emptyRead}
        shareAction={{ status: 'shareable', onShare }}
        onRemove={onRemove}
        removeKind="delete"
      />,
    );
    const share = container.querySelector<HTMLButtonElement>(
      '[data-testid="skill-read-detail-share"]',
    );
    const remove = container.querySelector<HTMLButtonElement>(
      '[data-testid="skill-read-detail-remove"]',
    );
    expect(share?.textContent).toBe('Share');
    expect(remove?.textContent).toBe('Delete');
    act(() => share?.click());
    act(() => remove?.click());
    expect(onShare).toHaveBeenCalledTimes(1);
    expect(onRemove).toHaveBeenCalledTimes(1);

    act(() =>
      root.render(
        <SkillReadDetail
          skill={{ sourceId: 'github:owner:repo', name: 'example' }}
          content={content}
          files={[]}
          loading={false}
          error=""
          readFile={emptyRead}
          onRemove={onRemove}
          removePending
        />,
      ),
    );
    expect(
      container.querySelector('[data-testid="skill-read-detail-share"]'),
    ).toBeNull();
    const pendingRemove = container.querySelector<HTMLButtonElement>(
      '[data-testid="skill-read-detail-remove"]',
    );
    expect(pendingRemove?.textContent).toBe('Remove');
    expect(pendingRemove?.disabled).toBe(true);

    act(() =>
      root.render(
        <SkillReadDetail
          skill={{ sourceId: 'builtin:app', name: 'example' }}
          content={content}
          files={[]}
          loading={false}
          error=""
          readFile={emptyRead}
        />,
      ),
    );
    expect(
      container.querySelector('[data-testid="skill-read-detail-remove"]'),
    ).toBeNull();
    act(() => root.unmount());
  });

  describe('Edit with AI (CAN-1259)', () => {
    const editWithAISelector = '[data-testid="skill-read-detail-edit-with-ai"]';

    function renderWith(
      editWithAI: Parameters<typeof SkillReadDetail>[0]['editWithAI'],
      extra: { onShare?: () => void } = {},
    ): { container: HTMLDivElement; root: Root } {
      return mount(
        <SkillReadDetail
          skill={{ sourceId: 'custom:app', name: 'example' }}
          content={content}
          files={[]}
          loading={false}
          error=""
          readFile={emptyRead}
          onEdit={() => {}}
          shareAction={
            extra.onShare
              ? { status: 'shareable', onShare: extra.onShare }
              : undefined
          }
          editWithAI={editWithAI}
        />,
      );
    }

    it('is absent when the host offers no Edit with AI', () => {
      const { container, root } = renderWith(undefined);
      expect(container.querySelector(editWithAISelector)).toBeNull();
      act(() => root.unmount());
    });

    it('starts the edit when available, first among the actions', () => {
      const onSelect = jest.fn();
      const { container, root } = renderWith(
        { available: true, onSelect },
        { onShare: () => {} },
      );
      const button =
        container.querySelector<HTMLButtonElement>(editWithAISelector);
      expect(button?.textContent).toBe('Edit with AI');
      expect(button?.getAttribute('aria-disabled')).toBeNull();
      const labels = Array.from(
        container.querySelectorAll<HTMLButtonElement>('button'),
      ).map((node) => node.textContent);
      expect(labels.indexOf('Edit with AI')).toBe(0);
      // The shared bar keeps Share immediately before the primary action.
      expect(labels).toEqual(['Edit with AI', 'Edit', 'Share']);
      act(() => button?.click());
      expect(onSelect).toHaveBeenCalledTimes(1);
      act(() => root.unmount());
    });

    it('stays focusable but inert while pending', () => {
      const onSelect = jest.fn();
      const { container, root } = renderWith({
        available: true,
        onSelect,
        pending: true,
      });
      const button =
        container.querySelector<HTMLButtonElement>(editWithAISelector);
      expect(button?.getAttribute('aria-disabled')).toBe('true');
      expect(button?.getAttribute('aria-busy')).toBe('true');
      act(() => button?.click());
      expect(onSelect).not.toHaveBeenCalled();
      act(() => root.unmount());
    });

    it('explains why the skill cannot be edited and does nothing', () => {
      const { container, root } = renderWith({
        available: false,
        reason: 'Built-in skills are read-only.',
      });
      const button =
        container.querySelector<HTMLButtonElement>(editWithAISelector);
      expect(button?.disabled).toBe(false);
      expect(button?.getAttribute('aria-disabled')).toBe('true');
      const describedBy = button?.getAttribute('aria-describedby') ?? '';
      expect(describedBy).not.toBe('');
      const description = describedBy
        .split(' ')
        .map(
          (id) =>
            Array.from(container.querySelectorAll('[id]')).find(
              (node) => node.id === id,
            )?.textContent ?? '',
        )
        .join(' ');
      expect(description).toContain('Built-in skills are read-only.');
      act(() => root.unmount());
    });
  });

  describe('update controls (CAN-4264)', () => {
    type UpdateAction = Parameters<typeof SkillReadDetail>[0]['updateAction'];
    const header = {
      title: 'Example',
      description: 'Example description',
      meta: ['owner/repo', 'Updated Sep 2, 2026'],
    };

    function renderWith(
      updateAction: UpdateAction,
      options: { header?: boolean; notice?: JSX.Element } = {},
    ): { container: HTMLDivElement; root: Root } {
      return mount(
        <SkillReadDetail
          skill={{ sourceId: 'github:owner:repo', name: 'example' }}
          {...(options.header === false ? {} : { header })}
          notice={options.notice}
          content={content}
          files={[]}
          loading={false}
          error=""
          readFile={emptyRead}
          onEdit={() => {}}
          onRemove={() => {}}
          editWithAI={{ available: true, onSelect: () => {} }}
          shareAction={{ status: 'shareable', onShare: () => {} }}
          updateAction={updateAction}
        />,
      );
    }

    function openMore(container: HTMLElement): HTMLElement {
      act(() =>
        container
          .querySelector<HTMLButtonElement>(
            '[data-testid="skill-read-detail-more"]',
          )
          ?.click(),
      );
      const menu = document.querySelector<HTMLElement>(
        '[data-testid="skill-read-detail-menu"]',
      );
      if (!menu) throw new Error('More menu did not open');
      return menu;
    }

    function ready(
      overrides: Partial<Extract<UpdateAction, { status: 'ready' }>> = {},
    ): Extract<UpdateAction, { status: 'ready' }> {
      return {
        status: 'ready',
        updateAvailable: false,
        pending: 'none',
        onCheck: (): void => {},
        onApply: (): void => {},
        ...overrides,
      };
    }

    it('offers no check when the host supplies no update action', () => {
      const { container, root } = renderWith(undefined);
      const menu = openMore(container);
      expect(
        menu.querySelector('[data-testid="skill-read-detail-check-updates"]'),
      ).toBeNull();
      act(() => root.unmount());
    });

    it('lays out the header: one row of actions, the rest in More', () => {
      const onCheck = jest.fn();
      const { container, root } = renderWith(ready({ onCheck }));
      const headerNode = container.querySelector(
        '[data-testid="skill-read-detail-header"]',
      );
      expect(headerNode?.querySelector('h1')?.textContent).toBe('Example');
      expect(
        container.querySelector('[data-testid="skill-read-detail-header-meta"]')
          ?.textContent,
      ).toBe('owner/repo·Updated Sep 2, 2026');
      const labels = Array.from(
        container.querySelectorAll<HTMLButtonElement>(
          '[data-testid="skill-read-detail-header-actions"] button',
        ),
      ).map((node) => node.getAttribute('aria-label') ?? node.textContent);
      // At most three visible actions beside More (CAN-4261): Edit, Share
      // and the primary; Edit with AI joins the menu.
      expect(labels).toEqual([
        'More actions for Example',
        'Edit',
        'Share example',
      ]);
      const menu = openMore(container);
      const items = Array.from(
        menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'),
      ).map((node) => node.textContent);
      expect(items).toEqual(['Check for updates', 'Edit with AI', 'Remove']);
      expect(
        menu.querySelector(
          '[data-testid="skill-read-detail-edit-with-ai"] svg',
        ),
      ).not.toBeNull();
      act(() =>
        menu
          .querySelector<HTMLButtonElement>(
            '[data-testid="skill-read-detail-check-updates"]',
          )
          ?.click(),
      );
      expect(onCheck).toHaveBeenCalledTimes(1);
      act(() => root.unmount());
    });

    // CAN-3119: SKILL.md frontmatter is file content. The header shows the
    // description and version, so they keep the session-replay block.
    it('blocks the header description and version in session replay', () => {
      const { container, root } = mount(
        <SkillReadDetail
          skill={{ sourceId: 'github:owner:repo', name: 'example' }}
          header={{
            title: 'Example',
            description: 'Example description',
            meta: ['owner/repo'],
            version: 'v1.2',
          }}
          content={content}
          files={[]}
          loading={false}
          error=""
          readFile={emptyRead}
        />,
      );
      const description = container.querySelector(
        '[data-testid="skill-read-detail-header-description"]',
      );
      expect(description?.textContent).toBe('Example description');
      expect(
        description?.querySelector(`.${REPLAY_BLOCK_CLASS}`) ??
          description?.closest(`.${REPLAY_BLOCK_CLASS}`),
      ).not.toBeNull();
      const meta = container.querySelector(
        '[data-testid="skill-read-detail-header-meta"]',
      );
      expect(
        Array.from(meta?.querySelectorAll(`.${REPLAY_BLOCK_CLASS}`) ?? []).map(
          (node) => node.textContent,
        ),
      ).toEqual(['v1.2']);
      // The title and actions stay recorded.
      expect(
        container
          .querySelector('[data-testid="skill-read-detail-header-title"]')
          ?.closest(`.${REPLAY_BLOCK_CLASS}`),
      ).toBeNull();
      act(() => root.unmount());
    });

    it('keeps the page title the dominant heading', () => {
      const render = (
        body: string,
      ): { container: HTMLDivElement; root: Root } =>
        mount(
          <SkillReadDetail
            skill={{ sourceId: 'github:owner:repo', name: 'release-notes' }}
            header={{ title: 'Release Notes' }}
            content={{ frontmatter: {}, body }}
            files={[]}
            loading={false}
            error=""
            readFile={emptyRead}
          />,
        );
      const bodyHeadings = (container: HTMLElement): string[] =>
        Array.from(container.querySelectorAll('h1, h2, h3'))
          .filter(
            (node) => !node.closest('[data-testid="skill-read-detail-header"]'),
          )
          .map((node) => `${node.tagName}:${node.textContent}`);

      // A leading H1 repeating the skill's name is not shown again.
      const repeated = render('# Release notes\n\nVersion 1.2\n\n## Steps');
      expect(bodyHeadings(repeated.container)).toEqual(['H2:Steps']);
      expect(repeated.container.textContent).toContain('Version 1.2');
      act(() => repeated.root.unmount());

      // Any other H1 sits under the page's H1, no larger than body text.
      const other = render('# Overview\n\nText');
      expect(bodyHeadings(other.container)).toEqual(['H2:Overview']);
      const heading = other.container.querySelector('h2');
      expect(heading?.className).toContain('text-m');
      act(() => other.root.unmount());
    });

    it('drops a leading body paragraph that repeats the description', () => {
      const render = (
        body: string,
      ): { container: HTMLDivElement; root: Root } =>
        mount(
          <SkillReadDetail
            skill={{ sourceId: 'custom:app', name: 'review-checklist' }}
            header={{
              title: 'Review Checklist',
              description: 'Walks a pull request through the team checklist',
            }}
            content={{ frontmatter: {}, body }}
            files={[]}
            loading={false}
            error=""
            readFile={emptyRead}
          />,
        );
      const bodyText = (container: HTMLElement): string =>
        container.querySelector('[data-testid="skill-read-detail"]')
          ?.textContent ?? '';
      const repeated = render(
        '# review-checklist\n\nWalks a pull request through the team checklist.\n\nStep one',
      );
      // The header shows the description once; the body starts after it.
      expect(
        bodyText(repeated.container).match(/Walks a pull request/g),
      ).toHaveLength(1);
      expect(bodyText(repeated.container)).toContain('Step one');
      act(() => repeated.root.unmount());

      // A body that only repeated the header leaves no empty-state note.
      const onlyRepeated = render(
        '# review-checklist\n\nWalks a pull request through the team checklist.',
      );
      expect(bodyText(onlyRepeated.container)).not.toContain(
        'This skill has no content.',
      );
      act(() => onlyRepeated.root.unmount());

      const different = render('Explains the review steps.\n\nStep one');
      expect(bodyText(different.container)).toContain(
        'Explains the review steps.',
      );
      act(() => different.root.unmount());
    });

    it('drops what a host page header already shows, without a second header', () => {
      const { container, root } = mount(
        <SkillReadDetail
          skill={{ sourceId: 'share', name: 'Marketplace research helper' }}
          hostHeader={{
            title: 'Marketplace research helper',
            description: 'Summarize the research findings',
          }}
          content={{
            frontmatter: {
              name: 'Marketplace research helper',
              description: 'Summarize the research findings',
            },
            body: 'Summarize the research findings\n\nCite the sources.',
          }}
          files={[]}
          loading={false}
          error=""
          readFile={emptyRead}
        />,
      );
      // The frontmatter card labels each fact with its literal key.
      const frontmatterKeys = Array.from(
        container.querySelectorAll('dt'),
        (term) => term.textContent,
      );
      expect(frontmatterKeys).not.toContain('name');
      expect(frontmatterKeys).not.toContain('description');
      expect(container.textContent).not.toContain('Summarize the research');
      expect(container.textContent).toContain('Cite the sources.');
      expect(
        container.querySelector('[data-testid="skill-read-detail-header"]'),
      ).toBeNull();
      act(() => root.unmount());
    });

    it('offers Edit with AI in More, with its reason when unavailable', () => {
      const { container, root } = mount(
        <SkillReadDetail
          skill={{ sourceId: 'builtin:app', name: 'canopy-config' }}
          header={{ title: 'Canopy Config' }}
          content={content}
          files={[]}
          loading={false}
          error=""
          readFile={emptyRead}
          editWithAI={{
            available: false,
            reason: 'Built-in skills are read-only.',
          }}
        />,
      );
      expect(
        container.querySelector(
          '[data-testid="skill-read-detail-header-actions"] [data-testid="skill-read-detail-edit-with-ai"]',
        ),
      ).toBeNull();
      const menu = openMore(container);
      const item = menu.querySelector<HTMLButtonElement>(
        '[data-testid="skill-read-detail-edit-with-ai"]',
      );
      expect(
        item?.getAttribute('aria-disabled') ?? item?.disabled,
      ).toBeTruthy();
      expect(menu.textContent).toContain('Built-in skills are read-only.');
      expect(item?.querySelector('svg')).not.toBeNull();
      act(() => root.unmount());
    });

    it('drops the name and description card the header already shows', () => {
      const { container, root } = renderWith(ready());
      // The frontmatter card labels each fact with its literal key.
      const frontmatterKeys = Array.from(
        container.querySelectorAll('dt'),
        (term) => term.textContent,
      );
      expect(frontmatterKeys).not.toContain('name');
      expect(frontmatterKeys).not.toContain('description');
      expect(container.textContent).toContain('Main instructions');
      act(() => root.unmount());
    });

    it('shows an available update as one notice with Update', () => {
      const onApply = jest.fn();
      const { container, root } = renderWith(
        ready({ updateAvailable: true, onApply }),
      );
      const notice = container.querySelector(
        '[data-testid="skill-update-notice"]',
      );
      expect(notice?.getAttribute('data-state')).toBe('available');
      act(() =>
        container
          .querySelector<HTMLButtonElement>(
            '[data-testid="skill-read-detail-apply-update"]',
          )
          ?.click(),
      );
      expect(onApply).toHaveBeenCalledTimes(1);
      act(() => root.unmount());
    });

    it('lets the host failure take the notice slot over an update', () => {
      const { container, root } = renderWith(ready({ updateAvailable: true }), {
        notice: <p data-testid="host-failure">Couldn't open the chat.</p>,
      });
      expect(
        container.querySelector('[data-testid="host-failure"]'),
      ).not.toBeNull();
      expect(
        container.querySelector('[data-testid="skill-update-notice"]'),
      ).toBeNull();
      act(() => root.unmount());
    });

    it('reports checking and a checked skill in the meta line', () => {
      const checking = renderWith(ready({ pending: 'checking' }));
      expect(
        checking.container.querySelector('[data-testid="skill-update-status"]')
          ?.textContent,
      ).toBe('Checking for updates…');
      const menu = openMore(checking.container);
      expect(
        menu
          .querySelector('[data-testid="skill-read-detail-check-updates"]')
          ?.hasAttribute('disabled'),
      ).toBe(true);
      act(() => checking.root.unmount());

      const checked = renderWith(ready({ checkedAt: Date.now() }));
      expect(
        checked.container.querySelector('[data-testid="skill-update-status"]')
          ?.textContent,
      ).toBe('Up to date·Checked just now');
      act(() => checked.root.unmount());

      // A cached "no update known" claims nothing.
      const cached = renderWith(ready());
      expect(
        cached.container.querySelector('[data-testid="skill-update-status"]'),
      ).toBeNull();
      act(() => cached.root.unmount());
    });

    it('keeps the legacy action bar without a header', () => {
      const { container, root } = mount(
        <SkillReadDetail
          skill={{ sourceId: 'github:owner:repo', name: 'example' }}
          content={content}
          files={[]}
          loading={false}
          error=""
          readFile={emptyRead}
          updateAction={{
            status: 'blocked',
            updateAvailable: true,
            reason: 'Check for and apply skill updates from the desktop app.',
          }}
        />,
      );
      expect(
        container.querySelector('[data-testid="skill-read-detail-header"]'),
      ).toBeNull();
      expect(
        container
          .querySelector('[data-testid="skill-update-notice"]')
          ?.getAttribute('data-state'),
      ).toBe('blocked');
      const menu = openMore(container);
      const check = menu.querySelector(
        '[data-testid="skill-read-detail-check-updates"]',
      );
      expect(check?.hasAttribute('disabled')).toBe(true);
      expect(menu.textContent).toContain(
        'Check for and apply skill updates from the desktop app.',
      );
      act(() => root.unmount());
    });
  });
});
