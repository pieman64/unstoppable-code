import {
  canonicalizeMermaidEscapes,
  hasMermaidExternalCssResource,
  mermaidSourceIssue,
  prepareMermaidSource,
  MAX_MERMAID_SOURCE_LENGTH,
} from '../markdown-mermaid-policy';

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
      'This diagram is too large to preview. Its source is shown below.',
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
    'flowchart LR\nstyle A fill:red',
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
