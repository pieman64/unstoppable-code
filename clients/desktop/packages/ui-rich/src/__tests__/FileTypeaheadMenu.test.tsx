/**
 * @jest-environment jsdom
 */
Object.defineProperty(globalThis, 'IS_REACT_ACT_ENVIRONMENT', {
  configurable: true,
  value: true,
});

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { FileTypeaheadMenu } from '../editor/FileTypeaheadMenu';
import type { FileMentionOption } from '../types';

const file = (
  repoId: string,
  repoName: string,
  filename: string,
): FileMentionOption => ({
  repoId,
  repoName,
  relativePath: filename,
  filename,
  absolutePath: `/workspace/${filename}`,
});

describe('FileTypeaheadMenu', () => {
  let container: HTMLElement;
  let root: Root;

  beforeAll(() => {
    Element.prototype.scrollIntoView = jest.fn();
  });

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  function render(files: FileMentionOption[], isMultiRepo = false): void {
    act(() => {
      root.render(
        <FileTypeaheadMenu
          files={files}
          selectedIndex={0}
          isMultiRepo={isMultiRepo}
          isLoading={false}
          onSelect={(): void => undefined}
        />,
      );
    });
  }

  function sectionHeaders(): string[] {
    return Array.from(
      container.querySelectorAll<HTMLElement>(
        '[data-testid="file-typeahead-section-header"]',
      ),
      (element) => element.textContent ?? '',
    );
  }

  it('labels each section when single-repo files are mixed with non-file mentions', () => {
    render([
      file('repo-1', 'Workspace', 'README.md'),
      file('canopy:prompts', 'Prompts', 'Review'),
      file('canopy:attachments', 'Attachments', 'brief.pdf'),
      file('canopy:notes', 'Notes', 'Decisions'),
    ]);

    expect(sectionHeaders()).toEqual([
      'Workspace',
      'Prompts',
      'Attachments',
      'Notes',
    ]);
    expect(container.querySelectorAll('[role="option"]')).toHaveLength(4);
  });

  it('keeps a single result group headerless unless multi-repo mode is enabled', () => {
    const files = [file('repo-1', 'Workspace', 'README.md')];

    render(files);
    expect(sectionHeaders()).toEqual([]);

    render(files, true);
    expect(sectionHeaders()).toEqual(['Workspace']);
  });
});
