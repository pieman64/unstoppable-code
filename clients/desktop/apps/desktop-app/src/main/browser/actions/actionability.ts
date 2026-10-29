/** Side-effect-free target checks. Scrolling is permitted for clicks; focus is not. */

export type BrowserCdpSend = (
  method: string,
  params: Record<string, unknown>,
  sessionId?: string,
) => Promise<unknown>;

export interface ActionabilityOptions {
  send: BrowserCdpSend;
  sessionId?: string;
  objectId: string;
  backendNodeId: number;
  action: 'click' | 'press' | 'fill' | 'focus' | 'hover' | 'drag';
  /** Exact point in this CDP session, never recentered. */
  exactPoint?: { x: number; y: number };
  scrollIntoView?: boolean;
  /** Offset from the element's border-box top-left for an exact click point. */
  position?: { x: number; y: number };
  timeoutMs?: number;
  signal?: AbortSignal;
  canUseDirectFallback?: boolean;
  /**
   * How the element's document maps to its session's coordinates: a point
   * `p` in the document is `origin + scale * p` in the session. Absent for
   * a session's top document (the identity). Read fresh for every point,
   * since scrolling moves a frame; undefined when it cannot be read.
   */
  frameMapping?: () => Promise<DocumentMapping | undefined>;
  /**
   * The hit test in the documents above the element's own (D9), at the
   * chosen point in session coordinates.
   */
  outerHitTest?: (point: {
    x: number;
    y: number;
  }) => Promise<{ receivesEvents: boolean; cover?: string }>;
}

/** A document's viewport in its session's coordinates. */
export interface DocumentMapping {
  originX: number;
  originY: number;
  scaleX: number;
  scaleY: number;
}

const IDENTITY: DocumentMapping = {
  originX: 0,
  originY: 0,
  scaleX: 1,
  scaleY: 1,
};

function toSession(
  mapping: DocumentMapping,
  point: { x: number; y: number },
): { x: number; y: number } {
  return {
    x: mapping.originX + mapping.scaleX * point.x,
    y: mapping.originY + mapping.scaleY * point.y,
  };
}

/** A session-coordinate quad in the element's document coordinates. */
function quadToDocument(mapping: DocumentMapping, quad: number[]): number[] {
  return quad.map((value, index) =>
    index % 2 === 0
      ? (value - mapping.originX) / mapping.scaleX
      : (value - mapping.originY) / mapping.scaleY,
  );
}

export type ActionabilityResult =
  | { status: 'ready'; point?: { x: number; y: number } }
  | {
      status: 'fallback';
      reason: 'covered' | 'no_point' | 'native_picker' | 'empty_viewport';
      warning: string;
    }
  | {
      status: 'not_executed';
      code:
        | 'target_stale'
        | 'target_disabled'
        | 'not_editable'
        | 'target_not_visible'
        | 'target_obscured'
        | 'frame_unavailable'
        | 'cancelled'
        | 'unsupported_control';
      message?: string;
    };

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Sample {
  attached: boolean;
  nativePicker?: boolean;
  visible: boolean;
  enabled: boolean;
  editable: boolean;
  rect?: Rect;
  viewport?: { width: number; height: number };
  receivesEvents: boolean;
  cover?: string;
}

const SAMPLE_FUNCTION = `function(action) {
  const el = this;
  const doc = el.ownerDocument;
  const win = doc.defaultView;
  if (!el.isConnected || !win) return { attached: false };
  const nativePicker = el.matches('select, input[type="file" i], input[type="color" i]') ||
    (el.matches('option,optgroup') && !!el.closest('select'));
  if (action === 'click' && nativePicker) return { attached: true, nativePicker: true };
  const enabled = !el.matches(':disabled') && !el.closest('[aria-disabled="true" i]');
  const editable = !el.matches('[readonly], [aria-readonly="true"]') &&
    el.matches('input,textarea');
  if (action === 'press' || action === 'fill' || action === 'focus')
    return { attached: true, enabled, editable };
  const style = win.getComputedStyle(el);
  const rect = el.getBoundingClientRect();
  const viewport = { width: win.innerWidth, height: win.innerHeight };
  const visible = rect.width > 0 && rect.height > 0 && style.display !== 'none' &&
    style.visibility !== 'hidden' && style.visibility !== 'collapse';
  const x = Math.max(0, Math.min(viewport.width - 1, rect.left + rect.width / 2));
  const y = Math.max(0, Math.min(viewport.height - 1, rect.top + rect.height / 2));
  // The element's own root (a shadow root, closed ones too, or the
  // document) hit-tests in its scope: the document's stops at the host.
  const scope = typeof el.getRootNode === 'function' ? el.getRootNode() : null;
  const hit = visible
    ? (scope && typeof scope.elementFromPoint === 'function' ? scope : doc).elementFromPoint(x, y)
    : null;
  // A click on a control's label activates the control, so the label
  // counts as the control. A pointer over the label is not over the control.
  const labels = action === 'click' && el.labels ? Array.from(el.labels) : [];
  for (let parent = el.parentElement, depth = 0; action === 'click' && parent && depth < 3; parent = parent.parentElement, depth++) {
    if (parent.tagName === 'LABEL') labels.push(parent);
  }
  const receivesEvents = !!hit && (hit === el || el.contains(hit) ||
    labels.some(label => label === hit || label.contains(hit)));
  const cover = hit && !receivesEvents
    ? hit.tagName.toLowerCase() + (typeof hit.className === 'string' && hit.className
        ? '.' + hit.className.trim().split(/\\s+/).slice(0, 2).join('.') : '')
    : undefined;
  return { attached: true, visible, enabled, editable, nativePicker,
    rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    viewport, receivesEvents, cover };
}`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function rect(value: unknown): Rect | undefined {
  const row = record(value);
  const x = number(row?.x);
  const y = number(row?.y);
  const width = number(row?.width);
  const height = number(row?.height);
  return x === undefined ||
    y === undefined ||
    width === undefined ||
    height === undefined
    ? undefined
    : { x, y, width, height };
}

async function inspect(options: ActionabilityOptions): Promise<Sample> {
  const response = record(
    await options.send(
      'Runtime.callFunctionOn',
      {
        objectId: options.objectId,
        functionDeclaration: SAMPLE_FUNCTION,
        arguments: [{ value: options.action }],
        returnByValue: true,
      },
      options.sessionId,
    ),
  );
  const value = record(record(response?.result)?.value);
  const viewport = record(value?.viewport);
  if (!value || value.attached !== true)
    return {
      attached: false,
      visible: false,
      enabled: false,
      editable: false,
      receivesEvents: false,
    };
  return {
    attached: true,
    nativePicker: value.nativePicker === true,
    visible: value.visible === true,
    enabled: value.enabled === true,
    editable: value.editable === true,
    rect: rect(value.rect),
    viewport:
      number(viewport?.width) !== undefined &&
      number(viewport?.height) !== undefined
        ? {
            width: number(viewport?.width) ?? 0,
            height: number(viewport?.height) ?? 0,
          }
        : undefined,
    receivesEvents: value.receivesEvents === true,
    cover:
      typeof value.cover === 'string' ? value.cover.slice(0, 80) : undefined,
  };
}

function point(sample: Sample): { x: number; y: number } | undefined {
  const box = sample.rect;
  const viewport = sample.viewport;
  if (
    !box ||
    !viewport ||
    box.width <= 0 ||
    box.height <= 0 ||
    viewport.width <= 0 ||
    viewport.height <= 0
  )
    return undefined;
  const left = Math.max(0, box.x);
  const right = Math.min(viewport.width, box.x + box.width);
  const top = Math.max(0, box.y);
  const bottom = Math.min(viewport.height, box.y + box.height);
  return right > left && bottom > top
    ? { x: (left + right) / 2, y: (top + bottom) / 2 }
    : undefined;
}

function quadPoint(
  value: unknown,
  viewport: Sample['viewport'],
): { point: { x: number; y: number }; area: number } | undefined {
  if (!finiteNumbers(value) || value.length !== 8 || !viewport)
    return undefined;
  const xs = [value[0], value[2], value[4], value[6]];
  const ys = [value[1], value[3], value[5], value[7]];
  const left = Math.max(0, Math.min(...xs));
  const right = Math.min(viewport.width, Math.max(...xs));
  const top = Math.max(0, Math.min(...ys));
  const bottom = Math.min(viewport.height, Math.max(...ys));
  const area = (right - left) * (bottom - top);
  return area > 0
    ? { point: { x: (left + right) / 2, y: (top + bottom) / 2 }, area }
    : undefined;
}

function finiteNumbers(value: unknown): value is number[] {
  return (
    Array.isArray(value) && value.every((item) => number(item) !== undefined)
  );
}

/**
 * The click point in the element's document coordinates. CDP geometry is in
 * session coordinates, so it is mapped back first; the viewport it is
 * clamped to is the document's own.
 */
async function clickPoint(
  options: ActionabilityOptions,
  sample: Sample,
  mapping: DocumentMapping,
): Promise<{ x: number; y: number } | undefined> {
  try {
    const response = record(
      await options.send(
        'DOM.getContentQuads',
        { backendNodeId: options.backendNodeId },
        options.sessionId,
      ),
    );
    if (Array.isArray(response?.quads)) {
      const candidates = response.quads
        .map((quad) =>
          quadPoint(
            finiteNumbers(quad) ? quadToDocument(mapping, quad) : quad,
            sample.viewport,
          ),
        )
        .filter((candidate) => candidate !== undefined)
        .sort((a, b) => b.area - a.area);
      if (candidates[0]) return candidates[0].point;
    }
  } catch {
    /* Try the box model. */
  }
  try {
    const response = record(
      await options.send(
        'DOM.getBoxModel',
        { backendNodeId: options.backendNodeId },
        options.sessionId,
      ),
    );
    const content = record(response?.model)?.content;
    const candidate = quadPoint(
      finiteNumbers(content) ? quadToDocument(mapping, content) : content,
      sample.viewport,
    );
    if (candidate) return candidate.point;
  } catch {
    /* Fall back to the client rectangle. */
  }
  return point(sample);
}

/** The requested offset from the border box's top-left, in document coordinates. */
async function positionedClickPoint(
  options: ActionabilityOptions,
  position: { x: number; y: number },
  mapping: DocumentMapping,
): Promise<{ x: number; y: number } | undefined> {
  if (!Number.isFinite(position.x) || !Number.isFinite(position.y))
    return undefined;
  try {
    const response = record(
      await options.send(
        'DOM.getBoxModel',
        { backendNodeId: options.backendNodeId },
        options.sessionId,
      ),
    );
    const border = record(response?.model)?.border;
    if (!finiteNumbers(border) || border.length !== 8) return undefined;
    const [left = 0, top = 0] = quadToDocument(mapping, border);
    return { x: left + position.x, y: top + position.y };
  } catch {
    return undefined;
  }
}

function pointIsInViewport(
  candidate: { x: number; y: number },
  viewport: Sample['viewport'],
): boolean {
  return (
    viewport !== undefined &&
    candidate.x >= 0 &&
    candidate.y >= 0 &&
    candidate.x < viewport.width &&
    candidate.y < viewport.height
  );
}

/**
 * A click on a control's label activates the control, so for a click the
 * label counts as the control. A pointer over the label is not over the
 * control, so hover and drag use the rule without labels.
 */
const hitFunction = (throughLabels: boolean): string => `function(x, y) {
  const scope = typeof this.getRootNode === 'function' ? this.getRootNode() : null;
  const hit = (scope && typeof scope.elementFromPoint === 'function' ? scope : this.ownerDocument).elementFromPoint(x, y);
  const labels = ${String(throughLabels)} && this.labels ? Array.from(this.labels) : [];
  for (let parent = this.parentElement, depth = 0; ${String(throughLabels)} && parent && depth < 3; parent = parent.parentElement, depth++) {
    if (parent.tagName === 'LABEL') labels.push(parent);
  }
  const receivesEvents = !!hit && (hit === this || this.contains(hit) ||
    labels.some(label => label === hit || label.contains(hit)));
  const cover = hit && !receivesEvents
    ? hit.tagName.toLowerCase() + (typeof hit.className === 'string' && hit.className
      ? '.' + hit.className.trim().split(/\\s+/).slice(0, 2).join('.') : '')
    : undefined;
  return { receivesEvents, cover };
}`;
const HIT_FUNCTION = hitFunction(true);
const POINTER_HIT_FUNCTION = hitFunction(false);

async function hitAtPoint(
  options: ActionabilityOptions,
  sample: Sample,
  chosen: { x: number; y: number },
  forceExact = false,
): Promise<{ receivesEvents: boolean; cover?: string }> {
  // SAMPLE_FUNCTION hits the clamped full-rect center, not its clipped center.
  const original =
    sample.rect && sample.viewport
      ? {
          x: Math.max(
            0,
            Math.min(
              sample.viewport.width - 1,
              sample.rect.x + sample.rect.width / 2,
            ),
          ),
          y: Math.max(
            0,
            Math.min(
              sample.viewport.height - 1,
              sample.rect.y + sample.rect.height / 2,
            ),
          ),
        }
      : undefined;
  if (!forceExact && original?.x === chosen.x && original.y === chosen.y)
    return { receivesEvents: sample.receivesEvents, cover: sample.cover };
  try {
    const response = record(
      await options.send(
        'Runtime.callFunctionOn',
        {
          objectId: options.objectId,
          functionDeclaration:
            options.action === 'hover' || options.action === 'drag'
              ? POINTER_HIT_FUNCTION
              : HIT_FUNCTION,
          arguments: [{ value: chosen.x }, { value: chosen.y }],
          returnByValue: true,
        },
        options.sessionId,
      ),
    );
    const value = record(record(response?.result)?.value);
    return {
      receivesEvents: value?.receivesEvents === true,
      cover:
        typeof value?.cover === 'string' ? value.cover.slice(0, 80) : undefined,
    };
  } catch {
    return { receivesEvents: false };
  }
}

function sameRect(a?: Rect, b?: Rect): boolean {
  return (
    !!a &&
    !!b &&
    a.x === b.x &&
    a.y === b.y &&
    a.width === b.width &&
    a.height === b.height
  );
}

async function pause(ms: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return false;
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve(true);
    }, ms);
    const abort = (): void => {
      clearTimeout(timer);
      resolve(false);
    };
    signal?.addEventListener('abort', abort, { once: true });
  });
}

export async function checkActionability(
  options: ActionabilityOptions,
): Promise<ActionabilityResult> {
  const deadline = Date.now() + (options.timeoutMs ?? 5_000);
  let last: Sample | undefined;
  let scrolled = false;
  while (true) {
    if (options.signal?.aborted)
      return { status: 'not_executed', code: 'cancelled' };
    let current: Sample;
    try {
      current = await inspect(options);
    } catch {
      return { status: 'not_executed', code: 'target_stale' };
    }
    if (!current.attached)
      return { status: 'not_executed', code: 'target_stale' };
    // Real input can open a modal OS menu, so position never overrides this.
    if (options.action === 'click' && current.nativePicker)
      return {
        status: 'fallback',
        reason: 'native_picker',
        warning:
          options.position === undefined
            ? 'Clicked directly because this control opens a native picker.'
            : 'Clicked directly because this control opens a native picker; position was not applied.',
      };
    if (options.action === 'drag' && current.nativePicker)
      return {
        status: 'not_executed',
        code: 'unsupported_control',
        message:
          'This control opens a native picker and cannot be a browser.drag source.',
      };
    if (
      options.action === 'hover' &&
      current.viewport &&
      (current.viewport.width <= 0 || current.viewport.height <= 0)
    )
      return {
        status: 'not_executed',
        code: 'target_not_visible',
        message: 'The browser view has not been shown, so it has no size.',
      };
    if (
      options.action === 'click' &&
      current.viewport &&
      (current.viewport.width <= 0 || current.viewport.height <= 0)
    ) {
      if (!current.enabled)
        return { status: 'not_executed', code: 'target_disabled' };
      if (options.position !== undefined)
        return { status: 'not_executed', code: 'target_not_visible' };
      return {
        status: 'fallback',
        reason: 'empty_viewport',
        warning:
          'The browser view has not been shown, so it has no size; clicked the element directly.',
      };
    }
    if (current.enabled || options.action === 'hover') {
      if (options.action === 'fill')
        return current.editable
          ? { status: 'ready' }
          : { status: 'not_executed', code: 'not_editable' };
      if (options.action === 'press' || options.action === 'focus')
        return { status: 'ready' };
      if (
        !scrolled &&
        options.scrollIntoView !== false &&
        options.exactPoint === undefined
      ) {
        scrolled = true;
        try {
          await options.send(
            'DOM.scrollIntoViewIfNeeded',
            { backendNodeId: options.backendNodeId },
            options.sessionId,
          );
          await pause(50, options.signal);
          last = undefined;
          continue;
        } catch {
          /* A direct click may still work. */
        }
      }
      if (
        (options.action === 'click' ||
          options.action === 'hover' ||
          options.action === 'drag') &&
        current.visible &&
        sameRect(last?.rect, current.rect)
      ) {
        const mapping = options.frameMapping
          ? await options.frameMapping().catch(() => undefined)
          : IDENTITY;
        if (!mapping)
          return { status: 'not_executed', code: 'frame_unavailable' };
        const candidate =
          options.exactPoint !== undefined
            ? {
                x: (options.exactPoint.x - mapping.originX) / mapping.scaleX,
                y: (options.exactPoint.y - mapping.originY) / mapping.scaleY,
              }
            : options.position === undefined
              ? await clickPoint(options, current, mapping)
              : await positionedClickPoint(options, options.position, mapping);
        if (
          (options.position !== undefined ||
            options.exactPoint !== undefined) &&
          (!candidate || !pointIsInViewport(candidate, current.viewport))
        )
          return { status: 'not_executed', code: 'target_not_visible' };
        if (!candidate) {
          last = current;
        } else {
          const sessionPoint = toSession(mapping, candidate);
          let hit = await hitAtPoint(
            options,
            current,
            candidate,
            options.position !== undefined || options.exactPoint !== undefined,
          );
          // A document above the element's own can cover it too (D9).
          if (hit.receivesEvents && options.outerHitTest)
            hit = await options
              .outerHitTest(sessionPoint)
              .catch(() => ({ receivesEvents: false }));
          if (hit.receivesEvents)
            return { status: 'ready', point: sessionPoint };
          if (
            options.action === 'hover' ||
            options.action === 'drag' ||
            options.position !== undefined ||
            options.canUseDirectFallback === false
          )
            return {
              status: 'not_executed',
              code: 'target_obscured',
              ...(options.action === 'hover' || options.action === 'drag'
                ? {
                    message: hit.cover
                      ? `The target is covered by ${hit.cover}.`
                      : 'The target is covered by another element.',
                  }
                : {}),
            };
          const cover = hit.cover
            ? `Covered by ${hit.cover}`
            : 'Target was covered';
          return {
            status: 'fallback',
            reason: 'covered',
            warning: `${cover}; clicked the element directly.`,
          };
        }
      }
    }
    if (Date.now() >= deadline) {
      if (!current.enabled && options.action !== 'hover')
        return { status: 'not_executed', code: 'target_disabled' };
      if (
        options.action === 'hover' ||
        options.action === 'drag' ||
        options.position !== undefined ||
        options.canUseDirectFallback === false
      )
        return { status: 'not_executed', code: 'target_not_visible' };
      return {
        status: 'fallback',
        reason: 'no_point',
        warning: 'No stable click point; clicked the element directly.',
      };
    }
    last = current;
    if (
      !(await pause(
        Math.min(
          current.visible &&
            (options.action === 'click' ||
              options.action === 'hover' ||
              options.action === 'drag')
            ? 50
            : 100,
          Math.max(0, deadline - Date.now()),
        ),
        options.signal,
      ))
    )
      return { status: 'not_executed', code: 'cancelled' };
  }
}
