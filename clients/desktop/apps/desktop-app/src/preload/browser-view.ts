/**
 * The browser view's preload, in each top document's isolated world. Agent
 * snapshots, inspect, waits and actions run on the host's CDP page model
 * (phase 04); this keeps what the page model asks of the page and what the
 * user drives: the document-start tracker and its witness, the password
 * history and inspect bridges, trusted-input reports, pick mode and
 * recording.
 */
import { ipcRenderer, webFrame } from 'electron';
import {
  encodeTrackerWitness,
  mainWorldTrackerSource,
  TRACKER_WITNESS_RESOLVER_KEY,
  trackerKeyFromBytes,
  type TrackerWitness,
} from '@canopy/desktop-shared/browser/page-trackers';
import {
  classifySecretField,
  INSPECT_RESOLVER_KEY,
  PASSWORD_HISTORY_RESOLVER_KEY,
} from '@canopy/desktop-shared/browser/secret-fields';
import type {
  BrowserElementSnapshot,
  BrowserLocatorCandidate,
  BrowserRectangle,
  BrowserRecordingStep,
} from '@canopy/desktop-shared/types';

/**
 * The main-world password-history tracker of this top document (phase 04b
 * E4), asked for at document start: the first document of a new view
 * included, which the host's CDP-registered scripts miss (the view has no
 * renderer until it first navigates). The key is this document's own. The
 * witness tells the host whether this ran before the document had content
 * and under which key; the tracker itself still refuses to install late.
 */
function installMainWorldTracker(): TrackerWitness {
  if (document.documentElement !== null) return { early: false };
  const key = trackerKeyFromBytes(crypto.getRandomValues(new Uint8Array(16)));
  try {
    void webFrame
      .executeJavaScript(mainWorldTrackerSource(key, { documents: 'top' }))
      .catch(() => undefined);
  } catch {
    return { early: false };
  }
  return { early: true, key };
}

const trackerWitness = encodeTrackerWitness(installMainWorldTracker());

Reflect.defineProperty(globalThis, TRACKER_WITNESS_RESOLVER_KEY, {
  configurable: true,
  enumerable: false,
  writable: false,
  value: (): string => trackerWitness,
});

const COMMAND_CHANNEL = 'canopy-browser-view:command';
const RESULT_CHANNEL = 'canopy-browser-view:result';
const EVENT_CHANNEL = 'canopy-browser-view:event';
const TEST_ID_ATTRIBUTES = ['data-testid', 'data-test', 'data-cy'];

/** The commands the host sends: pick mode and recording. */
interface BrowserPreloadCommand {
  requestId: string;
  type: 'setPickMode' | 'setRecording';
  payload: unknown;
}

interface CommandPayload {
  browserId?: string;
  enabled?: boolean;
}

const REDACTED_VALUE = '[redacted]';
const FORM_CONTROL_SELECTOR = 'input, textarea, select';
const previouslyPasswordInputs = new WeakSet<HTMLInputElement>();
function rememberRemovedPasswords(node: Node | null): void {
  if (node instanceof HTMLInputElement) {
    if (node.type === 'password') previouslyPasswordInputs.add(node);
  } else if (node instanceof Element) {
    const inputs = node.getElementsByTagName('input');
    for (let index = 0; index < inputs.length; index += 1) {
      const input = inputs.item(index);
      if (input instanceof HTMLInputElement && input.type === 'password') {
        previouslyPasswordInputs.add(input);
      }
    }
  }
}
// Same-task removal/retype, including a microtask before this callback,
// retains the transient observer's old type=password record in browsers.
// A later-task retype follows this callback, which remembers the removal.
// Per record: O(1) attribute work + O(removed nodes + returned inputs),
// plus native descendant tag lookup cost for removed elements (potentially
// their subtree size). No JS tree walk or added-node/text scanning; shadow
// roots are outside this light-DOM holder's scope.
// Never attached as a password, then inserted as text, is still "never":
// it has no user-typed password from this observed tree to leak.
function rememberPasswordTypeChanges(records: MutationRecord[]): void {
  for (const record of records) {
    if (record.type === 'childList') {
      for (let index = 0; index < record.removedNodes.length; index += 1) {
        rememberRemovedPasswords(record.removedNodes.item(index));
      }
      continue;
    }
    if (
      record.target instanceof HTMLInputElement &&
      record.oldValue?.toLowerCase() === 'password'
    ) {
      previouslyPasswordInputs.add(record.target);
    }
  }
}
const passwordTypeObserver = new MutationObserver(rememberPasswordTypeChanges);
passwordTypeObserver.observe(document, {
  subtree: true,
  childList: true,
  attributes: true,
  attributeFilter: ['type'],
  attributeOldValue: true,
});

function passwordHistoryForElements(...elements: unknown[]): boolean[] {
  rememberPasswordTypeChanges(passwordTypeObserver.takeRecords());
  return elements.map((value): boolean => {
    if (!(value instanceof Element)) return true;
    if (!(value instanceof HTMLInputElement)) return false;
    if (value.type === 'password') previouslyPasswordInputs.add(value);
    return previouslyPasswordInputs.has(value);
  });
}

Reflect.defineProperty(globalThis, PASSWORD_HISTORY_RESOLVER_KEY, {
  configurable: true,
  enumerable: false,
  writable: false,
  value: (...elements: unknown[]): boolean[] =>
    passwordHistoryForElements(...elements),
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isCommandType(value: unknown): value is BrowserPreloadCommand['type'] {
  return value === 'setPickMode' || value === 'setRecording';
}

function decodeCommand(value: unknown): BrowserPreloadCommand | undefined {
  if (
    !isRecord(value) ||
    typeof value.requestId !== 'string' ||
    value.requestId.trim().length === 0 ||
    !isCommandType(value.type)
  ) {
    return undefined;
  }
  return {
    requestId: value.requestId,
    type: value.type,
    payload: value.payload,
  };
}

function payload(value: unknown): CommandPayload {
  if (!isRecord(value)) return {};
  return {
    ...(typeof value.browserId === 'string'
      ? { browserId: value.browserId }
      : {}),
    ...(typeof value.enabled === 'boolean' ? { enabled: value.enabled } : {}),
  };
}

function cssEscape(value: string): string {
  if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
    return CSS.escape(value);
  }
  return value.replace(/["\\#.:,[\]>+~*']/g, '\\$&');
}

/** A single-quoted script literal for `value`, line breaks included. */
function quote(value: string): string {
  const escaped = value
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
  return `'${escaped}'`;
}

function compactText(value: string | null | undefined, max = 120): string {
  return (value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function elementText(element: Element): string {
  return compactText(element.textContent, 120);
}

function labelTextWithoutSecrets(
  element: Element | null,
  omitControls = false,
): string {
  if (!element || hasSecretValue(element)) return '';
  if (!hasSecretDescendant(element)) return compactText(element.textContent);

  const collect = (node: Node): string => {
    if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? '';
    if (!(node instanceof Element)) return '';
    if (
      hasSecretValue(node) ||
      (omitControls && node.matches(FORM_CONTROL_SELECTOR))
    ) {
      return '';
    }
    return Array.from(node.childNodes, collect).join('');
  };
  return compactText(Array.from(element.childNodes, collect).join(''));
}

function accessibleName(element: Element): string {
  const aria = element.getAttribute('aria-label');
  if (aria?.trim()) return compactText(aria);
  const labelledBy = element.getAttribute('aria-labelledby');
  if (labelledBy) {
    const text = labelledBy
      .split(/\s+/)
      .map((id) => labelTextWithoutSecrets(document.getElementById(id)))
      .join(' ');
    if (text.trim()) return compactText(text);
  }
  if (
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLSelectElement
  ) {
    const label = labelTextForControl(element);
    if (label) return label;
  }
  if (hasSecretValue(element) || hasSecretDescendant(element)) return '';
  return compactText(
    element.getAttribute('alt') ??
      element.getAttribute('title') ??
      elementText(element),
  );
}

function roleFor(element: Element): string | undefined {
  const explicit = element.getAttribute('role')?.trim();
  if (explicit) return explicit;
  const tag = element.tagName.toLowerCase();
  if (tag === 'button') return 'button';
  if (tag === 'a' && element.hasAttribute('href')) return 'link';
  if (tag === 'select') return 'combobox';
  if (tag === 'textarea') return 'textbox';
  if (tag === 'input') {
    const type = (element.getAttribute('type') ?? 'text').toLowerCase();
    if (['button', 'submit', 'reset'].includes(type)) return 'button';
    if (type === 'checkbox') return 'checkbox';
    if (type === 'radio') return 'radio';
    if (type === 'search') return 'searchbox';
    if (type === 'number') return 'spinbutton';
    if (type === 'range') return 'slider';
    return 'textbox';
  }
  return undefined;
}

function labelTextForControl(element: Element): string | undefined {
  const id = element.getAttribute('id');
  if (id) {
    const label = document.querySelector(`label[for="${cssEscape(id)}"]`);
    const text = labelTextWithoutSecrets(label, true);
    if (text) return text;
  }
  const wrapping = element.closest('label');
  const text = labelTextWithoutSecrets(wrapping, true);
  return text || undefined;
}

function isUniqueCss(selector: string, element: Element): boolean {
  try {
    const matches = document.querySelectorAll(selector);
    return matches.length === 1 && matches[0] === element;
  } catch {
    return false;
  }
}

function isUniqueText(text: string, element: Element): boolean {
  const matches = Array.from(document.querySelectorAll('*')).filter(
    (candidateElement) => elementText(candidateElement) === text,
  );
  const leafMatches = matches.filter(
    (candidateElement) =>
      !Array.from(candidateElement.children).some(
        (child) => elementText(child) === text,
      ),
  );
  return leafMatches.length === 1 && leafMatches[0] === element;
}

function candidate(
  element: Element,
  candidateValue: Omit<BrowserLocatorCandidate, 'unique' | 'confidence'>,
  selector?: string,
): BrowserLocatorCandidate {
  const unique = selector ? isUniqueCss(selector, element) : false;
  return {
    ...candidateValue,
    unique,
    confidence: unique ? 'high' : 'medium',
  };
}

function uniqueCssSelector(element: Element): string {
  const parts: string[] = [];
  let node: Element | null = element;
  while (node && node !== document.documentElement) {
    const tag = node.tagName.toLowerCase();
    const id = node.getAttribute('id');
    if (id) {
      parts.unshift(`${tag}#${cssEscape(id)}`);
      break;
    }
    const parent: Element | null = node.parentElement;
    if (!parent) break;
    const siblings = Array.from(parent.children).filter(
      (child: Element) => child.tagName === node?.tagName,
    );
    const index = siblings.indexOf(node) + 1;
    parts.unshift(siblings.length > 1 ? `${tag}:nth-of-type(${index})` : tag);
    node = parent;
  }
  const selector = parts.join(' > ');
  return selector || element.tagName.toLowerCase();
}

function domPathSelector(element: Element): string {
  const parts: string[] = [];
  let node: Element | null = element;
  while (node) {
    const tag = node.tagName.toLowerCase();
    const parent: Element | null = node.parentElement;
    if (!parent) {
      parts.unshift(tag);
      break;
    }
    const siblings = Array.from(parent.children).filter(
      (child: Element) => child.tagName === node?.tagName,
    );
    const index = siblings.indexOf(node) + 1;
    parts.unshift(siblings.length > 1 ? `${tag}:nth-of-type(${index})` : tag);
    node = parent;
  }
  return parts.join(' > ');
}

export function generateLocatorCandidates(
  element: Element,
): BrowserLocatorCandidate[] {
  const candidates: BrowserLocatorCandidate[] = [];
  if (isInsideSecretSelect(element)) return [];
  if (hasSecretValue(element) || hasSecretDescendant(element)) {
    // Structural option and group locators reveal indexes in an ordered secret
    // select. Other secret controls can use their own path.
    if (
      element instanceof HTMLOptionElement ||
      element instanceof HTMLOptGroupElement
    )
      return [];
    const css = uniqueCssSelector(element);
    return [
      candidate(
        element,
        { kind: 'css', value: css, playwright: `page.locator(${quote(css)})` },
        css,
      ),
    ];
  }
  for (const attr of TEST_ID_ATTRIBUTES) {
    const value = element.getAttribute(attr);
    if (value?.trim()) {
      const selector = `[${attr}="${cssEscape(value.trim())}"]`;
      candidates.push(
        candidate(
          element,
          {
            kind: 'testId',
            value: value.trim(),
            playwright: `page.getByTestId(${quote(value.trim())})`,
          },
          selector,
        ),
      );
      break;
    }
  }
  const role = roleFor(element);
  const name = accessibleName(element);
  if (role && name) {
    candidates.push({
      kind: 'role',
      value: role,
      name,
      unique: false,
      confidence: 'high',
      playwright: `page.getByRole(${quote(role)}, { name: ${quote(name)} })`,
    });
  }
  const label = labelTextForControl(element);
  if (label) {
    candidates.push({
      kind: 'label',
      value: label,
      unique: false,
      confidence: 'high',
      playwright: `page.getByLabel(${quote(label)})`,
    });
  }
  const placeholder = element.getAttribute('placeholder');
  if (placeholder?.trim()) {
    candidates.push({
      kind: 'placeholder',
      value: placeholder.trim(),
      unique: false,
      confidence: 'high',
      playwright: `page.getByPlaceholder(${quote(placeholder.trim())})`,
    });
  }
  const alt = element.getAttribute('alt');
  if (alt?.trim()) {
    candidates.push({
      kind: 'alt',
      value: alt.trim(),
      unique: false,
      confidence: 'medium',
      playwright: `page.getByAltText(${quote(alt.trim())})`,
    });
  }
  const title = element.getAttribute('title');
  if (title?.trim()) {
    candidates.push(candidate(element, { kind: 'title', value: title.trim() }));
  }
  const id = element.getAttribute('id');
  if (id?.trim()) {
    const selector = `#${cssEscape(id.trim())}`;
    candidates.push(
      candidate(
        element,
        {
          kind: 'css',
          value: selector,
          playwright: `page.locator(${quote(selector)})`,
        },
        selector,
      ),
    );
  }
  const text = elementText(element);
  if (text && text.length <= 80 && isUniqueText(text, element)) {
    candidates.push({
      kind: 'text',
      value: text,
      unique: true,
      confidence: 'high',
      playwright: `page.getByText(${quote(text)})`,
    });
  }
  const css = uniqueCssSelector(element);
  candidates.push(
    candidate(
      element,
      {
        kind: 'css',
        value: css,
        playwright: `page.locator(${quote(css)})`,
      },
      css,
    ),
  );
  const path = domPathSelector(element);
  candidates.push({
    kind: 'domPath',
    value: path,
    unique: isUniqueCss(path, element),
    confidence: 'low',
    playwright: `page.locator(${quote(path)})`,
  });
  return candidates;
}

function rectFor(element: Element): BrowserRectangle {
  const rect = element.getBoundingClientRect();
  return {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
}

function domPath(element: Element): string[] {
  const parts: string[] = [];
  let node: Element | null = element;
  while (node) {
    parts.unshift(node.tagName.toLowerCase());
    node = node.parentElement;
  }
  return parts;
}

/**
 * Passwords, one-time codes, and payment card fields. Their values never
 * leave the page through snapshots, inspection, or recordings.
 */
function hasSecretValue(element: Element): boolean {
  if (element instanceof HTMLInputElement) {
    // Process synchronous reveal toggles before a snapshot or recording event
    // can serialize the field's newly visible value.
    rememberPasswordTypeChanges(passwordTypeObserver.takeRecords());
    if (element.type === 'password') previouslyPasswordInputs.add(element);
  }
  const isFormControl =
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLSelectElement;
  if (hostSecretControls.has(element)) return true;
  return classifySecretField({
    // An SVG or other namespace element can have a tagName such as "input"
    // without being an HTML input; retain the previous instanceof behavior.
    tagName: isFormControl ? element.tagName : '',
    type: element instanceof HTMLInputElement ? element.type : undefined,
    autocomplete: isFormControl
      ? element.getAttribute('autocomplete')
      : undefined,
    insideSecretSelect: isInsideSecretSelect(element),
    everPassword:
      element instanceof HTMLInputElement &&
      previouslyPasswordInputs.has(element),
  });
}

function isInsideSecretSelect(element: Element): boolean {
  const select = element.parentElement?.closest('select');
  return select !== null && select !== undefined && hasSecretValue(select);
}

function hasSecretDescendant(element: Element): boolean {
  return Array.from(element.querySelectorAll(FORM_CONTROL_SELECTOR)).some(
    hasSecretValue,
  );
}

function attributes(element: Element): Record<string, string> {
  const secret = hasSecretValue(element);
  const insideSecretSelect = isInsideSecretSelect(element);
  return Object.fromEntries(
    Array.from(element.attributes)
      .filter(
        (attr) =>
          !(
            secret &&
            element instanceof HTMLOptionElement &&
            attr.name === 'selected'
          ),
      )
      .map((attr) => [
        attr.name,
        secret &&
        (insideSecretSelect ||
          attr.name === 'value' ||
          ((element instanceof HTMLOptionElement ||
            element instanceof HTMLOptGroupElement) &&
            attr.name === 'label'))
          ? REDACTED_VALUE
          : attr.value,
      ]),
  );
}

function redactSecretSelectSubtree(element: Element): void {
  for (const attribute of Array.from(element.attributes)) {
    if (attribute.name === 'selected') element.removeAttribute(attribute.name);
    else element.setAttribute(attribute.name, REDACTED_VALUE);
  }
  for (const child of Array.from(element.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      if (child.textContent?.trim()) child.textContent = REDACTED_VALUE;
    } else if (child instanceof Element) {
      redactSecretSelectSubtree(child);
    }
  }
}

/**
 * Markup for inspection with secret values removed. Frameworks such as React
 * mirror a field's live value into its `value` attribute, so the markup of a
 * secret field, or of a form containing one, would otherwise carry it. The
 * live page is never modified; only a detached copy is rewritten.
 */
function redactedOuterHtml(element: Element): string {
  if (isInsideSecretSelect(element)) {
    const copy = element.cloneNode(true);
    if (!(copy instanceof Element)) return '';
    redactSecretSelectSubtree(copy);
    return copy.outerHTML;
  }
  const controls = [
    element,
    ...Array.from(element.querySelectorAll(FORM_CONTROL_SELECTOR)),
  ];
  if (!controls.some(hasSecretValue)) return element.outerHTML;
  const copy = element.cloneNode(true);
  if (!(copy instanceof Element)) return '';
  const copies = [
    copy,
    ...Array.from(copy.querySelectorAll(FORM_CONTROL_SELECTOR)),
  ];
  controls.forEach((control, index) => {
    const copied = copies[index];
    if (!copied || !hasSecretValue(control)) return;
    if (copied.hasAttribute('value')) {
      copied.setAttribute('value', REDACTED_VALUE);
    }
    if (copied instanceof HTMLTextAreaElement) {
      copied.textContent = REDACTED_VALUE;
    }
    if (control instanceof HTMLSelectElement) {
      for (const child of Array.from(copied.children)) {
        redactSecretSelectSubtree(child);
      }
    }
  });
  return copy.outerHTML;
}

function snapshotFor(
  element: Element,
  browserId: string,
): BrowserElementSnapshot {
  const candidates = generateLocatorCandidates(element);
  const secret = hasSecretValue(element);
  const containsSecretText = secret || hasSecretDescendant(element);
  return {
    browserId,
    url: window.location.href,
    title: document.title,
    capturedAt: new Date().toISOString(),
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
      deviceScaleFactor: window.devicePixelRatio || 1,
    },
    themeMode: window.matchMedia('(prefers-color-scheme: dark)').matches
      ? 'dark'
      : 'light',
    tagName: element.tagName.toLowerCase(),
    role: roleFor(element),
    accessibleName: isInsideSecretSelect(element)
      ? undefined
      : accessibleName(element) || undefined,
    text: containsSecretText ? undefined : elementText(element) || undefined,
    value:
      !secret &&
      (element instanceof HTMLInputElement ||
        element instanceof HTMLTextAreaElement ||
        element instanceof HTMLSelectElement)
        ? element.value
        : undefined,
    ...(secret ? { valueRedacted: true } : {}),
    attributes: attributes(element),
    bounds: rectFor(element),
    preferredLocator: candidates[0],
    locatorCandidates: candidates,
    domPath: domPath(element),
    outerHtml: redactedOuterHtml(element).slice(0, 10_000),
  };
}

type PrivateBrowserInspection = Pick<
  BrowserElementSnapshot,
  'locatorCandidates' | 'preferredLocator' | 'domPath' | 'outerHtml'
>;

/**
 * Form controls the host's page model classified as secret. The model's
 * capture can see a secret marker the page has since removed, so its
 * decision is kept for the element's lifetime, like password history.
 */
const hostSecretControls = new WeakSet<Element>();

function rememberHostSecretControls(values: unknown[]): void {
  for (const value of values) {
    if (
      (value instanceof HTMLInputElement ||
        value instanceof HTMLTextAreaElement ||
        value instanceof HTMLSelectElement) &&
      value.ownerDocument === document
    ) {
      hostSecretControls.add(value);
    }
  }
}

function inspectElement(
  value: unknown,
  hostSecrets: unknown[] = [],
): PrivateBrowserInspection | null {
  if (!(value instanceof Element) || value.ownerDocument !== document) {
    return null;
  }
  rememberHostSecretControls(hostSecrets);
  const locatorCandidates = generateLocatorCandidates(value);
  return {
    locatorCandidates,
    preferredLocator: locatorCandidates[0],
    domPath: domPath(value),
    outerHtml: redactedOuterHtml(value).slice(0, 10_000),
  };
}

Reflect.defineProperty(globalThis, INSPECT_RESOLVER_KEY, {
  configurable: true,
  enumerable: false,
  writable: false,
  // Arguments after the element are the controls the host classified as
  // secret; with none, inspection is exactly the preload's own.
  value: (
    element: unknown,
    ...hostSecrets: unknown[]
  ): PrivateBrowserInspection | null => inspectElement(element, hostSecrets),
});

function playwrightFor(
  action: BrowserRecordingStep['action'],
  element: Element,
  value?: string,
  values?: string[],
): string {
  if (isInsideSecretSelect(element)) {
    return '// Secret option interaction omitted from recording.';
  }
  const locator =
    generateLocatorCandidates(element)[0]?.playwright ??
    `page.locator(${quote(uniqueCssSelector(element))})`;
  switch (action) {
    case 'fill':
      return `await ${locator}.fill(${quote(value ?? '')});`;
    case 'press':
      return `await ${locator}.press(${quote(value ?? '')});`;
    case 'select':
      if (values && values.length > 1) {
        return `await ${locator}.selectOption([${values.map(quote).join(', ')}]);`;
      }
      return `await ${locator}.selectOption(${quote(value ?? '')});`;
    case 'check':
      return `await ${locator}.check();`;
    case 'uncheck':
      return `await ${locator}.uncheck();`;
    case 'submit':
      return `await ${locator}.press('Enter');`;
    case 'click':
    default:
      return `await ${locator}.click();`;
  }
}

function sendRecordingStep(
  action: BrowserRecordingStep['action'],
  element: Element,
  value?: string,
  values?: string[],
): void {
  const preferred = generateLocatorCandidates(element)[0];
  const valueRedacted =
    (action === 'fill' || action === 'select') && hasSecretValue(element);
  const step: BrowserRecordingStep = {
    id:
      crypto.randomUUID?.() ??
      `${Date.now()}-${Math.random().toString(36).slice(2)}`,
    action,
    locator: preferred?.playwright,
    ...(action === 'check' || action === 'uncheck'
      ? {}
      : { value: valueRedacted ? undefined : value }),
    ...(!valueRedacted && values ? { values } : {}),
    ...(valueRedacted ? { valueRedacted: true } : {}),
    playwright: playwrightFor(
      action,
      element,
      valueRedacted ? REDACTED_VALUE : value,
      valueRedacted ? undefined : values,
    ),
    timestamp: Date.now(),
  };
  // The host holds more secret than this recorder knows. For an element the
  // recorder itself treats as secret, the locator has no text and the value
  // is withheld, so the host can keep the step as it is.
  const secretElement = hasSecretValue(element) || hasSecretDescendant(element);
  ipcRenderer.send(EVENT_CHANNEL, {
    type: 'recording-step',
    step,
    ...(secretElement ? { secretElement: true } : {}),
  });
}

let browserId = '';
let pickMode = false;
let recording = false;
let overlay: HTMLDivElement | null = null;
let tooltip: HTMLDivElement | null = null;
const recordingCheckableChanges = new WeakSet<HTMLInputElement>();
const labelTriggeredRecordingClicks = new WeakSet<HTMLInputElement>();

function reportTrustedUserInteraction(event: Event): void {
  if (!event.isTrusted) return;
  if (event.type === 'pointerdown' && event instanceof MouseEvent) {
    ipcRenderer.send(EVENT_CHANNEL, {
      type: 'user-interaction',
      interaction: {
        type: 'pointerdown',
        button: event.button,
        clientX: event.clientX,
        clientY: event.clientY,
        timestamp: Date.now(),
      },
    });
  } else if (event instanceof KeyboardEvent) {
    ipcRenderer.send(EVENT_CHANNEL, {
      type: 'user-interaction',
      interaction: { type: 'keydown', key: event.key, timestamp: Date.now() },
    });
  }
}

window.addEventListener('pointerdown', reportTrustedUserInteraction, true);
window.addEventListener('keydown', reportTrustedUserInteraction, true);

function ensureOverlay(): void {
  if (overlay && tooltip) return;
  overlay = document.createElement('div');
  tooltip = document.createElement('div');
  overlay.style.cssText =
    'position:fixed;z-index:2147483647;pointer-events:none;border:2px solid #36a3ff;background:rgba(54,163,255,.12);box-sizing:border-box;';
  tooltip.style.cssText =
    'position:fixed;z-index:2147483647;pointer-events:none;background:#111;color:#fff;font:12px/1.3 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;padding:4px 6px;border-radius:4px;max-width:420px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
  document.documentElement.append(overlay, tooltip);
}

function removeOverlay(): void {
  overlay?.remove();
  tooltip?.remove();
  overlay = null;
  tooltip = null;
}

function updateOverlay(element: Element): void {
  ensureOverlay();
  if (!overlay || !tooltip) return;
  const rect = element.getBoundingClientRect();
  const locator = isInsideSecretSelect(element)
    ? 'Secret selection'
    : (generateLocatorCandidates(element)[0]?.playwright ??
      uniqueCssSelector(element));
  overlay.style.left = `${rect.left}px`;
  overlay.style.top = `${rect.top}px`;
  overlay.style.width = `${rect.width}px`;
  overlay.style.height = `${rect.height}px`;
  tooltip.textContent = `${locator} ${Math.round(rect.width)}x${Math.round(rect.height)}`;
  tooltip.style.left = `${Math.max(0, rect.left)}px`;
  tooltip.style.top = `${Math.max(0, rect.top - 28)}px`;
}

function onPickPointerMove(event: PointerEvent): void {
  const target = event.target;
  if (target instanceof Element) {
    updateOverlay(target);
  }
}

function onPickClick(event: MouseEvent): void {
  const target = event.target;
  if (!(target instanceof Element)) return;
  event.preventDefault();
  event.stopPropagation();
  ipcRenderer.send(EVENT_CHANNEL, {
    type: 'element-picked',
    snapshot: snapshotFor(target, browserId),
  });
  setPickMode(false);
}

function onPickKeyDown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    setPickMode(false);
    ipcRenderer.send(EVENT_CHANNEL, { type: 'pick-cancelled' });
  }
}

function setPickMode(enabled: boolean): void {
  if (pickMode === enabled) return;
  pickMode = enabled;
  const method = enabled ? 'addEventListener' : 'removeEventListener';
  window[method]('pointermove', onPickPointerMove as EventListener, true);
  window[method]('click', onPickClick as EventListener, true);
  window[method]('keydown', onPickKeyDown as EventListener, true);
  if (!enabled) removeOverlay();
}

function isCheckableInput(element: Element): element is HTMLInputElement {
  return (
    element instanceof HTMLInputElement &&
    (element.type === 'checkbox' || element.type === 'radio')
  );
}

/** Interactive content whose click does not activate the label around it. */
const LABEL_INTERACTIVE_CONTENT =
  'a[href], audio[controls], button, details, embed, iframe, img[usemap], input, label, select, textarea, video[controls]';

function checkableInputForLabel(target: Element): HTMLInputElement | null {
  const label = target.closest('label');
  if (!(label instanceof HTMLLabelElement)) return null;
  const control = label.control;
  if (!(control instanceof HTMLInputElement) || !isCheckableInput(control))
    return null;
  // A link or button inside the label takes the click itself, as the HTML
  // label activation rules say; the checkbox does not change.
  const interactive = target.closest(LABEL_INTERACTIVE_CONTENT);
  if (interactive && interactive !== label && label.contains(interactive))
    return null;
  return control;
}

/**
 * Marks a checkbox or radio whose click was recorded, so the forwarded click
 * and the change that follow in the same task are not recorded again. A page
 * that cancels the click sends neither, so the marks end with the task.
 */
function markRecordedCheckable(
  control: HTMLInputElement,
  fromLabel: boolean,
): void {
  recordingCheckableChanges.add(control);
  if (fromLabel) labelTriggeredRecordingClicks.add(control);
  setTimeout(() => {
    recordingCheckableChanges.delete(control);
    labelTriggeredRecordingClicks.delete(control);
  }, 0);
}

/**
 * Records a click on a checkbox or radio, or on its label, once the click
 * has run: a page handler can cancel it, and the browser then puts the old
 * state back. A changed checkbox and a checked radio record check or
 * uncheck; anything else records the click itself.
 */
function recordCheckableClick(
  control: HTMLInputElement,
  clicked: Element,
  fromLabel: boolean,
  before: boolean,
): void {
  markRecordedCheckable(control, fromLabel);
  setTimeout(() => {
    if (!recording) return;
    if (control.type === 'radio') {
      if (control.checked) sendRecordingStep('check', control);
      else sendRecordingStep('click', clicked);
      return;
    }
    if (control.checked === before) {
      sendRecordingStep('click', clicked);
      return;
    }
    sendRecordingStep(control.checked ? 'check' : 'uncheck', control);
  }, 0);
}

function onRecordClick(event: MouseEvent): void {
  if (!recording || pickMode) return;
  const target = event.target;
  if (!(target instanceof Element)) return;
  if (isCheckableInput(target)) {
    if (labelTriggeredRecordingClicks.has(target)) {
      labelTriggeredRecordingClicks.delete(target);
      return;
    }
    if (!target.disabled) {
      // The browser toggles a checkbox before the click is dispatched, and
      // puts it back if the click is cancelled.
      recordCheckableClick(
        target,
        target,
        false,
        target.type === 'checkbox' ? !target.checked : target.checked,
      );
      return;
    }
  }

  const labelControl = checkableInputForLabel(target);
  if (labelControl && !labelControl.disabled) {
    recordCheckableClick(labelControl, target, true, labelControl.checked);
    return;
  }

  sendRecordingStep('click', target);
}

function onRecordInput(event: Event): void {
  if (!recording) return;
  const target = event.target;
  // The host records an attached upload by its files' names; the input's
  // value is only the browser's placeholder path.
  if (target instanceof HTMLInputElement && target.type === 'file') return;
  if (target instanceof HTMLInputElement && isCheckableInput(target)) {
    if (recordingCheckableChanges.has(target)) {
      recordingCheckableChanges.delete(target);
      return;
    }
    sendRecordingStep(
      target.type === 'radio' || target.checked ? 'check' : 'uncheck',
      target,
    );
  } else if (
    target instanceof HTMLInputElement ||
    target instanceof HTMLTextAreaElement
  ) {
    sendRecordingStep('fill', target, target.value);
  } else if (target instanceof HTMLSelectElement) {
    const values = target.multiple
      ? Array.from(target.selectedOptions, (option) => option.value)
      : undefined;
    sendRecordingStep(
      'select',
      target,
      target.value,
      values && values.length > 1 ? values : undefined,
    );
  }
}

function onRecordKeyDown(event: KeyboardEvent): void {
  if (!recording) return;
  const target = event.target;
  if (
    target instanceof Element &&
    ['Enter', 'Tab', 'Escape'].includes(event.key)
  ) {
    sendRecordingStep('press', target, event.key);
  }
}

function onRecordSubmit(event: SubmitEvent): void {
  if (!recording) return;
  const target = event.target;
  if (target instanceof Element) sendRecordingStep('submit', target);
}

function setRecording(enabled: boolean): void {
  if (recording === enabled) return;
  recording = enabled;
  const method = enabled ? 'addEventListener' : 'removeEventListener';
  document[method]('click', onRecordClick as EventListener, true);
  document[method]('change', onRecordInput, true);
  document[method]('keydown', onRecordKeyDown as EventListener, true);
  document[method]('submit', onRecordSubmit as EventListener, true);
}

function handleCommand(command: BrowserPreloadCommand): unknown {
  const data = payload(command.payload);
  if (data.browserId) browserId = data.browserId;
  if (command.type === 'setPickMode') {
    setPickMode(data.enabled === true);
    return { pickMode };
  }
  setRecording(data.enabled === true);
  return { recording };
}

ipcRenderer.on(COMMAND_CHANNEL, (_event, rawCommand: unknown) => {
  const command = decodeCommand(rawCommand);
  if (!command) {
    if (
      isRecord(rawCommand) &&
      typeof rawCommand.requestId === 'string' &&
      rawCommand.requestId.trim().length > 0
    ) {
      ipcRenderer.send(RESULT_CHANNEL, {
        requestId: rawCommand.requestId,
        ok: false,
        error: 'Invalid browser view command.',
      });
    }
    return;
  }
  try {
    const result = handleCommand(command);
    ipcRenderer.send(RESULT_CHANNEL, {
      requestId: command.requestId,
      ok: true,
      result,
    });
  } catch (error: unknown) {
    ipcRenderer.send(RESULT_CHANNEL, {
      requestId: command.requestId,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
});

window.addEventListener('beforeunload', () => {
  setPickMode(false);
  setRecording(false);
});
