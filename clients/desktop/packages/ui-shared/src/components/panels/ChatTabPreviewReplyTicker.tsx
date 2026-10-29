import { useLayoutEffect, useRef, type CSSProperties, type JSX } from 'react';
import { REPLAY_BLOCK_CLASS } from '../../lib/replay-privacy';

/**
 * The reply shows up to two lines, with a thin band above and below them
 * that reaches into the gaps around the reply. At rest both bands are empty:
 * the top one is a hard edge (earlier text sits right above it) and the
 * bottom one holds nothing, so the visible lines stay fully readable.
 * While text slides up, both edges turn into soft fades about a line deep:
 * the line leaving the top fades out and the new line fades in from below.
 * When the slide ends, the fades ease back out to the bands.
 */
export const REPLY_TICKER_BAND_PX = 8;
const FADE_DEPTH_PX = 18;
const SLIDE_MS = 280;
const SLIDE_EASING = 'cubic-bezier(0.2, 0, 0, 1)';
const FADE_MS = 520;

const FADE_PROPERTIES = [
  '--ticker-top-clear',
  '--ticker-top-solid',
  '--ticker-bottom-solid',
] as const;

const FADE_MASK =
  'linear-gradient(to bottom, transparent var(--ticker-top-clear), black var(--ticker-top-solid), ' +
  'black calc(100% - var(--ticker-bottom-solid)), transparent 100%)';

const FADE_REST: Keyframe = {
  '--ticker-top-clear': `${REPLY_TICKER_BAND_PX}px`,
  '--ticker-top-solid': `${REPLY_TICKER_BAND_PX}px`,
  '--ticker-bottom-solid': `${REPLY_TICKER_BAND_PX}px`,
};
const FADE_SLIDING: Keyframe = {
  '--ticker-top-clear': '0px',
  '--ticker-top-solid': `${FADE_DEPTH_PX}px`,
  '--ticker-bottom-solid': `${FADE_DEPTH_PX}px`,
};

/** Keyframes for the edges: soft while the text moves, then back to rest. */
export const REPLY_TICKER_FADE_KEYFRAMES: Keyframe[] = [
  { ...FADE_REST, offset: 0 },
  { ...FADE_SLIDING, offset: 0.15 },
  { ...FADE_SLIDING, offset: 0.55 },
  { ...FADE_REST, offset: 1 },
];

/**
 * The fade edges animate registered lengths (an unregistered custom property
 * would only jump between values). Registered once; where registration is
 * unsupported the inline resting values below keep the mask valid.
 */
let fadePropertiesRegistered = false;
function registerFadeProperties(): void {
  if (fadePropertiesRegistered) return;
  fadePropertiesRegistered = true;
  if (
    typeof CSS === 'undefined' ||
    typeof CSS.registerProperty !== 'function'
  ) {
    return;
  }
  for (const name of FADE_PROPERTIES) {
    try {
      CSS.registerProperty({
        name,
        syntax: '<length>',
        inherits: false,
        initialValue: `${REPLY_TICKER_BAND_PX}px`,
      });
    } catch {
      // Already registered (a hot reload re-runs this module).
    }
  }
}

/** The vertical offset the content is drawn at now (mid-slide, if sliding). */
function drawnOffset(element: HTMLElement, view: Window): number {
  const transform = view.getComputedStyle(element).transform;
  if (
    transform === '' ||
    transform === 'none' ||
    typeof DOMMatrixReadOnly !== 'function'
  ) {
    return 0;
  }
  return new DOMMatrixReadOnly(transform).m42;
}

type FadeProperty = (typeof FADE_PROPERTIES)[number];

// The resting bands are also set inline, so the mask stays valid where the
// properties cannot be registered; a running animation overrides them.
const WINDOW_STYLE: CSSProperties & Record<FadeProperty, string> = {
  // As tall as the text, up to two lines, plus the bands, which reach into
  // the gaps above and below the reply. A one-line reply leaves no blank
  // line.
  maxHeight: `calc(2lh + ${REPLY_TICKER_BAND_PX * 2}px)`,
  marginTop: -REPLY_TICKER_BAND_PX,
  marginBottom: -REPLY_TICKER_BAND_PX,
  paddingTop: REPLY_TICKER_BAND_PX,
  paddingBottom: REPLY_TICKER_BAND_PX,
  maskImage: FADE_MASK,
  WebkitMaskImage: FADE_MASK,
  '--ticker-top-clear': `${REPLY_TICKER_BAND_PX}px`,
  '--ticker-top-solid': `${REPLY_TICKER_BAND_PX}px`,
  '--ticker-bottom-solid': `${REPLY_TICKER_BAND_PX}px`,
};

export interface ChatTabPreviewReplyTickerProps {
  /** The agent's text messages, oldest first; the newest shows at the bottom. */
  messages: readonly string[];
}

/**
 * A window of up to two lines onto the agent's text, newest at the bottom.
 * It grows with the text until it holds two lines; after that, arriving text
 * slides everything above it up into place (the window is bottom-anchored,
 * so new lines push the old ones up) and text above the window leaves under
 * the top edge. Interruptible: a chunk that lands
 * mid-slide starts from where the text is drawn. Reduced motion skips the
 * slide.
 */
export function ChatTabPreviewReplyTicker({
  messages,
}: ChatTabPreviewReplyTickerProps): JSX.Element {
  const contentRef = useRef<HTMLDivElement | null>(null);
  const windowRef = useRef<HTMLDivElement | null>(null);
  const lastHeight = useRef<number | null>(null);
  const lastWindowHeight = useRef<number | null>(null);
  const slide = useRef<Animation | null>(null);
  const fade = useRef<Animation | null>(null);
  const text = messages.filter((message) => message.length > 0);

  useLayoutEffect(() => {
    const content = contentRef.current;
    const frame = windowRef.current;
    const view = content?.ownerDocument.defaultView;
    if (!content || !frame || !view) return;
    // Before the first paint: the resting mask reads these properties.
    registerFadeProperties();
    const height = content.offsetHeight;
    const windowHeight = frame.offsetHeight;
    const previous = lastHeight.current;
    const previousWindow = lastWindowHeight.current;
    lastHeight.current = height;
    lastWindowHeight.current = windowHeight;
    if (previous === null || previousWindow === null) return;
    // While the window grows with the text, the new line simply appears
    // below; only what the window cannot take in slides.
    const overflow = height - previous - (windowHeight - previousWindow);
    if (overflow === 0) return;
    if (typeof content.animate !== 'function') return;
    if (view.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const drawn = drawnOffset(content, view);
    slide.current?.cancel();
    slide.current = content.animate(
      [
        { transform: `translateY(${overflow + drawn}px)` },
        { transform: 'translateY(0)' },
      ],
      { duration: SLIDE_MS, easing: SLIDE_EASING },
    );
    fade.current?.cancel();
    fade.current = frame.animate(REPLY_TICKER_FADE_KEYFRAMES, {
      duration: FADE_MS,
      easing: 'ease-in-out',
    });
  });

  useLayoutEffect(
    () => (): void => {
      slide.current?.cancel();
      fade.current?.cancel();
    },
    [],
  );

  return (
    <div
      ref={windowRef}
      className="flex flex-col justify-end overflow-hidden fg-secondary"
      style={WINDOW_STYLE}
      data-testid="chat-tab-preview-reply"
    >
      {/* No gap between messages, so lines stay on the line grid and the
          two visible lines are always whole. The agent's words are
          conversation content, so session replay blocks them. */}
      <div ref={contentRef} className={`flex flex-col ${REPLAY_BLOCK_CLASS}`}>
        {text.map((message, index) => (
          <p key={index} className="m-0">
            {message}
          </p>
        ))}
      </div>
    </div>
  );
}
