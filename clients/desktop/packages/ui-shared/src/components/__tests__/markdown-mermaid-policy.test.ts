import {
  canonicalizeMermaidEscapes,
  hasMermaidExternalCssResource,
  mermaidSourceIssue,
  planMermaidRender,
  prepareMermaidSource,
  MAX_MERMAID_SOURCE_LENGTH,
  type MermaidRenderPlan,
} from '../markdown-mermaid-policy';
import {
  DASHED_LINK_DIAGRAM,
  JOURNEY_BRIEF_DIAGRAM,
  MULTILINE_LABEL_DIAGRAM,
} from './fixtures/mermaid-diagrams';

describe('Mermaid rendering eligibility', () => {
  it('accepts literal angle-bracket placeholders in sequence message labels', () => {
    expect(
      mermaidSourceIssue(
        'sequenceDiagram\n  T-->>A: "vis_<uuid>" token + "shown above your reply"',
      ),
    ).toBeNull();
  });
  it('prepares only message-label placeholders without changing arrows or other grammar', () => {
    const source =
      '%% a comment\nsequenceDiagram\nA->>+B: <request_id> and <uuid>\nB-->>-A: <result>\nNote over A: <uuid>';
    expect(prepareMermaidSource(source)).toBe(
      '%% a comment\nsequenceDiagram\nA->>+B: #60;request_id#62; and #60;uuid#62;\nB-->>-A: #60;result#62;\nNote over A: <uuid>',
    );
    expect(source).toContain('<request_id>');
    expect(prepareMermaidSource('classDiagram\nA <|-- B')).toBe(
      'classDiagram\nA <|-- B',
    );
  });
  it('does not re-encode existing entity codes', () => {
    const source = 'sequenceDiagram\nA->>B: #60;uuid#62;';
    expect(prepareMermaidSource(source)).toBe(source);
    expect(
      prepareMermaidSource(
        prepareMermaidSource('sequenceDiagram\nA->>B: <uuid>'),
      ),
    ).toBe('sequenceDiagram\nA->>B: #60;uuid#62;');
  });
  it('bounds the prepared render input as well as authored source', () => {
    const source = 'sequenceDiagram\nA->>B: ' + '<id>'.repeat(1_000);
    expect(source.length).toBeLessThan(MAX_MERMAID_SOURCE_LENGTH);
    expect(mermaidSourceIssue(source)).toBe(
      'This diagram is too large to draw here.',
    );
  });
  it('canonicalizes YAML/JSON and CSS escape spellings before admission', () => {
    expect(canonicalizeMermaidEscapes('u\\72l')).toBe('url');
    expect(canonicalizeMermaidEscapes('u\\000072 l')).toBe('url');
    expect(canonicalizeMermaidEscapes('%% \\41\nclick')).toBe('%% A\nclick');
    expect(
      canonicalizeMermaidEscapes('\\x69mg \\u0069con \\U0000006cink'),
    ).toBe('img icon link');
    expect(canonicalizeMermaidEscapes('\\\\x69mg')).toBe('img');
  });
  it('detects URL-bearing CSS image functions while preserving local fragments', () => {
    expect(hasMermaidExternalCssResource('fill:url(#marker)')).toBe(false);
    expect(
      hasMermaidExternalCssResource(
        'mask-image:image("https://tracker.invalid")',
      ),
    ).toBe(true);
    expect(hasMermaidExternalCssResource('background:element(#outside)')).toBe(
      true,
    );
    expect(
      hasMermaidExternalCssResource(
        'background:-webkit-cross-fade(url(#a), url(#b), 50%)',
      ),
    ).toBe(true);
  });
  it.each([
    'flowchart LR\nA-->B',
    'graph TD\nA-->B',
    'sequenceDiagram\nA->>B: Hello',
    'classDiagram\nA <|-- B',
    'stateDiagram-v2\n[*] --> Ready',
    'erDiagram\nPERSON ||--o{ ORDER : places',
    'gantt\ntitle A plan\ndateFormat YYYY-MM-DD\nTask :2026-09-14, 1d',
  ])('accepts supported diagrams: %s', (source) => {
    expect(mermaidSourceIssue(source)).toBeNull();
  });
  it.each([
    'sequenceDiagram\nT-->>A: <uuid> <img src=https://tracker.invalid>',
    'sequenceDiagram\nT-->>A: <uuid> <script>alert(1)</script>',
    'sequenceDiagram\nT-->>A: <uuid> <svg/onload=alert(1)>',
    'sequenceDiagram\nT-->>A: <uuid> <\\x69mg src=https://tracker.invalid>',
    'sequenceDiagram\nT-->>A: <uuid>; click A "https://tracker.invalid"',
    'sequenceDiagram\nT-->>A: <uuid>\u2028link A: Tracker @ https://tracker.invalid',
    'sequenceDiagram\nparticipant A as <uuid>',
    'sequenceDiagram\nNote over A: <uuid>',
    'flowchart LR\nA["<uuid>"]',
    '%%{init: {"securityLevel":"loose"}}%%\nflowchart LR\nA-->B',
    '---\nconfig:\n  securityLevel: loose\n---\nflowchart LR\nA-->B',
    'flowchart LR\nA["<img src=https://tracker.invalid>"]',
    'flowchart LR\nA@{ img: "https://tracker.invalid" }',
    'flowchart LR\nA@{ "img": "https://tracker.invalid" }',
    'flowchart LR\nA@{ "\\x69mg": "https://tracker.invalid" }',
    'flowchart LR\nA@{ "icon" : "logos:github-icon" }',
    'flowchart LR\nclick A "https://tracker.invalid"',
    'flowchart LR\nA-->B\n%% \\41\nclick A "https://tracker.invalid"',
    'sequenceDiagram\nlink Alice: Dashboard @ https://tracker.invalid',
    'sequenceDiagram\nlinks Alice: {"Dashboard": "https://tracker.invalid"}',
    'sequenceDiagram\nAlice->>Bob: { "link": "https://tracker.invalid" }',
    'sequenceDiagram\nparticipant Alice\ndetails Alice: mermaid-sequence-details\nAlice->>Bob: Review',
    'flowchart LR\nclassDef bad fill:url(https://tracker.invalid)',
    'stateDiagram-v2\u2028classDef x mask-image:image-set("https://tracker.invalid/pixel")\u2028[*] --> A:::x',
    'stateDiagram-v2\u2029classDef x mask-image:-webkit-image-set("https://tracker.invalid/pixel")\u2029[*] --> A:::x',
    'stateDiagram-v2\u0085classDef x fill:red\u0085[*] --> A:::x',
    'sequenceDiagram\nrect u\\72l(https://tracker.invalid/pixel)\nAlice->>Bob: Review\nend',
    'gantt\ntodayMarker stroke:u\\72l(https://tracker.invalid/pixel)',
    'architecture-beta\nservice A(server)[Server]',
    'flowchart LR\nA["$$x$$"]',
  ])('keeps policy-limited input as source: %s', (source) => {
    expect(mermaidSourceIssue(source)).not.toBeNull();
  });
  it('bounds work independently of Mermaid configuration', () => {
    expect(
      mermaidSourceIssue(
        'flowchart LR\n' + 'A'.repeat(MAX_MERMAID_SOURCE_LENGTH),
      ),
    ).not.toBeNull();
    expect(
      mermaidSourceIssue('flowchart LR\n' + 'A-->B\n'.repeat(201)),
    ).not.toBeNull();
    expect(mermaidSourceIssue('')).not.toBeNull();
  });
});

describe('Mermaid styling admission', () => {
  const unsupported = "This diagram uses features that can't be drawn here.";
  const plan = (
    body: string,
    family = 'flowchart LR\nA-->B\n',
  ): MermaidRenderPlan => planMermaidRender(family + body);

  it('draws the exact journey brief with its pain-point highlighting', () => {
    expect(planMermaidRender(JOURNEY_BRIEF_DIAGRAM)).toEqual({
      issue: null,
      prepared: JOURNEY_BRIEF_DIAGRAM,
      droppedStyling: false,
    });
  });

  it.each([
    'style A fill:#f00,stroke:#00ff00,color:#0000ffcc',
    'style A fill:#ABCD,stroke:RebeccaPurple,color:currentColor',
    'style A fill:none,stroke:transparent',
    'classDef hot fill:red\nclass A,B hot',
    'classDef hot,warm fill:red\nA:::hot',
    'classDef default fill:#eee',
    'linkStyle 0 stroke:#f00,stroke-width:4px',
    'linkStyle 0,1 stroke:#f00',
    'linkStyle default stroke:blue',
    'style A stroke-width:2,stroke-dasharray:5 5',
    'style A stroke-width:1.5px,stroke-dasharray:none',
    'style A font-weight:bold',
    'style A font-weight:700',
    'style A fill : #f00 , stroke: blue',
    'style A fill:#f00;',
    'style A fill:#f00,fill:#0f0',
    'STYLE A fill:#f00',
  ])('leaves admitted styling byte-for-byte: %s', (body) => {
    const result = plan(body);
    expect(result.issue).toBeNull();
    expect(result.droppedStyling).toBe(false);
    expect(result.prepared).toBe('flowchart LR\nA-->B\n' + body);
  });

  it.each([
    'rgb(255,0,0)',
    'rgb(100%, 0%, 50%)',
    'rgba(255, 0, 0, 0.5)',
    'rgba(255,0,0,50%)',
    'rgb(255 0 0)',
    'rgb(255 0 0 / 0.5)',
    'rgba(100% 0% 0% / 25%)',
    'RGB(0 0 0)',
  ])('admits the bounded RGB grammar: %s', (color) => {
    const body = `style A fill:${color}`;
    expect(plan(body, 'stateDiagram-v2\n[*] --> A\n')).toEqual({
      issue: null,
      prepared: `stateDiagram-v2\n[*] --> A\n${body}`,
      droppedStyling: false,
    });
  });

  it.each([
    'rgb(256,0,0)',
    'rgb(255,0)',
    'rgb(255,0,0,0,0)',
    'rgb(255 0 0, 1)',
    'rgb(255,0,0 / 1)',
    'rgb(255 0 0 / 2)',
    'rgb(101% 0% 0%)',
    'rgb(100%,0,0)',
    'rgb(-1 0 0)',
    'rgb(1e3 0 0)',
    'rgb(NaN 0 0)',
    'rgb(1. 0 0)',
    'rgb((0) 0 0)',
    'rgb(0 0 0) red',
    '#12',
    '#12345',
    'reddish',
    'var(--x)',
    'expression(1)',
    'red !important',
    'url(#paint)',
  ])('drops an unsupported colour value: %s', (color) => {
    const result = plan(`style A stroke:#000,fill:${color}`);
    expect(result).toEqual({
      issue: null,
      prepared: 'flowchart LR\nA-->B\nstyle A stroke:#000',
      droppedStyling: true,
    });
  });

  it.each([
    ['style A fill:#f00,font-size:20px', 'style A fill:#f00'],
    ['style A opacity:0.5,fill:#f00', 'style A fill:#f00'],
    ['style A fill:#f00,stroke-width:-1', 'style A fill:#f00'],
    ['style A fill:#f00,stroke-width:2em', 'style A fill:#f00'],
    ['style A fill:#f00,font-weight:950', 'style A fill:#f00'],
    ['style A fill:#f00,stroke:#0f0,', 'style A fill:#f00,stroke:#0f0'],
    ['  classDef x fill:#f00,display:none;', '  classDef x fill:#f00;'],
    [
      'style A fill:#f00,fill:var(--x),fill:#0f0',
      'style A fill:#f00,fill:#0f0',
    ],
    ['linkStyle 0 stroke:#f00,animation:none', 'linkStyle 0 stroke:#f00'],
  ])('keeps surviving declarations in order: %s', (body, kept) => {
    expect(plan(body)).toEqual({
      issue: null,
      prepared: 'flowchart LR\nA-->B\n' + kept,
      droppedStyling: true,
    });
  });

  it.each([
    'classDef x font-size:20px',
    'style A opacity:0.5',
    'style A',
    'style',
    'classDef',
    'classDef x',
    'classDef x! fill:#f00',
    'style A.b fill:#f00',
    'linkStyle first stroke:#f00',
    'linkStyle 0 interpolate basis stroke:#f00',
    'style A fill:rgb(1,2,3',
    'style A fill:rgb(1,2,3))',
  ])('removes a bounded statement with nothing admissible: %s', (body) => {
    expect(plan(`${body}\nB-->C`)).toEqual({
      issue: null,
      prepared: 'flowchart LR\nA-->B\n\nB-->C',
      droppedStyling: true,
    });
  });

  it('draws the dashed approval path from the comma-spelled runbook', () => {
    expect(planMermaidRender(DASHED_LINK_DIAGRAM)).toEqual({
      issue: null,
      prepared: DASHED_LINK_DIAGRAM.replace(
        'stroke-dasharray:5,5',
        'stroke-dasharray:5 5',
      ),
      droppedStyling: false,
    });
  });

  it.each([
    [
      'linkStyle 0 stroke:#6b7280,stroke-dasharray:5,5',
      'linkStyle 0 stroke:#6b7280,stroke-dasharray:5 5',
    ],
    ['style A stroke-dasharray:4,2,1', 'style A stroke-dasharray:4 2 1'],
    [
      'style A stroke-dasharray:5,5,fill:#f00',
      'style A stroke-dasharray:5 5,fill:#f00',
    ],
    [
      'style A fill:#f00,stroke-dasharray:5,5',
      'style A fill:#f00,stroke-dasharray:5 5',
    ],
    ['style A stroke-dasharray: 5 , 5', 'style A stroke-dasharray: 5 5'],
    ['style A stroke-dasharray:5 5,3', 'style A stroke-dasharray:5 5 3'],
    [
      'classDef dashed stroke-dasharray:5,5;',
      'classDef dashed stroke-dasharray:5 5;',
    ],
    ['STYLE A Stroke-Dasharray:5,5', 'STYLE A Stroke-Dasharray:5 5'],
    [
      'style A stroke-dasharray:0,0.5,.25,10000',
      'style A stroke-dasharray:0 0.5 .25 10000',
    ],
    [
      'style A stroke:rgb(107, 114, 128),stroke-dasharray:5,5,fill:rgba(0,0,0,0.5)',
      'style A stroke:rgb(107, 114, 128),stroke-dasharray:5 5,fill:rgba(0,0,0,0.5)',
    ],
  ])('spells a comma dash pattern with spaces: %s', (body, normalized) => {
    expect(plan(body)).toEqual({
      issue: null,
      prepared: 'flowchart LR\nA-->B\n' + normalized,
      droppedStyling: false,
    });
  });

  it.each([
    ...['5px', 'abc', '-5', '1e3', '10001', '0000000000005', '5,abc'].map(
      (continuation) => `style A fill:#f00,stroke-dasharray:5,${continuation}`,
    ),
    ...['5px', 'abc', '-5', '10001', '0000000000005', 'none', ''].map(
      (head) => `style A fill:#f00,stroke-dasharray:${head},5`,
    ),
    'style A fill:#f00,stroke-width:2,5',
    'style A fill:#f00,stroke:#000,5',
  ])('drops a dash pattern with an invalid part: %s', (body) => {
    expect(plan(body)).toEqual({
      issue: null,
      prepared: 'flowchart LR\nA-->B\nstyle A fill:#f00',
      droppedStyling: true,
    });
  });

  it.each([
    // An empty fragment is not part of the pattern; the orphan number is removed.
    [
      'style A fill:#f00,stroke-dasharray:5,,5',
      'style A fill:#f00,stroke-dasharray:5',
    ],
    [
      'style A fill:#f00,stroke-dasharray:5,5,',
      'style A fill:#f00,stroke-dasharray:5 5',
    ],
    [
      'style A stroke-dasharray:5,5,font-size:9px',
      'style A stroke-dasharray:5 5',
    ],
    // A property ends the pattern, and only dash patterns absorb numbers.
    [
      'style A stroke-dasharray:5,stroke-width:2,5',
      'style A stroke-dasharray:5',
    ],
    [
      'style A stroke-dasharray:5,5\nstyle B fill:#f00,opacity:0',
      'style A stroke-dasharray:5 5\nstyle B fill:#f00',
    ],
  ])('keeps a joined pattern beside removed styling: %s', (body, kept) => {
    expect(plan(body)).toEqual({
      issue: null,
      prepared: 'flowchart LR\nA-->B\n' + kept,
      droppedStyling: true,
    });
  });

  it('joins several patterns without touching the surrounding source', () => {
    const lines = [
      'flowchart LR',
      'A-->B',
      'B-->C',
      '  linkStyle 0 stroke-dasharray:5,5',
      'style A fill:#f00',
      'classDef x stroke-dasharray:2,1;',
      'B-->C; style C stroke-dasharray:3,1',
    ];
    expect(planMermaidRender(lines.join('\r\n'))).toEqual({
      issue: null,
      prepared: lines
        .join('\r\n')
        .replace('5,5', '5 5')
        .replace('2,1', '2 1')
        .replace('3,1', '3 1'),
      droppedStyling: false,
    });
  });

  it('still refuses forbidden constructs beside a comma dash pattern', () => {
    expect(
      plan('style A stroke-dasharray:5,5\nclick A "https://tracker.invalid"'),
    ).toEqual({ issue: unsupported, prepared: '', droppedStyling: false });
  });

  it('keeps class assignments whose definitions were removed', () => {
    expect(plan('classDef big font-size:40px\nclass A big\nB:::big')).toEqual({
      issue: null,
      prepared: 'flowchart LR\nA-->B\n\nclass A big\nB:::big',
      droppedStyling: true,
    });
  });

  it('filters styling in state, class and entity relationship diagrams', () => {
    expect(
      planMermaidRender(
        'stateDiagram-v2\n[*] --> A\nclassDef x fill:#f00,font-size:9px\nclass A x',
      ).prepared,
    ).toBe('stateDiagram-v2\n[*] --> A\nclassDef x fill:#f00\nclass A x');
    expect(
      planMermaidRender('classDiagram\nclass A\nstyle A fill:#f00,opacity:0')
        .prepared,
    ).toBe('classDiagram\nclass A\nstyle A fill:#f00');
    expect(
      planMermaidRender(
        'erDiagram\nA ||--o{ B : has\nstyle A fill:#f00\nclassDef x stroke:#00f',
      ),
    ).toMatchObject({ issue: null, droppedStyling: false });
  });

  it('respects CRLF, CR, comments, quoted labels and semicolon statements', () => {
    expect(plan('style A fill:#f00,opacity:0\r\nB-->C\rC-->D').prepared).toBe(
      'flowchart LR\nA-->B\nstyle A fill:#f00\r\nB-->C\rC-->D',
    );
    const unchanged = [
      '%% style A font-size:99px',
      '  %% classDef x display:none',
      'A["x; style B font-size:99px"]-->B',
      'A["classDef x"]-->B',
      'A-->|go; then stop|B',
      'A[x; y]-->B',
      'A-->B; C-->D',
    ];
    for (const line of unchanged) {
      expect(plan(line)).toEqual({
        issue: null,
        prepared: 'flowchart LR\nA-->B\n' + line,
        droppedStyling: false,
      });
    }
    expect(plan('B-->C; style B fill:#f00,font-size:9px')).toEqual({
      issue: null,
      prepared: 'flowchart LR\nA-->B\nB-->C; style B fill:#f00',
      droppedStyling: true,
    });
    expect(plan('B-->C;style B font-size:9px').prepared).toBe(
      'flowchart LR\nA-->B\nB-->C;',
    );
  });

  it.each(['\n', '\r\n', '\r'])(
    'preserves directive-like text inside multiline quoted labels (%j)',
    (newline) => {
      const source = [
        'flowchart LR',
        'A["First line',
        'style A font-size:20px',
        'classDef pain opacity:0.5',
        'Last line"]-->B',
        'style B fill:red,opacity:0.5',
      ].join(newline);
      expect(planMermaidRender(source)).toEqual({
        issue: null,
        prepared: source.replace(
          'style B fill:red,opacity:0.5',
          'style B fill:red',
        ),
        droppedStyling: true,
      });
    },
  );

  it.each([
    [
      'flowchart LR',
      'accTitle: 6" pipe',
      'A-->B',
      'style A fill:red,opacity:0',
    ],
    [
      'flowchart LR',
      'accDescr: 6[" pipe',
      'A-->B',
      'style A fill:red,opacity:0',
    ],
    [
      'stateDiagram-v2',
      '[*] --> A',
      'A : 6[" pipe',
      'classDef x fill:red,display:none',
      'class A x',
    ],
    ['classDiagram', 'class A', 'A : 6" pipe', 'style A fill:red,opacity:0'],
    [
      'flowchart LR',
      'accDescr {',
      '6" pipe',
      '}',
      'A-->B',
      'style A fill:red,opacity:0',
    ],
    [
      'flowchart LR',
      'accDescr { 6[" pipe }',
      'A-->B',
      'style A fill:red,opacity:0',
    ],
    [
      'stateDiagram-v2',
      '[*] --> A',
      'A --> B : 6" pipe',
      'classDef x fill:red,display:none',
      'class A x',
    ],
    ['classDiagram', 'A --> B : 6" pipe', 'style A fill:red,opacity:0'],
    [
      'flowchart LR; accDescr {',
      'A["quoted-looking text',
      '}',
      'A-->B',
      'style A fill:red,opacity:0',
    ],
    ['flowchart LR; accTitle: 6[" pipe', 'A-->B', 'style A fill:red,opacity:0'],
    [
      'stateDiagram-v2',
      '[*] --> A',
      'A --> B : text; A[" pipe',
      'classDef x fill:red,display:none',
      'class A x',
    ],
    [
      'stateDiagram-v2',
      '[*] --> A',
      'note right of A',
      'state "first',
      'end note',
      'classDef x fill:red,display:none',
      'class A x',
    ],
    [
      'flowchart LR',
      'ACCDESCR {',
      'A["literal text',
      '}',
      'A-->B',
      'style A fill:red,opacity:0',
    ],
    [
      'stateDiagram-v2',
      '[*] --> A',
      'Note RIGHT OF A',
      'state "first',
      'END NOTE',
      'classDef x fill:red,display:none',
      'class A x',
    ],
    [
      'stateDiagram-v2',
      '[*] --> A',
      'note right of A',
      'end   note',
      'state "first',
      'end note',
      'classDef x fill:red,display:none',
      'class A x',
    ],
  ])(
    'does not let literal description quotes hide styling (%j)',
    (...lines) => {
      const source = lines.join('\n');
      expect(planMermaidRender(source)).toEqual({
        issue: null,
        prepared: source.replace(/,(?:opacity:0|display:none)/g, ''),
        droppedStyling: true,
      });
    },
  );

  it.each([
    'direction TB',
    'direction BT',
    'direction RL',
    'direction LR',
    '[[fork]]',
    '[[join]]',
    '[[choice]]',
  ])('refuses ambiguous state quotes beside literal markers (%s)', (marker) => {
    const source = `stateDiagram-v2\n[*] --> A\nstate "${marker}\nclassDef x fill:red,display:none\nclass A x`;
    const result = planMermaidRender(source);
    expect(result.issue).not.toBeNull();
    expect(result.prepared).toBe('');
  });

  it.each(['\n', '\r\n', '\r'])(
    'preserves multiline unquoted shape and edge labels (%j)',
    (newline) => {
      for (const [open, close] of [
        ['A[First line', 'Last line]-->B'],
        ['A>First line', 'Last line]-->B'],
        ['A -->|First line', 'Last line| B'],
      ]) {
        const authored = [
          'flowchart LR',
          open,
          'style A font-size:20px',
          'classDef pain opacity:0.5',
          close,
        ].join(newline);
        expect(planMermaidRender(authored)).toEqual({
          issue: null,
          prepared: authored,
          droppedStyling: false,
        });
        for (const separator of [newline, '; ']) {
          const source = authored + separator + 'style B fill:red,opacity:0.5';
          expect(planMermaidRender(source)).toEqual({
            issue: null,
            prepared: source.replace(
              'style B fill:red,opacity:0.5',
              'style B fill:red',
            ),
            droppedStyling: true,
          });
        }
      }
    },
  );

  it.each([
    'flowchart LR\nA[100%% done]-->B\nstyle A fill:red,opacity:0',
    'flowchart LR\nA-->|100%% done|B\nclassDef hidden fill:red,display:none\nclass B hidden',
  ])('preserves inline percent text without hiding styles (%s)', (source) => {
    expect(planMermaidRender(source)).toEqual({
      issue: null,
      prepared: source.replace(/,(?:opacity:0|display:none)/g, ''),
      droppedStyling: true,
    });
  });

  it.each([
    'flowchart LR\nA["100%% done"]-->B\nstyle B fill:red,display:none',
    'flowchart LR\nA["First\n%% "\nLast"]-->B["Second["]\nstyle B fill:red,display:none',
    'flowchart LR\naccDescr {\n%% }\nA["literal text\n}\nA-->B\nstyle B fill:red,display:none',
    'flowchart LR\nA>"First line\nstyle A font-size:20px\nLast line"]-->B\nstyle B fill:red,display:none',
  ])(
    'keeps literal/comment contexts from hiding actual styles (%s)',
    (source) => {
      expect(planMermaidRender(source)).toEqual({
        issue: null,
        prepared: source.replace(',display:none', ''),
        droppedStyling: true,
      });
    },
  );

  it.each(['TB', 'BT', 'RL', 'LR', 'TD'])(
    'refuses flowchart quote/direction lexer ambiguity (%s)',
    (direction) => {
      const source = `flowchart LR\nA["direction ${direction}\nB-->C\nclassDef hidden fill:red,display:none\nclass B hidden`;
      expect(planMermaidRender(source).issue).not.toBeNull();
      expect(planMermaidRender(source).prepared).toBe('');
    },
  );

  it.each([
    ['A--Read the', 'before checkout-->B'],
    ['A==Read the', 'before checkout==>B'],
    ['A-.Read the', 'before checkout.->B'],
  ])('preserves multiline bare edge labels (%s)', (open, close) => {
    const authored = ['flowchart LR', open, 'style guide', close].join('\n');
    expect(planMermaidRender(authored)).toEqual({
      issue: null,
      prepared: authored,
      droppedStyling: false,
    });
    const source = authored + '\nstyle B fill:red,opacity:0';
    expect(planMermaidRender(source)).toEqual({
      issue: null,
      prepared: source.replace(',opacity:0', ''),
      droppedStyling: true,
    });
  });

  it.each(['[', '(', '{', '|', '>'])(
    'refuses direction lines that would open false label state (%s)',
    (delimiter) => {
      for (const direction of ['TB', 'BT', 'RL', 'LR', 'TD']) {
        const source = `flowchart LR\ndirection ${direction} ${delimiter}\nA-->B\nstyle A fill:red,opacity:0`;
        expect(planMermaidRender(source)).toEqual({
          issue: unsupported,
          prepared: '',
          droppedStyling: false,
        });
      }
    },
  );

  it('distinguishes the shorthand graph direction from asymmetric nodes', () => {
    const source = 'flowchart >\nA-->B\nstyle B fill:red,opacity:0';
    expect(planMermaidRender(source)).toEqual({
      issue: null,
      prepared: source.replace(',opacity:0', ''),
      droppedStyling: true,
    });
  });

  it('does not treat a class member as a quoted state label', () => {
    const source =
      'classDiagram\nclass Theme {\nstate "first\n}\nstyle Theme fill:red,display:none';
    const result = planMermaidRender(source);
    expect(result.issue).not.toBeNull();
    expect(result.prepared).toBe('');
  });

  it('keeps multiline label text without reporting removed styling', () => {
    expect(planMermaidRender(MULTILINE_LABEL_DIAGRAM)).toEqual({
      issue: null,
      prepared: MULTILINE_LABEL_DIAGRAM,
      droppedStyling: false,
    });
    const source = 'flowchart LR\nA["a\\nb"]-->B;style B fill:red';
    expect(planMermaidRender(source)).toEqual({
      issue: null,
      prepared: source,
      droppedStyling: false,
    });
  });

  it.each([
    // Mermaid merges text after a semicolon into the same style statement.
    'style A fill:#f00; font-size:99px',
    'style A fill:#f00;B-->C',
    'classDef x fill:"#f00"',
    "classDef x fill:'#f00'",
    'style A fill:#f00 %% note',
    'style A fill:[#f00]',
    'style A fill:{#f00}',
    'style A fill:#f00,stroke-dasharray:5\\,5',
    'style-->B',
    'style:A',
    'A-->B %% ; style B font-size:99px',
    'A[x; style B font-size:99px',
    // Mermaid reads shape and edge-label text here, but the policy never guesses.
    'A[x; style B font-size:99px]-->B',
    'A-->|go; style B font-size:99px|B',
  ])('refuses styling whose boundary is ambiguous: %s', (body) => {
    expect(plan(body).issue).toBe(unsupported);
  });

  it('refuses escape-spelled styling instead of dropping it', () => {
    for (const body of [
      'classDef x fill:\\72ed',
      'style A fill:#f00,stroke:\\23 0f0',
      '\\73tyle A font-size:99px',
      'A-->B;\\73tyle A font-size:99px',
    ]) {
      expect(plan(body).issue).toBe(unsupported);
    }
    // Escapes elsewhere in the diagram do not block highlighting.
    expect(plan('B["a\\nb"]-->C\nstyle B fill:#f00').issue).toBeNull();
  });

  it('refuses styling beside line separators some lexers overlook', () => {
    for (const separator of ['\u0085', ' ', ' ']) {
      expect(plan(`style A fill:#f00${separator}B-->C`).issue).toBe(
        unsupported,
      );
      expect(plan(`B-->C${separator}classDef x fill:#f00`).issue).toBe(
        unsupported,
      );
      expect(plan(`B-->C\nlinkStyle${separator}0 stroke:#f00`).issue).toBe(
        unsupported,
      );
    }
  });

  it.each([
    'style A fill:url(https://tracker.invalid/pixel)',
    'style A fill:#f00,stroke:u\\72l(https://tracker.invalid/pixel)',
    'classDef x fill:#f00,mask-image:image-set("https://tracker.invalid")',
    'classDef x fill:#f00,background:cross-fade(url(#a), url(#b), 50%)',
    'classDef x fill:#f00,background:element(#outside)',
    'classDef x fill:#f00\n@import "https://tracker.invalid";',
    'style A fill:#f00\n%% hidden\nclick A "https://tracker.invalid"',
    'style A fill:#f00\nA@{ img: "https://tracker.invalid" }',
    'style A fill:#f00\nA["<img src=https://tracker.invalid>"]',
    'style A font-size:9px\nA["<img src=x>"]',
    'cssClass "A" hot\nstyle A fill:#f00',
    'style A fill:#f00\nlink A "https://tracker.invalid"',
  ])('refuses hostile constructs beside valid highlighting: %s', (body) => {
    expect(plan(body).issue).toBe(unsupported);
  });

  it('keeps refusing removable styling that sits next to a forbidden directive', () => {
    expect(
      planMermaidRender(
        'gantt\ntitle A\ndateFormat YYYY-MM-DD\nTask :2026-09-14, 1d\ntodayMarker stroke:#f00',
      ).issue,
    ).toBe(unsupported);
  });

  it('never exposes render input for a refused diagram', () => {
    expect(
      planMermaidRender('flowchart LR\nclick A "https://x.invalid"'),
    ).toEqual({ issue: unsupported, prepared: '', droppedStyling: false });
  });

  it('applies input and output budgets around filtering', () => {
    const many = 'style A fill:#f00,font-size:9px\n'.repeat(199);
    expect(plan(many, 'flowchart LR\n').issue).toBe(
      'This diagram is too large to draw here.',
    );
    expect(
      plan(
        'style A font-size:9px\n' + 'B-->C\n'.repeat(1_400),
        'flowchart LR\n',
      ).issue,
    ).toBe('This diagram is too large to draw here.');
  });

  it.each([
    'flowchart LR\nA-->B\nstyle A fill:#f00,opacity:0\nclassDef x font-size:9px\nclass B x',
    'flowchart LR\nA-->B\nstyle A fill:#f00,stroke-dasharray:5,5,opacity:0',
    DASHED_LINK_DIAGRAM,
  ])('is deterministic and idempotent: %j', (source) => {
    const first = planMermaidRender(source);
    expect(first.issue).toBeNull();
    expect(planMermaidRender(source)).toEqual(first);
    expect(planMermaidRender(first.prepared)).toEqual({
      issue: null,
      prepared: first.prepared,
      droppedStyling: false,
    });
  });

  it('maps plan copy onto the compatibility API', () => {
    expect(mermaidSourceIssue('')).toBe('Add diagram code to see it drawn.');
    expect(mermaidSourceIssue('pie\n"A": 1')).toBe(
      "This diagram couldn't be drawn.",
    );
    expect(mermaidSourceIssue(JOURNEY_BRIEF_DIAGRAM)).toBeNull();
  });
});
