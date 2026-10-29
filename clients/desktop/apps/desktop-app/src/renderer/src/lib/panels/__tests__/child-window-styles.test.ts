/** @jest-environment jsdom */
import type { IDisposable } from '@canopy/ui-shared/panels';
import {
  mirrorHtmlAttributesInto,
  mirrorStylesheetsInto,
} from '../child-window-styles';

/** Flushes MutationObserver microtask delivery. */
async function flushMutations(): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

function createChildDocument(): Document {
  return document.implementation.createHTMLDocument('child');
}

function childStyleTexts(child: Document): (string | null)[] {
  return Array.from(child.head.querySelectorAll('style')).map(
    (style) => style.textContent,
  );
}

describe('child-window-styles', () => {
  const disposables: IDisposable[] = [];
  const openerNodes: Element[] = [];

  const addOpenerHeadNode = <T extends Element>(node: T): T => {
    document.head.appendChild(node);
    openerNodes.push(node);
    return node;
  };

  afterEach(() => {
    for (const disposable of disposables.splice(0)) {
      disposable.dispose();
    }
    for (const node of openerNodes.splice(0)) {
      node.remove();
    }
    for (const attribute of ['class', 'data-theme', 'data-ui-scale', 'style']) {
      document.documentElement.removeAttribute(attribute);
    }
  });

  describe('mirrorStylesheetsInto', () => {
    it('clones existing <style> and <link rel="stylesheet"> nodes into the child head', () => {
      const style = document.createElement('style');
      style.textContent = '.a { color: red; }';
      addOpenerHeadNode(style);

      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = '/assets/index.css';
      addOpenerHeadNode(link);

      // A non-stylesheet head node must not be mirrored.
      const meta = document.createElement('meta');
      meta.name = 'ignored';
      addOpenerHeadNode(meta);

      const child = createChildDocument();
      disposables.push(mirrorStylesheetsInto(child));

      expect(childStyleTexts(child)).toEqual(['.a { color: red; }']);

      const clonedLinks = Array.from(
        child.head.querySelectorAll('link[rel="stylesheet"]'),
      );
      expect(clonedLinks).toHaveLength(1);
      // The clone carries the opener's RESOLVED absolute URL, because the
      // about:blank child has no usable base URL for relative hrefs.
      expect(clonedLinks[0].getAttribute('href')).toBe(link.href);
      expect(child.head.querySelectorAll('meta')).toHaveLength(0);
    });

    it('mirrors stylesheets added to the opener head after setup', async () => {
      const child = createChildDocument();
      disposables.push(mirrorStylesheetsInto(child));

      expect(childStyleTexts(child)).toEqual([]);

      const style = document.createElement('style');
      style.textContent = '.later { display: none; }';
      addOpenerHeadNode(style);
      await flushMutations();

      expect(childStyleTexts(child)).toEqual(['.later { display: none; }']);
    });

    it('propagates <style> text changes (Vite HMR pattern) to the clone', async () => {
      const style = document.createElement('style');
      style.textContent = '.hmr { color: red; }';
      addOpenerHeadNode(style);

      const child = createChildDocument();
      disposables.push(mirrorStylesheetsInto(child));

      style.textContent = '.hmr { color: blue; }';
      await flushMutations();

      expect(childStyleTexts(child)).toEqual(['.hmr { color: blue; }']);
    });

    it('removes the clone when the opener stylesheet is removed', async () => {
      const style = document.createElement('style');
      style.textContent = '.gone { opacity: 0; }';
      addOpenerHeadNode(style);

      const child = createChildDocument();
      disposables.push(mirrorStylesheetsInto(child));
      expect(childStyleTexts(child)).toEqual(['.gone { opacity: 0; }']);

      style.remove();
      await flushMutations();

      expect(childStyleTexts(child)).toEqual([]);
    });

    it('dispose stops mirroring later additions', async () => {
      const child = createChildDocument();
      const disposable = mirrorStylesheetsInto(child);
      disposable.dispose();

      const style = document.createElement('style');
      style.textContent = '.after-dispose {}';
      addOpenerHeadNode(style);
      await flushMutations();

      expect(childStyleTexts(child)).toEqual([]);
    });
  });

  describe('mirrorHtmlAttributesInto', () => {
    it('copies the theme-bearing <html> attributes on setup', () => {
      document.documentElement.setAttribute('class', 'dark');
      document.documentElement.setAttribute('data-theme', 'ocean');
      document.documentElement.setAttribute('data-ui-scale', '125');
      document.documentElement.setAttribute('data-scrollbar-behavior', 'never');
      document.documentElement.setAttribute('style', 'color-scheme: dark;');

      const child = createChildDocument();
      disposables.push(mirrorHtmlAttributesInto(child));

      const to = child.documentElement;
      expect(to.getAttribute('class')).toBe('dark');
      expect(to.getAttribute('data-theme')).toBe('ocean');
      expect(to.getAttribute('data-ui-scale')).toBe('125');
      expect(to.getAttribute('data-scrollbar-behavior')).toBe('never');
      expect(to.getAttribute('style')).toBe('color-scheme: dark;');
      // Themed surface defaults for the child body (spike pattern).
      expect(child.body.style.margin).toBe('0px');
      expect(child.body.style.background).toBe('var(--bg-base)');
      expect(child.body.style.color).toBe('var(--fg-primary)');
    });

    it('propagates later attribute changes, including removals', async () => {
      document.documentElement.setAttribute('data-theme', 'ocean');

      const child = createChildDocument();
      disposables.push(mirrorHtmlAttributesInto(child));

      document.documentElement.setAttribute('data-theme', 'retro');
      document.documentElement.setAttribute('class', 'dark');
      await flushMutations();

      expect(child.documentElement.getAttribute('data-theme')).toBe('retro');
      expect(child.documentElement.getAttribute('class')).toBe('dark');

      document.documentElement.removeAttribute('data-theme');
      await flushMutations();

      expect(child.documentElement.getAttribute('data-theme')).toBeNull();
    });

    it('dispose stops attribute propagation', async () => {
      document.documentElement.setAttribute('data-theme', 'ocean');

      const child = createChildDocument();
      const disposable = mirrorHtmlAttributesInto(child);
      disposable.dispose();

      document.documentElement.setAttribute('data-theme', 'retro');
      await flushMutations();

      expect(child.documentElement.getAttribute('data-theme')).toBe('ocean');
    });
  });
});
