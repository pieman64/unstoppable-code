import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type JSX,
  type ReactNode,
} from 'react';
import {
  Stack,
  Button,
  DialogModal,
  Disclosure,
  Heading,
  Notice,
  OverlayScrollArea,
  RunSpinner,
  SegmentedControl,
  Tooltip,
  EmptyStateRow,
  Surface,
} from '@canopy/ui-shared/components';
import {
  BellIcon,
  ChevronRightIcon,
  CircleCheckIcon,
  FailedIcon,
  RaisedHandIcon,
} from '@canopy/ui-shared/icons/AppIcons';
import { OPERATIONAL_STATUS_COLORS } from '@canopy/ui-shared/lib/operational-status-colors';
import type { ChatRuntimeStatus } from '@canopy/desktop-shared/types';
import { SettingsSection } from '@/components/settings/SettingsLayout';
import { applyTheme } from '@/lib/theme';

import {
  COORDINATOR_MODE_KEY as MODE_KEY,
  savedCoordinatorMode as savedMode,
  type CoordinatorMode as Mode,
} from './coordinatorLabMode';

type Activity = { at: number; kind: string; text: string; sub?: boolean };
type Shot = { path: string; at: number };
type Chat = {
  id: string;
  title: string;
  rawTitle: string;
  model: string;
  status: ChatRuntimeStatus;
  turnStartedAt: number | null;
  lastActivityAt: number | null;
  queued: string[];
  isCoordinator: boolean;
  needsYou: string | null;
  note: string | null;
  merged: string | boolean | null;
  firstUserText: string;
  lastText: string;
  lastTextAt: number;
  toolCount: number;
  messageCount: number;
  activity: Activity[];
  currentStep: string;
  screenshots: Shot[];
  videos: Shot[];
  reports: Shot[];
  replyMedia: string[];
  labs: string[];
  worktree: string;
};
type State = {
  now: number;
  worktreeId: string;
  chats: Chat[];
  attachments: Shot[];
  log: { at: string; text: string }[];
};

// The lab's own server builds every field (coordinator-lab.vite.mts), so a
// shape check is enough to tell its board from an error page.
function isState(value: unknown): value is State {
  return (
    typeof value === 'object' &&
    value !== null &&
    'chats' in value &&
    Array.isArray(value.chats) &&
    'attachments' in value &&
    Array.isArray(value.attachments) &&
    'log' in value &&
    Array.isArray(value.log)
  );
}

// A lab is shown live in a card's frame, so it must never be this page's own
// origin, whatever spelling of the port a chat used.
function otherOrigin(url: string): boolean {
  try {
    return new URL(url).origin !== window.location.origin;
  } catch {
    return false;
  }
}

type Filter = 'all' | 'needs' | 'running' | 'done' | 'merged';
type Group = Exclude<Filter, 'all'>;

const WORKING: ReadonlySet<ChatRuntimeStatus> = new Set<ChatRuntimeStatus>([
  'queued',
  'starting',
  'streaming',
  'completing',
]);
const STOPPED: ReadonlySet<ChatRuntimeStatus> = new Set<ChatRuntimeStatus>([
  'failed',
  'interrupted',
]);
const isRunning = (c: Chat): boolean => WORKING.has(c.status);
const stoppedWithError = (c: Chat): boolean => STOPPED.has(c.status);
// A recorded merge outranks a later turn that failed: the work landed.
const isFailed = (c: Chat): boolean => !c.merged && stoppedWithError(c);
// A chat stopped on a question or a permission needs you even without a note.
const askOf = (c: Chat): string | null =>
  c.needsYou ??
  (c.status === 'awaiting_input'
    ? 'Waiting for your answer in the chat'
    : null);
const groupOf = (c: Chat): Group =>
  c.merged ? 'merged' : isRunning(c) ? 'running' : askOf(c) ? 'needs' : 'done';

function ago(ms: number | null, now: number): string {
  if (!ms) return '';
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 10) return 'Just now';
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

function duration(ms: number | null, now: number): string {
  if (!ms) return '';
  const s = Math.max(0, Math.round((now - ms) / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return m > 0 ? `${m}m ${String(s % 60).padStart(2, '0')}s` : `${s}s`;
}

const clock = (iso: string): string =>
  new Date(iso).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

// Agents rewrite captures in place: the file's time versions its URL and
// element, so an overwrite loads the new picture.
const shotUrl = (shot: Shot): string =>
  `/api/file?path=${encodeURIComponent(shot.path)}&v=${Math.round(shot.at)}`;
const shotKey = (shot: Shot): string => `${shot.path}:${shot.at}`;
const isVideoPath = (path: string): boolean => /\.(mp4|webm|mov)$/i.test(path);
const fileName = (path: string): string => path.split('/').pop() ?? path;
const firstLine = (text: string): string =>
  text
    .split('\n')
    .map((l) =>
      l
        .replace(/^#+\s*|^\s*(?:[-*]|\d+\.)\s+/, '')
        .replace(/\*\*|`/g, '')
        .trim(),
    )
    .find(Boolean) ?? '';

const SECTION_TITLE: Record<Group, string> = {
  needs: 'Needs you',
  running: 'Working',
  done: 'Done',
  merged: 'Merged',
};
const EMPTY_COPY: Record<Group, string> = {
  needs:
    'Nothing is waiting on you. Chats that finish with a question show up here.',
  running: 'No chat is working right now.',
  done: 'No finished chats without an open question.',
  merged: 'No merged pull requests yet.',
};

type Chime = 'needs' | 'finished' | 'test';
const CHIMES: Record<Chime, number[]> = {
  needs: [659.25, 880],
  finished: [523.25, 659.25],
  test: [587.33, 783.99],
};
const SOUND_KEY = 'coordinator.sound';

function useChime(): {
  enabled: boolean;
  locked: boolean;
  toggle: () => void;
  play: (kind: Chime) => void;
} {
  const ctx = useRef<AudioContext | null>(null);
  const [enabled, setEnabled] = useState(
    () => localStorage.getItem(SOUND_KEY) === 'on',
  );
  const [locked, setLocked] = useState(true);

  const ensure = useCallback(async (): Promise<boolean> => {
    ctx.current ??= new AudioContext();
    if (ctx.current.state !== 'running')
      await ctx.current.resume().catch(() => undefined);
    const ok = ctx.current.state === 'running';
    setLocked(!ok);
    return ok;
  }, []);

  const play = useCallback((kind: Chime) => {
    const ac = ctx.current;
    if (!ac || ac.state !== 'running') return;
    const start = ac.currentTime + 0.02;
    CHIMES[kind].forEach((freq, i) => {
      const t = start + i * 0.12;
      const osc = ac.createOscillator();
      const gain = ac.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0, t);
      gain.gain.linearRampToValueAtTime(0.12, t + 0.015);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.35);
      osc.connect(gain).connect(ac.destination);
      osc.start(t);
      osc.stop(t + 0.4);
    });
  }, []);

  // Try to resume a context the user turned on earlier; browsers may still
  // need a click, which the header button provides.
  useEffect(() => {
    if (!enabled) return;
    const unlock = (): void => void ensure();
    void ensure();
    window.addEventListener('pointerdown', unlock, { once: true });
    return (): void => window.removeEventListener('pointerdown', unlock);
  }, [enabled, ensure]);

  const toggle = useCallback(() => {
    if (enabled && !locked) {
      setEnabled(false);
      localStorage.setItem(SOUND_KEY, 'off');
      return;
    }
    setEnabled(true);
    localStorage.setItem(SOUND_KEY, 'on');
    void ensure().then((ok) => ok && play('test'));
  }, [enabled, locked, ensure, play]);

  return { enabled, locked, toggle, play };
}

export function CoordinatorLabPage(): JSX.Element {
  const [state, setState] = useState<State | null>(null);
  const [offline, setOffline] = useState(false);
  const [filter, setFilter] = useState<Filter>('all');
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [gallery, setGallery] = useState<{
    list: Shot[];
    index: number;
  } | null>(null);
  const lightbox = gallery ? (gallery.list[gallery.index] ?? null) : null;
  const setLightbox = (s: Shot | null): void =>
    setGallery(s ? { list: [s], index: 0 } : null);
  const openIn =
    (list: Shot[]): ((s: Shot) => void) =>
    (s: Shot): void =>
      setGallery({
        list,
        index: Math.max(
          0,
          list.findIndex((x) => x.path === s.path),
        ),
      });
  const step = useCallback(
    (delta: number) =>
      setGallery((g) =>
        g && g.list.length > 1
          ? { ...g, index: (g.index + delta + g.list.length) % g.list.length }
          : g,
      ),
    [],
  );
  useEffect(() => {
    if (!gallery) return undefined;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        step(1);
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        step(-1);
      }
    };
    window.addEventListener('keydown', onKey);
    return (): void => window.removeEventListener('keydown', onKey);
  }, [gallery, step]);
  const [now, setNow] = useState(Date.now());
  const chime = useChime();
  const [mode, setMode] = useState<Mode>(savedMode);
  const changeMode = (next: Mode): void => {
    setMode(next);
    localStorage.setItem(MODE_KEY, next);
    applyTheme('default', next);
  };
  const seen = useRef<Map<string, { group: Group; ask: string | null }> | null>(
    null,
  );
  const lastChime = useRef(0);

  useEffect(() => {
    let stop = false;
    const load = async (): Promise<void> => {
      try {
        const res = await fetch('/api/state', { cache: 'no-store' });
        if (!res.ok) throw new Error(String(res.status));
        const next: unknown = await res.json();
        if (!isState(next)) throw new Error('Unexpected board state');
        const chats = next.chats.map((c) => ({
          ...c,
          labs: c.labs.filter(otherOrigin),
        }));
        if (!stop) {
          setState({ ...next, chats });
          setOffline(false);
        }
      } catch {
        if (!stop) setOffline(true);
      }
    };
    void load();
    const poll = setInterval(load, 2000);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return (): void => {
      stop = true;
      clearInterval(poll);
      clearInterval(tick);
    };
  }, []);

  useEffect(() => {
    if (!state) return;
    const prev = seen.current;
    const next = new Map<string, { group: Group; ask: string | null }>();
    let kind: Chime | null = null;
    for (const c of state.chats) {
      if (c.isCoordinator) continue;
      const group = groupOf(c);
      const ask = group === 'needs' ? askOf(c) : null;
      next.set(c.id, { group, ask });
      const before = prev?.get(c.id);
      if (!prev) continue;
      if (group === 'needs' && before?.group !== 'needs') kind = 'needs';
    }
    seen.current = next;
    const needCount = Array.from(next.values()).filter(
      (v) => v.group === 'needs',
    ).length;
    document.title = needCount > 0 ? `(${needCount}) Chats` : 'Chats';
    if (kind && chime.enabled && Date.now() - lastChime.current > 3000) {
      lastChime.current = Date.now();
      chime.play(kind);
    }
  }, [state, chime]);

  const groups = useMemo(() => {
    const by: Record<Group, Chat[]> = {
      needs: [],
      running: [],
      done: [],
      merged: [],
    };
    for (const c of state?.chats ?? []) {
      if (!c.isCoordinator) by[groupOf(c)].push(c);
    }
    const recent = (a: Chat, b: Chat): number =>
      (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0);
    by.needs.sort(recent);
    by.running.sort((a, b) => (a.turnStartedAt ?? 0) - (b.turnStartedAt ?? 0));
    by.done.sort(recent);
    by.merged.sort(recent);
    return by;
  }, [state]);

  const counts: Record<Filter, number> = {
    all:
      groups.needs.length +
      groups.running.length +
      groups.done.length +
      groups.merged.length,
    needs: groups.needs.length,
    running: groups.running.length,
    done: groups.done.length,
    merged: groups.merged.length,
  };

  const shown: Group[] =
    filter === 'all' ? ['needs', 'running', 'done', 'merged'] : [filter];
  const toggle = (id: string): void => setOpen((o) => ({ ...o, [id]: !o[id] }));

  const count = (n: number): ReactNode => (
    <span className="tabular-nums fg-tertiary">{n}</span>
  );

  return (
    // The whole window: the lab is its own window's root, not an overlay.
    <Surface variant="pane" extent="viewport">
      <OverlayScrollArea
        className="h-full"
        viewportClassName="overflow-x-hidden"
      >
        <div className="flex flex-col mx-auto w-full max-w-260 px-10 pb-20 pt-12 gap-10">
          <header className="flex flex-wrap items-end justify-between gap-6">
            <Stack gap="tight" className="min-w-0">
              <Heading level={1} variant="page">
                Chats
              </Heading>
              <p className="text-s fg-secondary">
                Worktree {state?.worktreeId ?? 'tuatara'} · updates live
              </p>
            </Stack>
            <div className="flex items-center gap-3">
              <SegmentedControl<Mode>
                label="Appearance"
                value={mode}
                onChange={changeMode}
                width="content"
                options={[
                  { value: 'dark', label: 'Dark' },
                  { value: 'light', label: 'Light' },
                  { value: 'system', label: 'System' },
                ]}
              />
              <Button
                variant="secondary"
                size="compact"
                onClick={chime.toggle}
                aria-pressed={chime.enabled && !chime.locked}
              >
                <BellIcon size="sm" aria-hidden={true} />
                {chime.enabled
                  ? chime.locked
                    ? 'Turn on sound'
                    : 'Sound on'
                  : 'Sound off'}
              </Button>
              <SegmentedControl<Filter>
                label="Show chats"
                value={filter}
                onChange={setFilter}
                width="content"
                options={[
                  { value: 'all', label: 'All', trailing: count(counts.all) },
                  {
                    value: 'needs',
                    label: 'Needs you',
                    trailing: count(counts.needs),
                  },
                  {
                    value: 'running',
                    label: 'Working',
                    trailing: count(counts.running),
                  },
                  {
                    value: 'done',
                    label: 'Done',
                    trailing: count(counts.done),
                  },
                  {
                    value: 'merged',
                    label: 'Merged',
                    trailing: count(counts.merged),
                  },
                ]}
              />
            </div>
          </header>

          <Stack gap="page">
            {offline ? (
              <div>
                <Notice
                  intent="destructive"
                  title="Can't reach the coordinator server."
                >
                  Showing the last update. Trying again every 2 seconds.
                </Notice>
              </div>
            ) : null}

            <div className="grid grid-cols-1 gap-x-14 gap-y-12 lg:grid-cols-[minmax(0,1fr)_18rem]">
              <main className="flex min-w-0 flex-col gap-10">
                {state === null && !offline ? (
                  <p className="text-s fg-secondary">Loading chats…</p>
                ) : null}
                {state
                  ? shown.map((g) =>
                      groups[g].length > 0 ? (
                        <SettingsSection key={g} title={SECTION_TITLE[g]}>
                          <ul
                            className="flex flex-col gap-3"
                            aria-label={SECTION_TITLE[g]}
                          >
                            {groups[g].map((c) => (
                              <ChatCard
                                key={c.id}
                                chat={c}
                                group={g}
                                now={now}
                                expanded={Boolean(open[c.id])}
                                onToggle={() => toggle(c.id)}
                                reviewOpen={
                                  open[`review-${c.id}`] ??
                                  (g === 'needs' || g === 'running')
                                }
                                onToggleReview={() =>
                                  setOpen((o) => ({
                                    ...o,
                                    [`review-${c.id}`]: !(
                                      o[`review-${c.id}`] ??
                                      (g === 'needs' || g === 'running')
                                    ),
                                  }))
                                }
                                onShot={openIn(cardMedia(c))}
                              />
                            ))}
                          </ul>
                        </SettingsSection>
                      ) : filter === g ? (
                        <SettingsSection key={g} title={SECTION_TITLE[g]}>
                          <p className="text-s fg-secondary">{EMPTY_COPY[g]}</p>
                        </SettingsSection>
                      ) : null,
                    )
                  : null}
              </main>

              <aside className="flex min-w-0 flex-col gap-10">
                <SettingsSection title="Coordinator log">
                  {state && state.log.length > 0 ? (
                    <ol className="flex flex-col gap-3">
                      {[...state.log]
                        .sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
                        .slice(0, open['log-all'] ? undefined : 12)
                        .map((l, i) => (
                          <li
                            key={i}
                            className="grid grid-cols-[3rem_minmax(0,1fr)] gap-3 text-xs"
                          >
                            <time
                              dateTime={l.at}
                              className="font-mono tabular-nums fg-tertiary"
                            >
                              {clock(l.at)}
                            </time>
                            <span className="text-pretty fg-secondary">
                              {l.text}
                            </span>
                          </li>
                        ))}
                      {state.log.length > 12 ? (
                        <li>
                          <span className="text-xs">
                            <Button
                              variant="link"
                              onClick={() => toggle('log-all')}
                            >
                              {open['log-all']
                                ? 'Show fewer'
                                : `Show all ${state.log.length}`}
                            </Button>
                          </span>
                        </li>
                      ) : null}
                    </ol>
                  ) : (
                    <EmptyStateRow title="No entries yet." />
                  )}
                </SettingsSection>
                <SettingsSection title="Your screenshots">
                  {state && state.attachments.length > 0 ? (
                    <Thumbs
                      shots={state.attachments}
                      now={now}
                      onShot={openIn(state.attachments)}
                      caption="time"
                    />
                  ) : (
                    <p className="text-xs fg-secondary">
                      Screenshots you attach in this worktree show up here.
                    </p>
                  )}
                </SettingsSection>
              </aside>
            </div>
          </Stack>
        </div>

        {lightbox ? (
          <DialogModal
            inset="flush"
            onClose={() => setLightbox(null)}
            title={isVideoPath(lightbox.path) ? 'Video' : 'Screenshot'}
            subtitle={
              <>
                <span className="font-mono">{fileName(lightbox.path)}</span> ·{' '}
                <span className="tabular-nums">{ago(lightbox.at, now)}</span>
                {gallery && gallery.list.length > 1 ? (
                  <>
                    {' · '}
                    <span className="tabular-nums">
                      {gallery.index + 1} of {gallery.list.length}
                    </span>
                    {' · use ← → to switch'}
                  </>
                ) : null}
              </>
            }
            maxWidth="full"
            maxHeight="94dvh"
            height="94dvh"
            scrollableBody={false}
            trapFocus={true}
          >
            {isVideoPath(lightbox.path) ? (
              <Surface
                variant="well"
                padding="default"
                className="flex min-h-0 flex-1 items-center justify-center"
              >
                <video
                  key={shotKey(lightbox)}
                  src={shotUrl(lightbox)}
                  controls={true}
                  autoPlay={true}
                  muted={true}
                  aria-label={`Demo video ${fileName(lightbox.path)}`}
                  className="max-h-full max-w-full rounded-md object-contain"
                />
              </Surface>
            ) : (
              <ZoomableImage
                key={shotKey(lightbox)}
                src={shotUrl(lightbox)}
                alt={fileName(lightbox.path)}
              />
            )}
            {gallery && gallery.list.length > 1 ? (
              <>
                {/* The holder places each arrow; the tooltip wraps the
                    button inside it. */}
                <div className="absolute left-4 top-1/2 z-10 flex -translate-y-1/2">
                  <Tooltip label="Previous" shortcut="←">
                    <Button
                      variant="secondary"
                      size="lg"
                      iconOnly
                      onClick={() => step(-1)}
                      aria-label="Previous"
                    >
                      <ChevronRightIcon
                        size="sm"
                        aria-hidden={true}
                        className="rotate-180"
                      />
                    </Button>
                  </Tooltip>
                </div>
                <div className="absolute right-4 top-1/2 z-10 flex -translate-y-1/2">
                  <Tooltip label="Next" shortcut="→">
                    <Button
                      variant="secondary"
                      size="lg"
                      iconOnly
                      onClick={() => step(1)}
                      aria-label="Next"
                    >
                      <ChevronRightIcon size="sm" aria-hidden={true} />
                    </Button>
                  </Tooltip>
                </div>
              </>
            ) : null}
          </DialogModal>
        ) : null}
      </OverlayScrollArea>
    </Surface>
  );
}

// Newest first, every file: a card always leads with its latest picture or video.
function cardMedia(c: { videos: Shot[]; screenshots: Shot[] }): Shot[] {
  return [...c.videos, ...c.screenshots].sort((a, b) => b.at - a.at);
}

type Zoom = 'fit' | number;
const ZOOM_MIN = 0.1;
const ZOOM_MAX = 8;
const clampZoom = (z: number): number =>
  Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, z));

/**
 * Fit-to-window image that zooms like a native viewer: click to zoom to the
 * clicked point (click again to fit), drag to move, Cmd/Ctrl + scroll or
 * pinch to zoom around the pointer, and 0 / 1 / 2 / + / - on the keyboard.
 * "100%" is one image pixel per screen pixel.
 */
function ZoomableImage({
  src,
  alt,
}: {
  src: string;
  alt: string;
}): JSX.Element {
  const box = useRef<HTMLElement | null>(null);
  const [natural, setNatural] = useState<{ w: number; h: number } | null>(null);
  const [zoom, setZoom] = useState<Zoom>('fit');
  const drag = useRef<{
    x: number;
    y: number;
    left: number;
    top: number;
    moved: boolean;
  } | null>(null);
  const pendingAnchor = useRef<{
    fx: number;
    fy: number;
    px: number;
    py: number;
  } | null>(null);
  const dpr = window.devicePixelRatio || 1;
  // Fit follows the stage's size, so it re-renders when the stage resizes.
  const [stage, setStage] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return undefined;
    const measure = (): void =>
      setStage({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return (): void => observer.disconnect();
  }, []);

  const fitScale = useCallback((): number => {
    if (!natural || stage.w === 0 || stage.h === 0) return 1;
    return Math.min(
      stage.w / (natural.w / dpr),
      stage.h / (natural.h / dpr),
      1,
    );
  }, [natural, dpr, stage]);
  const scale = zoom === 'fit' ? fitScale() : zoom;

  // Zoom so the image point under (px, py) in the viewport stays put.
  const zoomTo = useCallback((next: Zoom, px?: number, py?: number) => {
    const el = box.current;
    const img = el?.querySelector('img');
    if (el && img && next !== 'fit') {
      const r = img.getBoundingClientRect();
      const b = el.getBoundingClientRect();
      const x = px ?? b.left + b.width / 2;
      const y = py ?? b.top + b.height / 2;
      pendingAnchor.current = {
        fx: Math.min(1, Math.max(0, (x - r.left) / r.width)),
        fy: Math.min(1, Math.max(0, (y - r.top) / r.height)),
        px: x - b.left,
        py: y - b.top,
      };
    }
    setZoom(next === 'fit' ? 'fit' : clampZoom(next));
  }, []);

  useEffect(() => {
    const el = box.current;
    const a = pendingAnchor.current;
    if (!el || !a || !natural || zoom === 'fit') return;
    pendingAnchor.current = null;
    const w = (natural.w / dpr) * zoom;
    const h = (natural.h / dpr) * zoom;
    const padX = Math.max(0, (el.clientWidth - w) / 2);
    const padY = Math.max(0, (el.clientHeight - h) / 2);
    el.scrollLeft = padX + a.fx * w - a.px;
    el.scrollTop = padY + a.fy * h - a.py;
  }, [zoom, natural, dpr]);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const onWheel = (e: WheelEvent): void => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const current = zoom === 'fit' ? fitScale() : zoom;
      zoomTo(current * Math.exp(-e.deltaY * 0.01), e.clientX, e.clientY);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return (): void => el.removeEventListener('wheel', onWheel);
  }, [zoom, fitScale, zoomTo]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const current = zoom === 'fit' ? fitScale() : zoom;
      if (e.key === '0') zoomTo('fit');
      else if (e.key === '1') zoomTo(1);
      else if (e.key === '2') zoomTo(2);
      else if (e.key === '+' || e.key === '=') zoomTo(current * 1.25);
      else if (e.key === '-') zoomTo(current / 1.25);
      else return;
      e.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return (): void => window.removeEventListener('keydown', onKey);
  }, [zoom, fitScale, zoomTo]);

  const preset: 'fit' | '1' | '2' | 'custom' =
    zoom === 'fit' ? 'fit' : zoom === 1 ? '1' : zoom === 2 ? '2' : 'custom';

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between gap-4 px-6 pb-3">
        <p className="text-xs fg-tertiary">
          Click to zoom in or out. Drag to move. Pinch or ⌘ scroll to zoom.
        </p>
        <div className="flex items-center gap-3">
          <span className="w-12 text-right text-xs tabular-nums fg-secondary">
            {Math.round(scale * 100)}%
          </span>
          <SegmentedControl<'fit' | '1' | '2' | 'custom'>
            label="Zoom"
            value={preset}
            onChange={(v) =>
              v !== 'custom' && zoomTo(v === 'fit' ? 'fit' : Number(v))
            }
            width="content"
            options={[
              { value: 'fit', label: 'Fit' },
              { value: '1', label: '100%' },
              { value: '2', label: '200%' },
            ]}
          />
        </div>
      </div>
      <Surface
        variant="well"
        ref={box}
        className="relative min-h-0 flex-1 overflow-auto"
        onPointerDown={(e) => {
          if (zoom === 'fit' || e.button !== 0) return;
          const el = box.current;
          if (!el) return;
          drag.current = {
            x: e.clientX,
            y: e.clientY,
            left: el.scrollLeft,
            top: el.scrollTop,
            moved: false,
          };
          el.setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          const el = box.current;
          if (!d || !el) return;
          const dx = e.clientX - d.x;
          const dy = e.clientY - d.y;
          if (Math.abs(dx) + Math.abs(dy) > 3) d.moved = true;
          el.scrollLeft = d.left - dx;
          el.scrollTop = d.top - dy;
        }}
        onPointerUp={(e) => {
          if (e.button !== 0) return;
          const d = drag.current;
          drag.current = null;
          if (d?.moved) return;
          zoomTo(
            zoom === 'fit' ? Math.max(1, fitScale() * 2) : 'fit',
            e.clientX,
            e.clientY,
          );
        }}
      >
        <div
          className={`flex min-h-full min-w-full items-center justify-center ${
            zoom === 'fit'
              ? 'cursor-zoom-in'
              : drag.current
                ? 'cursor-grabbing'
                : 'cursor-zoom-out'
          }`}
          style={
            natural && zoom !== 'fit'
              ? {
                  width: Math.max((natural.w / dpr) * scale, 0),
                  height: Math.max((natural.h / dpr) * scale, 0),
                }
              : { height: '100%' }
          }
        >
          <img
            src={src}
            alt={alt}
            draggable={false}
            onLoad={(e) =>
              setNatural({
                w: e.currentTarget.naturalWidth,
                h: e.currentTarget.naturalHeight,
              })
            }
            className="block select-none"
            style={
              // Fit draws at the same size the zoom label and math use.
              natural
                ? {
                    width: (natural.w / dpr) * scale,
                    height: (natural.h / dpr) * scale,
                    maxWidth: 'none',
                  }
                : { maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }
            }
          />
        </div>
      </Surface>
    </div>
  );
}

function StatusGlyph({
  chat,
  group,
}: {
  chat: Chat;
  group: Group;
}): JSX.Element {
  if (group === 'running') {
    return (
      <span className={OPERATIONAL_STATUS_COLORS.active.foreground}>
        <RunSpinner />
      </span>
    );
  }
  if (isFailed(chat)) {
    return (
      <FailedIcon
        size="sm"
        aria-label="Failed"
        className={OPERATIONAL_STATUS_COLORS.failed.foreground}
      />
    );
  }
  if (group === 'needs') {
    return (
      <RaisedHandIcon size="sm" aria-label="Needs you" className="fg-warning" />
    );
  }
  return (
    <CircleCheckIcon
      size="sm"
      aria-label="Done"
      className={OPERATIONAL_STATUS_COLORS.success.foreground}
    />
  );
}

function ChatCard({
  chat: c,
  group,
  now,
  expanded,
  onToggle,
  reviewOpen,
  onToggleReview,
  onShot,
}: {
  chat: Chat;
  group: Group;
  now: number;
  expanded: boolean;
  onToggle: () => void;
  reviewOpen: boolean;
  onToggleReview: () => void;
  onShot: (s: Shot) => void;
}): JSX.Element {
  const reply = c.lastText.trim();
  const media = cardMedia(c);
  const hasReview =
    media.length > 0 || c.reports.length > 0 || c.labs.length > 0;

  const line =
    group === 'needs'
      ? askOf(c)
      : group === 'running'
        ? firstLine(c.currentStep || c.activity[0]?.text || '') || 'Starting…'
        : isFailed(c)
          ? c.note || 'Stopped with an error'
          : group === 'merged' && stoppedWithError(c)
            ? typeof c.merged === 'string'
              ? `Merged ${c.merged}`
              : c.note || 'Merged'
            : firstLine(reply);

  const trailing =
    group === 'running'
      ? duration(c.turnStartedAt, now)
      : ago(c.lastActivityAt, now);

  return (
    <Surface as="li" variant="group" padding="default" gap="group">
      <div className="flex items-start gap-3">
        <span className="flex h-5 w-4 shrink-0 items-center justify-center">
          <StatusGlyph chat={c} group={group} />
        </span>
        <Stack gap="tight" className="min-w-0 flex-1">
          <Heading level={3} variant="title" truncate>
            {c.title}
          </Heading>
          <p
            className={`text-s ${
              group === 'needs'
                ? 'fg-secondary'
                : isFailed(c)
                  ? OPERATIONAL_STATUS_COLORS.failed.foreground
                  : 'fg-tertiary'
            } ${group === 'running' ? 'truncate' : group === 'needs' ? 'line-clamp-4 text-pretty' : 'line-clamp-2 text-pretty'}`}
          >
            {line}
          </p>
        </Stack>
        <span className="flex h-5 shrink-0 items-center text-xs tabular-nums fg-tertiary">
          {trailing}
        </span>
      </div>

      {hasReview ? (
        reviewOpen ? (
          <div className="pl-7">
            <ReviewPanel
              chat={c}
              media={media}
              onShot={onShot}
              onHide={onToggleReview}
            />
          </div>
        ) : null
      ) : null}

      {hasReview && !reviewOpen ? (
        <div className="pl-7">
          <Button
            variant="ghost"
            size="compact"
            onClick={onToggleReview}
            className="-ml-3"
          >
            <ChevronRightIcon size="sm" aria-hidden={true} />
            {reviewSummary(c, media)}
          </Button>
        </div>
      ) : null}

      <div className="pl-7">
        <Disclosure
          label="Details"
          open={expanded}
          onOpenChange={onToggle}
          dataTestId={`coordinator-lab-chat-${c.id}-details`}
        >
          <Stack gap="group">
            {c.note ? (
              <p className="text-xs text-pretty fg-secondary">{c.note}</p>
            ) : null}
            {c.queued.length > 0 ? (
              <p className="text-xs fg-secondary">
                <span className="tabular-nums">{c.queued.length}</span>{' '}
                {c.queued.length > 1 ? 'messages are' : 'message is'} waiting to
                be read
              </p>
            ) : null}
            {group === 'running' && c.activity.length > 0 ? (
              <Steps activity={c.activity.slice(0, 8)} now={now} />
            ) : null}
            {reply ? (
              <Stack gap="inline">
                <p className="text-xs fg-tertiary">
                  Last reply ·{' '}
                  <span className="tabular-nums">{ago(c.lastTextAt, now)}</span>
                </p>
                <Rich text={reply} />
              </Stack>
            ) : null}
          </Stack>
        </Disclosure>
      </div>
    </Surface>
  );
}

const fsUrl = (path: string): string =>
  `/fs${path.split('/').map(encodeURIComponent).join('/')}`;
// Versioned by the page's file time, so a rewritten report reloads.
const reportUrl = (report: Shot): string =>
  `${fsUrl(report.path)}?v=${Math.round(report.at)}`;
const reportName = (path: string): string => {
  const parts = path.split('/');
  const i = parts.lastIndexOf('.playwright');
  return i >= 0 && parts[i + 1] ? parts[i + 1] : fileName(path);
};

/** The same page with any #hash or ?query dropped, for spotting repeats. */
const pagePath = (path: string): string => path.replace(/[?#].*$/, '');

/** Drops repeat mentions of one page, keeping the first (newest) one. */
function uniqueReports(reports: Shot[]): Shot[] {
  const seen = new Set<string>();
  return reports.filter((r) => {
    const key = pagePath(r.path);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Short, distinct tab labels for a chat's report pages. Pages in one
 * `.playwright/<folder>` read by file name ("index", "round3/thinking-icons"),
 * taking just enough parent folders to tell them apart. Pages across folders
 * read by folder, adding the file name only when a folder repeats.
 */
function reportLabels(paths: string[]): string[] {
  const parsed = paths.map((p) => {
    const parts = pagePath(p).split('/');
    const at = parts.lastIndexOf('.playwright');
    const tail = (at >= 0 ? parts.slice(at + 1) : parts.slice(-1)).filter(
      Boolean,
    );
    const last = tail.length - 1;
    tail[last] = (tail[last] ?? '').replace(/\.html?$/i, '');
    const worktree = at >= 2 ? (parts[at - 1] ?? '') : '';
    return at >= 0 && tail.length > 1
      ? { folder: tail[0] ?? '', rest: tail.slice(1), worktree }
      : { folder: '', rest: tail, worktree };
  });
  // The shortest trailing run of `rest` that no other page in the group shares.
  const suffixes = (group: number[]): Map<number, string> => {
    const out = new Map<number, string>();
    for (const i of group) {
      const rest = parsed[i]?.rest ?? [];
      let label = rest.join('/');
      for (let depth = 1; depth <= rest.length; depth += 1) {
        const tryLabel = rest.slice(-depth).join('/');
        const clash = group.some(
          (j) =>
            j !== i &&
            (parsed[j]?.rest ?? []).slice(-depth).join('/') === tryLabel,
        );
        if (!clash) {
          label = tryLabel;
          break;
        }
      }
      out.set(i, label);
    }
    return out;
  };
  const all = parsed.map((_, i) => i);
  const folders = new Set(parsed.map((p) => p.folder));
  let labels: string[];
  if (folders.size <= 1) {
    const names = suffixes(all);
    labels = all.map((i) => names.get(i) ?? '');
  } else {
    labels = all.map((i) => {
      const p = parsed[i];
      if (!p) return '';
      const group = all.filter((j) => parsed[j]?.folder === p.folder);
      if (group.length === 1 || !p.folder) return p.folder || p.rest.join('/');
      return `${p.folder}/${suffixes(group).get(i) ?? ''}`;
    });
  }
  // Same folder and file in two worktrees: name the worktree as well.
  return labels.map((l, i) =>
    labels.some((m, j) => j !== i && m === l) && parsed[i]?.worktree
      ? `${l} · ${parsed[i]?.worktree}`
      : l,
  );
}

/**
 * One tab's label, capped in width. A label that does not fit fades out at
 * its right edge instead of ending in an ellipsis.
 */
function FadeLabel({ text }: { text: string }): JSX.Element {
  const ref = useRef<HTMLSpanElement>(null);
  const [clipped, setClipped] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const measure = (): void => setClipped(el.scrollWidth > el.clientWidth + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return (): void => observer.disconnect();
  }, [text]);
  const fade =
    'linear-gradient(to right, #000 calc(100% - 1.25rem), transparent)';
  return (
    <span
      ref={ref}
      className="block max-w-44 overflow-hidden whitespace-nowrap"
      style={clipped ? { maskImage: fade, WebkitMaskImage: fade } : undefined}
    >
      {text}
    </span>
  );
}

/** Keeps a row of tabs inside its card: it scrolls sideways, with no visible bar. */
function TabRow({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div
      data-tab-row=""
      className="-m-1 min-w-0 overflow-x-auto p-1 canopy-hide-scrollbar"
    >
      {children}
    </div>
  );
}

function reviewSummary(c: Chat, media: Shot[]): string {
  const bits: string[] = [];
  if (c.reports.length > 0)
    bits.push(
      uniqueReports(c.reports).length > 1
        ? `${uniqueReports(c.reports).length} report pages`
        : 'Report page',
    );
  if (c.labs.length > 0) bits.push('Live lab');
  if (media.length > 0)
    bits.push(`${media.length} ${media.length > 1 ? 'pictures' : 'picture'}`);
  return `Show ${bits.join(', ').replace(/^./, (x) => x.toLowerCase())}`;
}

type ReviewView = 'report' | 'lab' | 'pictures';

/**
 * What to look at for one chat, one thing at a time: its report page or lab,
 * live and clickable, or its pictures as a single switchable view.
 */
function ReviewPanel({
  chat: c,
  media,
  onShot,
  onHide,
}: {
  chat: Chat;
  media: Shot[];
  onShot: (s: Shot) => void;
  onHide: () => void;
}): JSX.Element {
  // Pictures the latest reply points at come first; the rest stay behind "+N".
  const pictures = useMemo(() => {
    const pointed = new Set(c.replyMedia);
    const first = media.filter((m) => pointed.has(m.path));
    return first.length > 0
      ? [...first, ...media.filter((m) => !pointed.has(m.path))]
      : media;
  }, [c.replyMedia, media]);
  const pointedCount = pictures.filter((m) =>
    c.replyMedia.includes(m.path),
  ).length;
  const surfaces: ReviewView[] = [
    ...(c.reports.length > 0 ? (['report'] as const) : []),
    ...(c.labs.length > 0 ? (['lab'] as const) : []),
    ...(pictures.length > 0 ? (['pictures'] as const) : []),
  ];
  const [surface, setSurface] = useState<ReviewView>(surfaces[0] ?? 'pictures');
  const active = surfaces.includes(surface)
    ? surface
    : (surfaces[0] ?? 'pictures');
  const [reportIndex, setReportIndex] = useState(0);
  const [labIndex, setLabIndex] = useState(0);
  const reports = useMemo(() => uniqueReports(c.reports), [c.reports]);
  const reportTabLabels = useMemo(
    () => reportLabels(reports.map((r) => r.path)),
    [reports],
  );
  const report = reports[Math.min(reportIndex, reports.length - 1)];
  const lab = c.labs[Math.min(labIndex, c.labs.length - 1)];
  const label: Record<ReviewView, string> = {
    report: 'Report',
    lab: 'Live lab',
    pictures: 'Pictures',
  };

  return (
    <Stack gap="item">
      <div className="flex flex-wrap items-center justify-between gap-3">
        {surfaces.length > 1 ? (
          <SegmentedControl<ReviewView>
            label="Show"
            value={active}
            onChange={setSurface}
            width="content"
            options={surfaces.map((v) => ({ value: v, label: label[v] }))}
          />
        ) : (
          <span className="text-xs fg-tertiary">{label[active]}</span>
        )}
        <div className="flex items-center gap-3">
          {active === 'report' && report ? (
            <a
              href={reportUrl(report)}
              target="_blank"
              rel="noreferrer"
              className="focus-ring rounded-sm text-xs fg-secondary hover:fg-primary"
            >
              Open full page
            </a>
          ) : null}
          {active === 'lab' && lab ? (
            <a
              href={lab}
              target="_blank"
              rel="noreferrer"
              className="focus-ring rounded-sm text-xs fg-secondary hover:fg-primary"
            >
              Open lab
            </a>
          ) : null}
          <span className="text-xs">
            <Button variant="link" onClick={onHide}>
              Hide
            </Button>
          </span>
        </div>
      </div>

      {active === 'report' && report ? (
        <>
          {reports.length > 1 ? (
            <TabRow>
              <SegmentedControl<string>
                label="Report"
                value={String(Math.min(reportIndex, reports.length - 1))}
                onChange={(v) => setReportIndex(Number(v))}
                width="content"
                options={reports.map((r, i) => ({
                  value: String(i),
                  label: '',
                  leading: (
                    <FadeLabel
                      text={reportTabLabels[i] ?? reportName(r.path)}
                    />
                  ),
                }))}
              />
            </TabRow>
          ) : null}
          <iframe
            key={shotKey(report)}
            src={reportUrl(report)}
            sandbox="allow-scripts allow-popups allow-forms"
            title={`Report ${reportName(report.path)}`}
            className="h-112 w-full rounded-md bg-base ring-[length:var(--border-hairline)] ring-line-base"
          />
        </>
      ) : null}

      {active === 'lab' && lab ? (
        <>
          {c.labs.length > 1 ? (
            <TabRow>
              <SegmentedControl<string>
                label="Lab"
                value={String(labIndex)}
                onChange={(v) => setLabIndex(Number(v))}
                width="content"
                options={c.labs.map((u, i) => ({
                  value: String(i),
                  label: new URL(u).host,
                }))}
              />
            </TabRow>
          ) : null}
          <iframe
            key={lab}
            src={lab}
            title={`Lab ${lab}`}
            className="h-112 w-full rounded-md bg-base ring-[length:var(--border-hairline)] ring-line-base"
          />
        </>
      ) : null}

      {active === 'pictures' && pictures.length > 0 ? (
        <PictureViewer
          shots={pointedCount > 0 ? pictures.slice(0, pointedCount) : pictures}
          all={pictures}
          onShot={onShot}
        />
      ) : null}
    </Stack>
  );
}

type Dim = 'phase' | 'theme' | 'platform';
const DIMS: readonly Dim[] = ['phase', 'theme', 'platform'];
const DIM_VALUES: Record<Dim, string[]> = {
  phase: ['before', 'after'],
  theme: ['light', 'dark'],
  platform: ['desktop', 'web'],
};
// File-name words that mean before or after.
const DIM_SYNONYMS: Record<string, string[]> = {
  before: ['before', 'current', 'old', 'baseline', 'develop', 'now'],
  after: ['after', 'target', 'new', 'fixed', 'proposed', 'final'],
};
const cap = (v: string): string => v.charAt(0).toUpperCase() + v.slice(1);

function variantOf(path: string): {
  base: string;
  dims: Partial<Record<Dim, string>>;
} {
  let base = fileName(path)
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/, '');
  const dims: Partial<Record<Dim, string>> = {};
  for (const dim of DIMS) {
    for (const v of DIM_VALUES[dim]) {
      for (const word of DIM_SYNONYMS[v] ?? [v]) {
        const re = new RegExp(`(^|[-_.])${word}(?=$|[-_.])`);
        if (re.test(base)) {
          dims[dim] = v;
          base = base.replace(re, '$1~');
          break;
        }
      }
      if (dims[dim]) break;
    }
  }
  // Only captures from one folder pair up: the same name in another report,
  // subfolder or worktree is another subject. Folders named for a variant
  // (`before/`, `dark/`) still pair, and set that variant.
  const folders = folderOf(path).map((segment) => {
    const lower = segment.toLowerCase();
    for (const dim of DIMS) {
      for (const v of DIM_VALUES[dim]) {
        if ((DIM_SYNONYMS[v] ?? [v]).includes(lower)) {
          dims[dim] ??= v;
          return '~';
        }
      }
    }
    return segment;
  });
  return {
    base: `${folders.join('/')}/${base.replace(/[-_.]*~[-_.]*/g, '~')}`,
    dims,
  };
}

/** The folders above a capture's file. */
function folderOf(path: string): string[] {
  return path.split('/').slice(0, -1);
}

function humanName(base: string): string {
  const words = (base.split('/').pop() ?? '')
    .replace(/~/g, ' ')
    .replace(/[-_.]+/g, ' ')
    .replace(/\b\d{1,2}x\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return words ? words.charAt(0).toUpperCase() + words.slice(1) : 'Picture';
}

/** A picture that fades in once it has loaded, so switching never flashes. */
function FadeImage({
  src,
  className,
  style,
}: {
  src: string;
  className?: string;
  style?: CSSProperties;
}): JSX.Element {
  const [loaded, setLoaded] = useState(false);
  return (
    <img
      src={src}
      alt=""
      draggable={false}
      onLoad={() => setLoaded(true)}
      style={style}
      className={`${className ?? ''} transition-opacity duration-200 motion-reduce:transition-none ${loaded ? 'opacity-100' : 'opacity-0'}`}
    />
  );
}

/** Drag across to wipe between the before and after captures. */
function CompareSlider({
  before,
  after,
}: {
  before: Shot;
  after: Shot;
}): JSX.Element {
  const box = useRef<HTMLDivElement | null>(null);
  const [split, setSplit] = useState(50);
  const dragging = useRef(false);
  const move = (clientX: number): void => {
    const r = box.current?.getBoundingClientRect();
    if (!r) return;
    setSplit(Math.min(100, Math.max(0, ((clientX - r.left) / r.width) * 100)));
  };
  return (
    <div
      ref={box}
      className="absolute inset-0 cursor-ew-resize touch-none select-none"
      onPointerDown={(e) => {
        dragging.current = true;
        e.currentTarget.setPointerCapture(e.pointerId);
        move(e.clientX);
      }}
      onPointerMove={(e) => dragging.current && move(e.clientX)}
      onPointerUp={() => {
        dragging.current = false;
      }}
      role="slider"
      aria-label="Before and after"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(split)}
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'ArrowLeft') setSplit((s) => Math.max(0, s - 5));
        else if (e.key === 'ArrowRight') setSplit((s) => Math.min(100, s + 5));
        else return;
        e.preventDefault();
      }}
    >
      <FadeImage
        key={shotKey(before)}
        src={shotUrl(before)}
        className="absolute inset-0 h-full w-full object-scale-down p-4"
      />
      <div
        className="absolute inset-0"
        style={{ clipPath: `inset(0 0 0 ${split}%)` }}
      >
        <FadeImage
          key={shotKey(after)}
          src={shotUrl(after)}
          className="absolute inset-0 h-full w-full object-scale-down p-4"
        />
      </div>
      <div
        className="pointer-events-none absolute inset-y-0"
        style={{ left: `${split}%` }}
      >
        <div className="absolute inset-y-0 -left-px w-0.5 bg-current fg-primary opacity-70" />
        <div className="absolute top-1/2 -left-4 flex size-8 -translate-y-1/2 items-center justify-center rounded-full bg-base fg-primary shadow-md ring-[length:var(--border-hairline)] ring-line-base">
          <ChevronRightIcon
            size="sm"
            aria-hidden={true}
            className="rotate-180"
          />
          <ChevronRightIcon size="sm" aria-hidden={true} />
        </div>
      </div>
      <span className="pointer-events-none absolute left-3 top-3 rounded-full bg-base px-2 py-0.5 text-xs fg-secondary shadow-sm backdrop-blur">
        Before
      </span>
      <span className="pointer-events-none absolute right-3 top-3 rounded-full bg-base px-2 py-0.5 text-xs fg-primary shadow-sm backdrop-blur">
        After
      </span>
    </div>
  );
}

type Phase = 'compare' | 'before' | 'after';

/**
 * One stage, always the same height. Captures named like
 * `x-desktop-after-dark.png` group into one subject with switches for theme
 * and platform, and a before/after wipe when both exist. A filmstrip below
 * picks the subject; everything else waits behind "+N more".
 */
function PictureViewer({
  shots,
  all,
  onShot,
}: {
  shots: Shot[];
  all: Shot[];
  onShot: (s: Shot) => void;
}): JSX.Element {
  const parsed = useMemo(
    () => shots.map((s) => ({ shot: s, ...variantOf(s.path) })),
    [shots],
  );
  const bases = useMemo(
    (): string[] => Array.from(new Set(parsed.map((p) => p.base))),
    [parsed],
  );
  const [baseIndex, setBaseIndex] = useState(0);
  const [pick, setPick] = useState<{ theme: string; platform: string }>({
    theme: 'dark',
    platform: 'desktop',
  });
  const [phase, setPhase] = useState<Phase>('compare');
  const page = Math.min(baseIndex, Math.max(0, bases.length - 1));
  const inBase = parsed.filter((p) => p.base === bases[page]);
  const values = (d: Dim): string[] =>
    DIM_VALUES[d].filter((v) => inBase.some((p) => p.dims[d] === v));
  const themes = values('theme');
  const platforms = values('platform');
  const theme = themes.includes(pick.theme)
    ? pick.theme
    : themes[themes.length - 1];
  const platform = platforms.includes(pick.platform)
    ? pick.platform
    : platforms[0];
  const matches = (p: (typeof parsed)[number], ph?: string): boolean =>
    (!theme || !p.dims.theme || p.dims.theme === theme) &&
    (!platform || !p.dims.platform || p.dims.platform === platform) &&
    (!ph || p.dims.phase === ph);
  const before = inBase.find((p) => matches(p, 'before'))?.shot;
  const after = inBase.find((p) => matches(p, 'after'))?.shot;
  // The wipe compares pictures; video pairs play one at a time.
  const canCompare = Boolean(
    before && after && !isVideoPath(before.path) && !isVideoPath(after.path),
  );
  const activePhase: Phase =
    phase === 'compare' && !canCompare ? 'after' : phase;
  const single =
    (activePhase === 'before'
      ? before
      : activePhase === 'after'
        ? after
        : undefined) ??
    // Never a capture from another theme or platform than the switches say.
    inBase.find((p) => matches(p))?.shot;
  const go = (delta: number): void =>
    setBaseIndex((page + delta + bases.length) % bases.length);
  const thumbFor = (base: string): Shot | undefined => {
    const list = parsed.filter((p) => p.base === base);
    return (
      list.find((p) => matches(p, 'after')) ??
      list.find((p) => matches(p)) ??
      list[0]
    )?.shot;
  };
  const rest = all.length - shots.length;

  return (
    <Stack gap="item">
      <div className="flex min-h-7 flex-wrap items-center justify-between gap-2">
        <span className="min-w-0 truncate text-s font-medium fg-primary">
          {humanName(bases[page] ?? '')}
        </span>
        <div className="flex flex-wrap items-center gap-2">
          {canCompare || before || after ? (
            <SegmentedControl<Phase>
              label="Before or after"
              value={activePhase}
              onChange={setPhase}
              width="content"
              options={[
                ...(canCompare
                  ? [{ value: 'compare' as const, label: 'Compare' }]
                  : []),
                ...(before
                  ? [{ value: 'before' as const, label: 'Before' }]
                  : []),
                ...(after ? [{ value: 'after' as const, label: 'After' }] : []),
              ]}
            />
          ) : null}
          {before && !after ? (
            <span className="text-xs fg-tertiary">No after picture yet</span>
          ) : null}
          {after && !before ? (
            <span className="text-xs fg-tertiary">No before picture yet</span>
          ) : null}
          {themes.length > 1 ? (
            <SegmentedControl<string>
              label="Theme"
              value={theme}
              onChange={(v) => setPick((x) => ({ ...x, theme: v }))}
              width="content"
              options={themes.map((v) => ({ value: v, label: cap(v) }))}
            />
          ) : null}
          {platforms.length > 1 ? (
            <SegmentedControl<string>
              label="Platform"
              value={platform}
              onChange={(v) => setPick((x) => ({ ...x, platform: v }))}
              width="content"
              options={platforms.map((v) => ({ value: v, label: cap(v) }))}
            />
          ) : null}
        </div>
      </div>

      <Surface variant="group" className="overflow-hidden">
        <div className="group/stage relative h-88">
          {activePhase === 'compare' && before && after ? (
            <CompareSlider before={before} after={after} />
          ) : single ? (
            isVideoPath(single.path) ? (
              <video
                key={shotKey(single)}
                src={shotUrl(single)}
                controls={true}
                muted={true}
                preload="metadata"
                aria-label={`Video ${fileName(single.path)}`}
                className="absolute inset-0 h-full w-full object-scale-down p-4"
              />
            ) : (
              <button
                type="button"
                onClick={() => onShot(single)}
                aria-label={`Open ${fileName(single.path)} larger`}
                className="focus-ring absolute inset-0 cursor-zoom-in"
              >
                <FadeImage
                  key={shotKey(single)}
                  src={shotUrl(single)}
                  className="h-full w-full object-scale-down p-4"
                />
              </button>
            )
          ) : (
            <p className="absolute inset-0 flex items-center justify-center text-s fg-tertiary">
              No capture for this theme and platform
            </p>
          )}
          {bases.length > 1 ? (
            <>
              {/* The holder places and reveals each arrow on stage hover or
                keyboard focus; the button keeps its own look. */}
              <div className="absolute left-3 top-1/2 z-10 flex -translate-y-1/2 opacity-0 transition-opacity focus-within:opacity-100 group-hover/stage:opacity-100">
                <Button
                  variant="secondary"
                  size="md"
                  iconOnly
                  onClick={() => go(-1)}
                  aria-label="Previous"
                >
                  <ChevronRightIcon
                    size="sm"
                    aria-hidden={true}
                    className="rotate-180"
                  />
                </Button>
              </div>
              <div className="absolute right-3 top-1/2 z-10 flex -translate-y-1/2 opacity-0 transition-opacity focus-within:opacity-100 group-hover/stage:opacity-100">
                <Button
                  variant="secondary"
                  size="md"
                  iconOnly
                  onClick={() => go(1)}
                  aria-label="Next"
                >
                  <ChevronRightIcon size="sm" aria-hidden={true} />
                </Button>
              </div>
            </>
          ) : null}
        </div>
      </Surface>

      <div className="flex h-12 items-center gap-2">
        {bases.length > 1 ? (
          <div className="flex min-w-0 flex-1 gap-2 overflow-x-auto canopy-hide-scrollbar">
            {bases.map((b, i) => {
              const t = thumbFor(b);
              return (
                <Tooltip key={b} label={humanName(b)}>
                  <button
                    type="button"
                    onClick={() => setBaseIndex(i)}
                    aria-label={humanName(b)}
                    aria-current={i === page ? 'true' : undefined}
                    className={`focus-ring h-11 w-16 shrink-0 overflow-hidden rounded-md bg-tertiary ring-[length:var(--border-hairline)] transition-colors ${
                      i === page
                        ? 'ring-2 ring-line-secondary opacity-100'
                        : 'ring-line-base opacity-60 hover:opacity-100'
                    }`}
                  >
                    {t && !isVideoPath(t.path) ? (
                      <img
                        src={shotUrl(t)}
                        alt=""
                        loading="lazy"
                        className="h-full w-full object-cover object-top"
                      />
                    ) : null}
                  </button>
                </Tooltip>
              );
            })}
          </div>
        ) : (
          <span className="min-w-0 flex-1 truncate font-mono text-xs fg-tertiary">
            {single ? fileName(single.path) : ''}
          </span>
        )}
        <div className="flex shrink-0 items-center gap-3 text-xs fg-tertiary">
          {bases.length > 1 ? (
            <span className="tabular-nums">
              {page + 1} of {bases.length}
            </span>
          ) : null}
          {rest > 0 && all[0] ? (
            <Button variant="link" onClick={() => onShot(all[0])}>
              +{rest} more
            </Button>
          ) : null}
        </div>
      </div>
    </Stack>
  );
}

function Steps({
  activity,
  now,
}: {
  activity: Activity[];
  now: number;
}): JSX.Element {
  return (
    <ol className="flex flex-col gap-1.5" aria-label="Earlier steps">
      {activity.map((a, i) => (
        <li
          key={i}
          className="grid grid-cols-[6.5rem_minmax(0,1fr)_auto] items-baseline gap-3 text-xs"
        >
          <span className="truncate font-mono fg-tertiary">
            {a.kind === 'said' ? 'Reply' : a.kind}
          </span>
          <span
            className={`truncate ${a.sub ? 'fg-tertiary' : 'fg-secondary'}`}
          >
            {a.text}
          </span>
          <span className="tabular-nums fg-tertiary">{ago(a.at, now)}</span>
        </li>
      ))}
    </ol>
  );
}

function Thumbs({
  shots,
  now,
  onShot,
  caption,
}: {
  shots: Shot[];
  now: number;
  onShot: (s: Shot) => void;
  caption: 'name' | 'time';
}): JSX.Element {
  return (
    <ul
      className={`grid gap-3 ${caption === 'time' ? 'grid-cols-2' : 'grid-cols-[repeat(auto-fill,minmax(9rem,1fr))]'}`}
    >
      {shots.map((s) => (
        <li key={shotKey(s)} className="min-w-0">
          <button
            type="button"
            onClick={() => onShot(s)}
            aria-label={`Open screenshot ${fileName(s.path)}`}
            className="focus-ring group flex w-full flex-col gap-1.5 rounded-md text-left"
          >
            <img
              src={shotUrl(s)}
              alt=""
              loading="lazy"
              className="aspect-16/10 w-full rounded-md bg-secondary object-cover object-top ring-[length:var(--border-hairline)] ring-line-base transition-shadow group-hover:ring-line-secondary"
            />
            {caption === 'name' ? (
              <span className="truncate font-mono text-xs fg-tertiary">
                {fileName(s.path)}
              </span>
            ) : (
              <span className="text-xs tabular-nums fg-tertiary">
                {ago(s.at, now)}
              </span>
            )}
          </button>
        </li>
      ))}
    </ul>
  );
}

function Inline({ text }: { text: string }): JSX.Element {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g);
  return (
    <>
      {parts.map((part, i) =>
        part.startsWith('**') && part.endsWith('**') && part.length > 4 ? (
          <strong key={i} className="font-medium fg-primary">
            {part.slice(2, -2)}
          </strong>
        ) : part.startsWith('`') && part.endsWith('`') && part.length > 2 ? (
          <code
            key={i}
            className="rounded-sm bg-subtle px-1 font-mono text-xs fg-primary"
          >
            {part.slice(1, -1)}
          </code>
        ) : (
          <span key={i}>{part}</span>
        ),
      )}
    </>
  );
}

function Rich({ text }: { text: string }): JSX.Element {
  const blocks: { list: boolean; lines: string[] }[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    if (!line.trim()) {
      blocks.push({ list: false, lines: [] });
      continue;
    }
    const item = /^\s*(?:[-*]|\d+\.)\s+/.test(line);
    const last = blocks[blocks.length - 1];
    if (last && last.list === item && last.lines.length > 0)
      last.lines.push(line);
    else blocks.push({ list: item, lines: [line] });
  }
  return (
    <div className="flex max-w-[var(--chat-reading-width,42rem)] flex-col gap-2 text-s text-pretty fg-secondary">
      {blocks
        .filter((b) => b.lines.length > 0)
        .map((b, i) =>
          b.list ? (
            <ul
              key={i}
              className="flex list-disc flex-col gap-1 pl-5 marker:fg-quaternary"
            >
              {b.lines.map((l, j) => (
                <li key={j}>
                  <Inline text={l.replace(/^\s*(?:[-*]|\d+\.)\s+/, '')} />
                </li>
              ))}
            </ul>
          ) : (
            <p key={i}>
              <Inline text={b.lines.join(' ').replace(/^#+\s*/, '')} />
            </p>
          ),
        )}
    </div>
  );
}
