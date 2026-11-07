import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type JSX,
  type ReactNode,
} from 'react';
import { Button, CHAT_COMPOSER_SHELL_CLASS } from '@canopy/ui-shared';
import {
  ArrowUp,
  CheckIcon,
  CloseLargeIcon,
  StopFilledIcon,
  PlusLargeIcon,
  StopIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import {
  ONE_LINE_COMPOSER_BOX_STYLE,
  VOICE_TAKE_EDITOR_CONTAINER_CLASS,
} from '@/components/chat/ComposerLayout';
import { VoiceRecordingRow } from '@/components/chat/VoiceRecordingRow';
import { Surface } from '@canopy/ui-shared/components';

/**
 * Lab-only mock-ups of the composer while dictating, one per reference the
 * design review collected. Levels are synthetic speech (bursts and pauses);
 * nothing here touches the microphone.
 */

// One new bar every 120ms: with option A's 6px pitch the waveform drifts
// left at about 50px a second, slow enough to read as speech, not noise.
const SAMPLE_MS = 120;
const HISTORY = 400;
/** Below this a sample reads as silence and draws as a dot. */
const SPEECH_FLOOR = 0.12;

/** A fake speech envelope: words in bursts, with short and long pauses. */
function useSpeechLevels(): number[] {
  const [levels, setLevels] = useState<number[]>(() =>
    Array.from({ length: HISTORY }, (): number => 0),
  );
  const phaseRef = useRef({ talking: false, left: 8 });
  useEffect(() => {
    const id = window.setInterval((): void => {
      const phase = phaseRef.current;
      phase.left -= 1;
      if (phase.left <= 0) {
        phase.talking = !phase.talking;
        phase.left = phase.talking
          ? 6 + Math.floor(Math.random() * 14)
          : 3 + Math.floor(Math.random() * 12);
      }
      const target = phase.talking
        ? 0.25 + Math.random() * 0.75
        : Math.random() * 0.06;
      // Ease toward the new level, as a real meter's envelope does, so
      // neighbouring bars rise and fall together instead of flickering.
      setLevels((previous) => {
        const last = previous[previous.length - 1] ?? 0;
        return [...previous.slice(1), last * 0.45 + target * 0.55];
      });
    }, SAMPLE_MS);
    return (): void => window.clearInterval(id);
  }, []);
  return levels;
}

/**
 * A `readLevel` for the real recording row: synthetic speech in bursts and
 * pauses, the same shape a microphone's peak reader returns.
 */
export function useFakeSpeechLevel(): () => number {
  const phaseRef = useRef({ talking: false, left: 8 });
  const [readLevel] = useState(() => (): number => {
    const phase = phaseRef.current;
    phase.left -= 1;
    if (phase.left <= 0) {
      phase.talking = !phase.talking;
      phase.left = phase.talking
        ? 6 + Math.floor(Math.random() * 14)
        : 3 + Math.floor(Math.random() * 12);
    }
    return phase.talking ? 0.3 + Math.random() * 0.7 : Math.random() * 0.06;
  });
  return readLevel;
}

function useElapsedSeconds(): number {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const id = window.setInterval(
      (): void => setSeconds((value) => (value + 1) % 600),
      1000,
    );
    return (): void => window.clearInterval(id);
  }, []);
  return seconds;
}

/** How many bars of `pitch` px fit the element's width. */
function useFittingCount(pitch: number): {
  ref: (node: HTMLDivElement | null) => void;
  count: number;
} {
  const [node, setNode] = useState<HTMLDivElement | null>(null);
  const [count, setCount] = useState(0);
  useLayoutEffect(() => {
    if (!node) return undefined;
    const measure = (): void =>
      setCount(Math.max(0, Math.floor((node.clientWidth + 1) / pitch)));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return (): void => observer.disconnect();
  }, [node, pitch]);
  return { ref: setNode, count };
}

/**
 * Fills its slot edge to edge; the newest sample is on the right and history
 * scrolls left. Silence draws as quiet dots, speech as rounded bars. Bars
 * scale with `transform`, not their height, so the row never re-lays out.
 */
function Waveform({ density }: { density: 'regular' | 'fine' }): JSX.Element {
  const levels = useSpeechLevels();
  const regular = density === 'regular';
  // Hairline bars: 1px wide, with a 3px (regular) or 2px (fine) pitch.
  const barWidth = 1;
  const gap = regular ? 2 : 1;
  const maxHeight = regular ? 20 : 16;
  const { ref, count } = useFittingCount(barWidth + gap);
  const shown = levels.slice(-count);
  return (
    <div
      ref={ref}
      aria-hidden
      className={`flex h-8 min-w-0 flex-1 items-center justify-end overflow-hidden ${
        regular ? 'gap-0.5' : 'gap-px'
      }`}
      // Both ends fade out over 24px instead of cutting bars off.
      style={{
        maskImage:
          'linear-gradient(to right, transparent, black 24px, black calc(100% - 24px), transparent)',
      }}
    >
      {shown.map((level, index) => {
        const speaking = level >= SPEECH_FLOOR;
        // Silence keeps a 2px dot so the line stays visible at 1px wide.
        const rest = 2 / maxHeight;
        const scale = speaking ? Math.max(rest, level) : rest;
        return (
          <span
            // Slots are positional: each shows whatever sample scrolled in.
            key={index}
            className={`shrink-0 rounded-full bg-current transition-transform duration-100 motion-reduce:transition-none ${
              speaking ? 'fg-secondary' : 'fg-quaternary'
            }`}
            style={{
              width: barWidth,
              height: maxHeight,
              transform: `scaleY(${scale})`,
            }}
          />
        );
      })}
    </div>
  );
}

/** Four bars that follow the voice: a compact "listening" signal. */
function MiniMeter(): JSX.Element {
  const levels = useSpeechLevels().slice(-4);
  return (
    <span
      aria-hidden
      className="flex h-8 w-6 shrink-0 items-center justify-center gap-0.5"
    >
      {levels.map((level, index) => (
        <span
          key={index}
          className="h-4 w-0.5 rounded-full bg-current fg-secondary transition-transform duration-100 motion-reduce:transition-none"
          style={{ transform: `scaleY(${Math.max(0.25, level)})` }}
        />
      ))}
    </span>
  );
}

/**
 * The composer's 32px round controls, in the app's three recipes: the
 * accent primary action (send), the subtle secondary (+), and the quiet
 * ghost that only shows its surface on hover.
 */
function RoundButton({
  label,
  tone,
  disabled = false,
  children,
}: {
  label: string;
  tone: 'primary' | 'secondary' | 'ghost';
  disabled?: boolean;
  children: ReactNode;
}): JSX.Element {
  return (
    <Button
      variant={tone}
      size="md"
      iconOnly
      aria-label={label}
      disabled={disabled}
    >
      {children}
    </Button>
  );
}

/** The one-line capsule, every child centred on its 32px row. */
function Capsule({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div
      style={ONE_LINE_COMPOSER_BOX_STYLE}
      className={`${CHAT_COMPOSER_SHELL_CLASS} flex items-center gap-2 p-2`}
    >
      {children}
    </div>
  );
}

function Timer({
  spaced = false,
}: {
  /** 8px more room before the next control (16px in all). */
  spaced?: boolean;
}): JSX.Element {
  const seconds = useElapsedSeconds();
  return (
    <span
      className={`flex h-8 shrink-0 items-center text-xs tabular-nums fg-secondary${spaced ? ' mr-2' : ''}`}
    >
      {Math.floor(seconds / 60)}:{String(seconds % 60).padStart(2, '0')}
    </span>
  );
}

function OptionA(): JSX.Element {
  return (
    <Capsule>
      <RoundButton label="Cancel recording" tone="secondary">
        <CloseLargeIcon size={16} />
      </RoundButton>
      <Waveform density="regular" />
      <Timer spaced />
      <RoundButton label="Stop recording" tone="secondary">
        <StopFilledIcon size={16} />
      </RoundButton>
      <RoundButton label="Send" tone="primary">
        <ArrowUp width={16} height={16} />
      </RoundButton>
    </Capsule>
  );
}

const SAMPLE_TRANSCRIPT =
  'Hello. The upload test fails about one run in five, mostly on CI. Can you check the mock server timing and make the wait deterministic?';

/**
 * Words arrive the way dictation delivers them: a few at a time with short
 * pauses, then the take starts over.
 */
function useStreamingTranscript(): string {
  const words = SAMPLE_TRANSCRIPT.split(' ');
  const [shown, setShown] = useState(0);
  useEffect(() => {
    const id = window.setInterval((): void => {
      setShown((count) => (count >= words.length + 6 ? 0 : count + 1));
    }, 380);
    return (): void => window.clearInterval(id);
  }, [words.length]);
  return words.slice(0, Math.min(shown, words.length)).join(' ');
}

/**
 * A's controls in the full layout: the words land in the text area as they
 * are recognised, and the recording row takes the toolbar's place under
 * them. The text area holds two lines even while it is still short, so the
 * box does not jump as the first words arrive.
 */
function OptionExpanded(): JSX.Element {
  const transcript = useStreamingTranscript();
  const readLevel = useFakeSpeechLevel();
  const [since] = useState(() => Date.now());
  return (
    <div className={`${CHAT_COMPOSER_SHELL_CLASS} flex flex-col`}>
      <div
        className={`px-4 pt-3.5 pb-1 text-s fg-primary ${VOICE_TAKE_EDITOR_CONTAINER_CLASS}`}
      >
        {transcript || <span className="fg-tertiary">Start talking…</span>}
      </div>
      {/* The composer's real recording row, with synthetic levels. */}
      <VoiceRecordingRow
        readLevel={readLevel}
        listeningSince={since}
        onCancel={(): void => {}}
        onStop={(): void => {}}
        onSend={(): void => {}}
      />
    </div>
  );
}

function OptionB(): JSX.Element {
  return (
    <Capsule>
      <RoundButton label="Add files and more" tone="secondary">
        <PlusLargeIcon size={16} />
      </RoundButton>
      <Waveform density="fine" />
      <Timer />
      <RoundButton label="Cancel recording" tone="ghost">
        <CloseLargeIcon size={16} />
      </RoundButton>
      <RoundButton label="Use transcript" tone="primary">
        <CheckIcon size={16} />
      </RoundButton>
    </Capsule>
  );
}

function OptionC(): JSX.Element {
  return (
    <Capsule>
      <RoundButton label="Add files and more" tone="secondary">
        <PlusLargeIcon size={16} />
      </RoundButton>
      <span className="flex h-8 min-w-0 flex-1 items-center truncate px-1 text-s fg-tertiary">
        Listening…
      </span>
      <MiniMeter />
      {/* Where the microphone was: the primary action is now to stop. */}
      <RoundButton label="Stop recording" tone="primary">
        <StopIcon size={16} />
      </RoundButton>
    </Capsule>
  );
}

const OPTIONS: Array<{
  id: string;
  title: string;
  description: string;
  render: () => JSX.Element;
}> = [
  {
    id: 'A2',
    title: 'Words above, waveform below',
    description:
      'A in the full layout: the transcript builds up on top as you talk.',
    render: (): JSX.Element => <OptionExpanded />,
  },
  {
    id: 'A',
    title: 'Waveform in place of the text',
    description:
      'Cancel, stop to edit, or send straight away; the time sits by stop.',
    render: (): JSX.Element => <OptionA />,
  },
  {
    id: 'B',
    title: 'Waveform with a timer',
    description:
      'Keeps +, shows how long you have talked, then cancel or use it.',
    render: (): JSX.Element => <OptionB />,
  },
  {
    id: 'C',
    title: 'Compact indicator',
    description: 'The composer stays put; the mic turns into stop.',
    render: (): JSX.Element => <OptionC />,
  },
];

export function ComposerVoiceOptionsLab({
  width,
}: {
  readonly width: number;
}): JSX.Element {
  return (
    <div className="flex min-h-0 flex-1 justify-center overflow-y-auto bg-secondary p-3">
      <div className="flex w-full flex-col gap-3" style={{ maxWidth: width }}>
        {OPTIONS.map((option) => (
          <Surface
            as="section"
            variant="group"
            key={option.id}
            data-testid={`voice-option-${option.id}`}
          >
            <div className="flex flex-col gap-3 px-4 py-4">
              <div className="flex flex-col gap-0.5 px-1">
                <span className="text-s fg-primary">
                  {option.id} · {option.title}
                </span>
                <span className="text-xs fg-secondary">
                  {option.description}
                </span>
              </div>
              {option.render()}
            </div>
          </Surface>
        ))}
      </div>
    </div>
  );
}
