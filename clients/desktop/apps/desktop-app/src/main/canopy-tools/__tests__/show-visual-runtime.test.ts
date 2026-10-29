import { executeShowVisual, type ShowVisualHost } from '../show-visual-runtime';
import {
  getAuthorizedFileRoots,
  readAuthorizedRegularFile,
} from '../../lib/authorized-file-open';
import type {
  StageVisualDocument,
  VisualStagingSidecar,
} from '../../lib/chat-visual-contracts';
import {
  VISUAL_PREVIEW_LIMITS,
  type VisualMeasureResult,
} from '../../browser/visual-preview-types';

jest.mock('../../codex/runtime-service', () => ({
  getCodexRuntimeService: (): {
    getCanonicalState: () => Promise<{ codexHome: string }>;
  } => ({
    getCanonicalState: (): Promise<{ codexHome: string }> =>
      Promise.resolve({ codexHome: '/codex' }),
  }),
}));

jest.mock('../../lib/authorized-file-open', () => ({
  getAuthorizedFileRoots: jest.fn(() =>
    Promise.resolve({ paths: ['/workspace'] }),
  ),
  readAuthorizedRegularFile: jest.fn(),
}));
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1]);
function setup(codexCallId?: string): {
  host: ShowVisualHost;
  staged: StageVisualDocument[];
} {
  const staged: StageVisualDocument[] = [];
  const host: ShowVisualHost = {
    scope: { projectId: 'project', worktreeId: 'worktree' },
    chatId: 'chat',
    cwd: '/workspace',
    codexCallId,
    stageVisual: (document) => {
      staged.push(document);
      return Promise.resolve({
        version: 1,
        visualId: document.visualId,
        chatId: 'chat',
        toolKey: 'show_visual',
        createdAt: 1,
        sha256: 'hash',
        byteLength: 1,
        title: document.title,
        maxHeight: document.maxHeight,
      } satisfies VisualStagingSidecar);
    },
  };
  return { host, staged };
}
beforeEach(() => {
  jest.clearAllMocks();
  jest.mocked(readAuthorizedRegularFile).mockResolvedValue(png);
});

test('strips BOM, trims title, stages once, and returns exact lowercase token first', async () => {
  const { host, staged } = setup('call-1');
  const result = await executeShowVisual(
    { html: '\uFEFF<p>hello</p>', title: ' Title ', height: 230 },
    host,
  );
  expect(result.text).toMatch(
    /^vis_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12} Shown to the user above your reply\. Don't announce, describe, or restate it; add only what it doesn't show\.$/,
  );
  expect(result.isError).toBeUndefined();
  expect(staged).toHaveLength(1);
  expect(staged[0]).toMatchObject({
    html: '<p>hello</p>',
    title: 'Title',
    maxHeight: 230,
    codexCallId: 'call-1',
  });
  expect(getAuthorizedFileRoots).not.toHaveBeenCalled();
});

test('rejects non-text and multibyte over cap; accepts near-cap HTML without Codex id', async () => {
  const { host, staged } = setup();
  expect(
    (
      await executeShowVisual(
        { html: '<p>\u0000</p>', title: 'x', height: 80 },
        host,
      )
    ).isError,
  ).toBe(true);
  expect(
    (await executeShowVisual({ html: '\ud800', title: 'x', height: 80 }, host))
      .isError,
  ).toBe(true);
  expect(
    (
      await executeShowVisual(
        { html: 'é'.repeat(256001), title: 'x', height: 80 },
        host,
      )
    ).isError,
  ).toBe(true);
  expect(
    (
      await executeShowVisual(
        { html: 'x'.repeat(500000), title: 'x', height: 80 },
        host,
      )
    ).isError,
  ).toBeUndefined();
  expect(staged).toHaveLength(1);
  expect(staged[0]).not.toHaveProperty('codexCallId');
});

test('inlines relative and absolute images, CSS URLs, and SVG; reuses duplicates', async () => {
  const { host, staged } = setup();
  jest
    .mocked(readAuthorizedRegularFile)
    .mockImplementation((path) =>
      Promise.resolve(
        path.endsWith('.svg')
          ? Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"></svg>')
          : png,
      ),
    );
  const result = await executeShowVisual(
    {
      html: '<img src="./a.png"><img src="/workspace/a.png"><style>x{background:url(assets/b.svg)}</style><img src="https://example.com/z.png">',
      title: 'x',
      height: 80,
    },
    host,
  );
  expect(result.isError).toBeUndefined();
  expect(staged[0].html).toContain('data:image/png;base64,');
  expect(staged[0].html).toContain('data:image/svg+xml;base64,');
  expect(staged[0].html).toContain('https://example.com/z.png');
  expect(readAuthorizedRegularFile).toHaveBeenCalledTimes(2);
  expect(getAuthorizedFileRoots).toHaveBeenCalledWith(host.scope, {
    images: true,
    extraRoots: ['/codex/generated_images'],
  });
});

test.each([
  [
    'an SVG 1.1 DOCTYPE',
    '<?xml version="1.0"?>\n<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n<svg xmlns="http://www.w3.org/2000/svg"></svg>',
  ],
  [
    'a DOCTYPE after a comment',
    '<!-- exported --><!DOCTYPE svg><svg xmlns="http://www.w3.org/2000/svg"></svg>',
  ],
])('inlines an SVG with %s', async (_case, svg) => {
  const { host, staged } = setup();
  jest.mocked(readAuthorizedRegularFile).mockResolvedValue(Buffer.from(svg));
  const result = await executeShowVisual(
    { html: '<img src="./chart.svg">', title: 'x', height: 80 },
    host,
  );
  expect(result.isError).toBeUndefined();
  expect(staged[0].html).toContain('data:image/svg+xml;base64,');
});

test('refuses a DOCTYPE that does not declare an SVG root', async () => {
  const { host, staged } = setup();
  jest
    .mocked(readAuthorizedRegularFile)
    .mockResolvedValue(Buffer.from('<!DOCTYPE html><html></html>'));
  const result = await executeShowVisual(
    { html: '<img src="./page.svg">', title: 'x', height: 80 },
    host,
  );
  expect(result.isError).toBe(true);
  expect(staged).toHaveLength(0);
});

test('refuses missing, unauthorized, and disguised images without staging', async () => {
  const { host, staged } = setup();
  jest
    .mocked(readAuthorizedRegularFile)
    .mockRejectedValueOnce(new Error('denied'))
    .mockResolvedValueOnce(Buffer.from('secret'));
  const result = await executeShowVisual(
    {
      html: '<img src="../outside.png"><img src="missing.png">',
      title: 'x',
      height: 80,
    },
    host,
  );
  expect(result).toEqual({
    text: 'These images could not be read: ../outside.png, missing.png. Use paths inside the workspace, or remove them.',
    isError: true,
  });
  expect(staged).toHaveLength(0);
});

test('rejects more than 32 distinct images', async () => {
  const { host, staged } = setup();
  const html = Array.from({ length: 33 }, (_, i) => `'<img${i}.png'`).join('');
  const result = await executeShowVisual(
    { html, title: 'x', height: 80 },
    host,
  );
  expect(result.isError).toBe(true);
  expect(staged).toHaveLength(0);
});

test('rejects images above 2 MiB and a prepared document above 4 MiB', async () => {
  const { host, staged } = setup();
  jest
    .mocked(readAuthorizedRegularFile)
    .mockResolvedValueOnce(Buffer.concat([png, Buffer.alloc(2 * 1024 * 1024)]));
  const tooLarge = await executeShowVisual(
    { html: '<img src="big.png">', title: 'x', height: 80 },
    host,
  );
  expect(tooLarge.isError).toBe(true);
  jest
    .mocked(readAuthorizedRegularFile)
    .mockResolvedValue(Buffer.concat([png, Buffer.alloc(1500000)]));
  const preparedTooLarge = await executeShowVisual(
    {
      html: '<img src="a.png"><img src="b.png"><img src="c.png">',
      title: 'x',
      height: 80,
    },
    host,
  );
  expect(preparedTooLarge.isError).toBe(true);
  expect(staged).toHaveLength(0);
});

const measuredHeights: ReadonlyArray<readonly [number, number]> = [
  [360, 240],
  [520, 300],
  [720, 400],
  [960, 500],
];

test('measures prepared HTML at the four ordered widths before staging', async () => {
  const { host, staged } = setup();
  const measure = jest.fn(() =>
    Promise.resolve({
      status: 'ok' as const,
      heights: measuredHeights,
    }),
  );
  host.measureVisual = measure;
  const result = await executeShowVisual(
    { html: '<p>chart</p>', title: 'Chart', height: 600 },
    host,
  );
  expect(result.isError).toBeUndefined();
  expect(measure).toHaveBeenCalledWith(
    { html: '<p>chart</p>', unresolvedImagePaths: [] },
    expect.objectContaining({
      maxHeight: 600,
      widths: VISUAL_PREVIEW_LIMITS.measureWidths,
      deadlineMs: 3000,
    }),
  );
  expect(staged[0].heights).toEqual(measuredHeights);
});

test('records valid measurements in requested width order', async () => {
  const { host, staged } = setup();
  host.measureVisual = (): Promise<VisualMeasureResult> =>
    Promise.resolve({
      status: 'ok' as const,
      heights: [...measuredHeights].reverse(),
    });
  await executeShowVisual(
    { html: '<p>chart</p>', title: 'Chart', height: 600 },
    host,
  );
  expect(staged[0].heights).toEqual(measuredHeights);
});

test('times out measurement after three seconds, aborts it, and still stages', async () => {
  jest.useFakeTimers();
  try {
    const { host, staged } = setup();
    let signal: AbortSignal | undefined;
    host.measureVisual = jest.fn((_prepared, options) => {
      signal = options.signal;
      return new Promise(() => undefined);
    });
    const showing = executeShowVisual(
      { html: '<p>chart</p>', title: 'Chart', height: 600 },
      host,
    );
    await jest.advanceTimersByTimeAsync(2999);
    expect(staged).toHaveLength(0);
    await jest.advanceTimersByTimeAsync(1);
    expect((await showing).isError).toBeUndefined();
    expect(signal?.aborted).toBe(true);
    expect(staged[0].heights).toBeUndefined();
  } finally {
    jest.useRealTimers();
  }
});

test.each(['busy', 'error', 'aborted'] as const)(
  'stages without heights for %s measurement',
  async (status) => {
    const { host, staged } = setup();
    host.measureVisual = jest.fn(() =>
      Promise.resolve({ status, heights: [] }),
    );
    expect(
      (
        await executeShowVisual(
          { html: '<p>chart</p>', title: 'Chart', height: 600 },
          host,
        )
      ).isError,
    ).toBeUndefined();
    expect(staged[0].heights).toBeUndefined();
  },
);

test.each([
  ['malformed', [[360, 200, 1]]],
  [
    'duplicate width',
    [
      [360, 200],
      [360, 250],
      [720, 300],
      [960, 400],
    ],
  ],
  [
    'missing width',
    [
      [360, 200],
      [520, 250],
      [720, 300],
    ],
  ],
  [
    'unrequested width',
    [
      [360, 200],
      [520, 250],
      [720, 300],
      [1000, 400],
    ],
  ],
  [
    'non-finite',
    [
      [360, Number.NaN],
      [520, 250],
      [720, 300],
      [960, 400],
    ],
  ],
  [
    'oversized',
    [
      [360, 601],
      [520, 250],
      [720, 300],
      [960, 400],
    ],
  ],
  [
    'undersized',
    [
      [360, 79],
      [520, 250],
      [720, 300],
      [960, 400],
    ],
  ],
])(
  'rejects %s measurement without failing publishing',
  async (_name, heights) => {
    const { host, staged } = setup();
    host.measureVisual = jest.fn(() =>
      Promise.resolve({ status: 'ok' as const, heights }),
    );
    expect(
      (
        await executeShowVisual(
          { html: '<p>chart</p>', title: 'Chart', height: 600 },
          host,
        )
      ).isError,
    ).toBeUndefined();
    expect(staged[0].heights).toBeUndefined();
  },
);

test('a throwing measurement still stages, and staging failure text is unchanged', async () => {
  const { host, staged } = setup();
  host.measureVisual = jest.fn(() =>
    Promise.reject(new Error('measurement failed')),
  );
  const input = { html: '<p>chart</p>', title: 'Chart', height: 600 };
  expect((await executeShowVisual(input, host)).isError).toBeUndefined();
  expect(staged[0].heights).toBeUndefined();
  host.stageVisual = jest.fn(() => Promise.reject(new Error('staging failed')));
  expect(await executeShowVisual(input, host)).toEqual({
    text: 'The visual could not be shown in this chat. Check that the chat is still open, then try again.',
    isError: true,
  });
});
