import {
  AGENT_VISUAL_THEME_VARIABLES,
  sanitizeAgentVisualTheme,
  type AgentVisualTheme,
} from '../../lib/agent-visual-html';

type FrameEntry = {
  element: HTMLElement;
  /** Admitted before other frames: an expanded visual or a panel entry. */
  prioritized: boolean;
  intersecting: boolean;
  allowed: boolean;
  notify: (intersecting: boolean, allowed: boolean) => void;
};

type Registry = {
  entries: Set<FrameEntry>;
  observer: IntersectionObserver | null;
  theme: AgentVisualTheme;
  themeListeners: Set<() => void>;
  themeObserver: MutationObserver | null;
  media: MediaQueryList | null;
  refreshTheme: () => void;
};

const registries = new WeakMap<Document, Registry>();

function readTheme(ownerDocument: Document): AgentVisualTheme {
  const view = ownerDocument.defaultView;
  if (!view) return { appearance: 'light', variables: {} };
  const styles = view.getComputedStyle(ownerDocument.documentElement);
  const variables: Record<string, string> = {};
  for (const name of AGENT_VISUAL_THEME_VARIABLES) {
    const value = styles.getPropertyValue(name).trim();
    if (value) variables[name] = value;
  }
  // Both hosts mark the app's resolved theme with the `dark` class on the
  // root (Tailwind's class variant), including when it follows the system;
  // an explicit `color-scheme` is the fallback. The system preference alone
  // never decides, because the app can be light while the system is dark.
  const scheme = styles.colorScheme;
  const appearance =
    ownerDocument.documentElement.classList.contains('dark') ||
    (scheme.includes('dark') && !scheme.includes('light'))
      ? 'dark'
      : 'light';
  return sanitizeAgentVisualTheme({ appearance, variables });
}

function distanceFromViewport(entry: FrameEntry, view: Window): number {
  const rect = entry.element.getBoundingClientRect();
  if (rect.bottom < 0) return -rect.bottom;
  if (rect.top > view.innerHeight) return rect.top - view.innerHeight;
  return 0;
}

function updateBudget(ownerDocument: Document, registry: Registry): void {
  const view = ownerDocument.defaultView;
  const candidates = [...registry.entries].filter(
    (entry) => entry.intersecting,
  );
  candidates.sort((left, right) => {
    if (left.prioritized !== right.prioritized)
      return left.prioritized ? -1 : 1;
    if (!view) return 0;
    return distanceFromViewport(left, view) - distanceFromViewport(right, view);
  });
  const permitted = new Set(candidates.slice(0, 6));
  for (const entry of registry.entries) {
    const allowed = permitted.has(entry);
    if (entry.allowed !== allowed) {
      entry.allowed = allowed;
      entry.notify(entry.intersecting, allowed);
    }
  }
}

function getRegistry(ownerDocument: Document): Registry {
  const existing = registries.get(ownerDocument);
  if (existing) return existing;
  const registry: Registry = {
    entries: new Set(),
    observer: null,
    theme: readTheme(ownerDocument),
    themeListeners: new Set(),
    themeObserver: null,
    media: null,
    refreshTheme: () => {
      const next = readTheme(ownerDocument);
      if (JSON.stringify(next) !== JSON.stringify(registry.theme)) {
        registry.theme = next;
        for (const listener of registry.themeListeners) listener();
      }
    },
  };
  registries.set(ownerDocument, registry);
  return registry;
}

/** The registry outlives its observer, so the first visual after the last one
 * unmounted creates a new observer. */
function ensureObserver(ownerDocument: Document, registry: Registry): void {
  const view = ownerDocument.defaultView;
  if (
    !registry.observer &&
    view &&
    typeof view.IntersectionObserver === 'function'
  ) {
    registry.observer = new view.IntersectionObserver(
      (records) => {
        for (const record of records) {
          for (const entry of registry.entries) {
            if (entry.element === record.target) {
              entry.intersecting = record.isIntersecting;
              entry.notify(entry.intersecting, entry.allowed);
            }
          }
        }
        updateBudget(ownerDocument, registry);
      },
      { rootMargin: '600px' },
    );
  }
}

export function observeAgentVisualFrame(
  ownerDocument: Document,
  element: HTMLElement,
  prioritized: boolean,
  notify: (intersecting: boolean, allowed: boolean) => void,
): () => void {
  const registry = getRegistry(ownerDocument);
  ensureObserver(ownerDocument, registry);
  const entry: FrameEntry = {
    element,
    prioritized,
    intersecting: registry.observer === null,
    allowed: false,
    notify,
  };
  registry.entries.add(entry);
  registry.observer?.observe(element);
  updateBudget(ownerDocument, registry);
  notify(entry.intersecting, entry.allowed);
  return () => {
    registry.observer?.unobserve(element);
    registry.entries.delete(entry);
    updateBudget(ownerDocument, registry);
    if (registry.entries.size === 0) {
      registry.observer?.disconnect();
      registry.observer = null;
    }
  };
}

export function subscribeAgentVisualTheme(
  ownerDocument: Document,
  listener: () => void,
): () => void {
  const registry = getRegistry(ownerDocument);
  registry.themeListeners.add(listener);
  if (registry.themeListeners.size === 1) {
    const view = ownerDocument.defaultView;
    if (view && typeof view.MutationObserver === 'function') {
      registry.themeObserver = new view.MutationObserver(registry.refreshTheme);
      registry.themeObserver.observe(ownerDocument.documentElement, {
        attributes: true,
      });
    }
    registry.media = view?.matchMedia?.('(prefers-color-scheme: dark)') ?? null;
    registry.media?.addEventListener('change', registry.refreshTheme);
    // Nothing observed the theme while unsubscribed; catch up before use.
    registry.refreshTheme();
  }
  return () => {
    registry.themeListeners.delete(listener);
    if (registry.themeListeners.size === 0) {
      registry.themeObserver?.disconnect();
      registry.themeObserver = null;
      registry.media?.removeEventListener('change', registry.refreshTheme);
      registry.media = null;
    }
  };
}

export function getAgentVisualTheme(ownerDocument: Document): AgentVisualTheme {
  return getRegistry(ownerDocument).theme;
}
