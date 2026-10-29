import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { seedDemoWorkspaces } from '../demoWorkspaces.mjs';
import { seedWorktreeChat } from '../seeders/index.mjs';

export const DEMO_VISUAL_SCOPE = {
  projectId: 'demo-ts-pnpm-vite',
  worktreeId: 'demo-main',
};
export const DEMO_VISUAL_CHAT_ID = 'chat-visuals-demo';

const USERS_DOCUMENT = `<!doctype html><html><head><style>
.tiles{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:16px}
.tile{background:var(--bg-secondary);border-radius:var(--radius-md);padding:12px 14px}
.tile small{color:var(--fg-secondary);display:block}
.tile b{font-size:24px;font-weight:500}
.tile em{color:var(--fg-positive);font-style:normal;font-size:12px;margin-left:6px}
svg{display:block;width:100%;height:160px}
.axis{stroke:var(--line-secondary);stroke-width:1}
.series{fill:none;stroke:var(--chart-categorical-1);stroke-width:2}
.point{fill:var(--bg-base);stroke:var(--chart-categorical-1);stroke-width:2;cursor:pointer}
.point:hover{fill:var(--chart-categorical-1)}
.axis-labels{display:flex;justify-content:space-between;color:var(--fg-secondary);font-size:11px;margin-top:2px}
#readout{color:var(--fg-secondary);font-size:12px;height:18px;margin-top:4px}
</style></head><body>
<div class="tiles">
  <div class="tile"><small>Weekly active users</small><b>18,420</b><em>+6.2%</em></div>
  <div class="tile"><small>New sign-ups</small><b>1,275</b><em>+3.1%</em></div>
  <div class="tile"><small>Median session</small><b>14m 08s</b><em>+0.4%</em></div>
</div>
<svg viewBox="0 0 700 160" preserveAspectRatio="none" role="img" aria-label="Weekly active users, last eight weeks">
  <line class="axis" x1="0" y1="150" x2="700" y2="150"/>
  <polyline class="series" points="20,128 114,120 208,124 302,96 396,88 490,70 584,58 680,36"/>
  <g id="points"></g>
</svg>
<div class="axis-labels"><span>Aug 18</span><span>Oct 6</span></div>
<div id="readout">Hover a point to read its week.</div>
<script>
const weeks=[['Aug 18',15210,20,128],['Aug 25',15680,114,120],['Sep 1',15490,208,124],['Sep 8',16740,302,96],['Sep 15',17110,396,88],['Sep 22',17630,490,70],['Sep 29',17980,584,58],['Oct 6',18420,680,36]];
const group=document.getElementById('points'),readout=document.getElementById('readout');
for(const [week,users,x,y] of weeks){
  const point=document.createElementNS('http://www.w3.org/2000/svg','circle');
  point.setAttribute('class','point');point.setAttribute('cx',x);point.setAttribute('cy',y);point.setAttribute('r',5);
  point.addEventListener('mouseenter',()=>{readout.textContent='Week of '+week+': '+users.toLocaleString('en-US')+' active users';});
  group.appendChild(point);
}
</script></body></html>`;

const REVENUE_DOCUMENT = `<!doctype html><html><head><style>
header{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}
h1{font-size:14px;font-weight:500;margin:0}
button{font:inherit;color:var(--fg-primary);background:var(--bg-secondary);border:1px solid var(--line-secondary);border-radius:var(--radius-sm);padding:4px 10px;cursor:pointer}
.row{display:grid;grid-template-columns:120px 1fr 72px;align-items:center;gap:12px;padding:6px 0}
.row span:first-child{color:var(--fg-secondary)}
.track{background:var(--bg-secondary);border-radius:var(--radius-sm);height:14px;overflow:hidden}
.bar{background:var(--chart-categorical-1);height:100%}
.value{font-family:var(--font-mono);font-size:12px;text-align:right}
</style></head><body>
<header><h1>Revenue by region, Q3</h1><button id="sort" type="button">Sort by revenue</button></header>
<div id="rows"></div>
<script>
const regions=[['North America',412],['Europe',388],['Asia Pacific',301],['Latin America',164],['Middle East',97],['Africa',58]];
let sorted=false;
function draw(){
  const rows=sorted?[...regions].sort((a,b)=>b[1]-a[1]):[...regions].sort((a,b)=>a[0].localeCompare(b[0]));
  document.getElementById('rows').innerHTML=rows.map(([name,value])=>'<div class="row"><span>'+name+'</span><div class="track"><div class="bar" style="width:'+(value/412*100)+'%"></div></div><span class="value">$'+value+'k</span></div>').join('');
  document.getElementById('sort').textContent=sorted?'Sort by name':'Sort by revenue';
}
document.getElementById('sort').addEventListener('click',()=>{sorted=!sorted;draw();});
draw();
</script></body></html>`;

const PLANS_DOCUMENT = `<!doctype html><html><head><style>
table{border-collapse:collapse;width:100%}
th,td{text-align:left;padding:8px 12px;border-bottom:1px solid var(--line-secondary)}
th{color:var(--fg-secondary);font-weight:400;font-size:12px}
td.num{font-family:var(--font-mono);font-size:12px;text-align:right}
th.num{text-align:right}
td b{font-weight:500}
p{color:var(--fg-secondary);font-size:12px;font-style:italic;margin:10px 0 0}
</style></head><body>
<table>
<thead><tr><th>Plan</th><th>Best for</th><th class="num">Seats</th><th class="num">Monthly</th></tr></thead>
<tbody>
<tr><td><b>Starter</b></td><td>Solo projects and trials</td><td class="num">1</td><td class="num">$0</td></tr>
<tr><td><b>Team</b></td><td>Small teams shipping weekly</td><td class="num">10</td><td class="num">$240</td></tr>
<tr><td><b>Business</b></td><td>Several teams with shared review</td><td class="num">50</td><td class="num">$1,100</td></tr>
<tr><td><b>Enterprise</b></td><td>Organization-wide rollout</td><td class="num">250+</td><td class="num">Custom</td></tr>
</tbody></table>
<p>Prices are illustrative, for the fixture only.</p>
</body></html>`;

function reference({ visualId, title, html, maxHeight, heights }) {
  const bytes = Buffer.from(html, 'utf8');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  return Object.freeze({
    version: 1,
    visualId,
    artifactId: `sha256-v1-${sha256}`,
    byteLength: bytes.byteLength,
    sha256,
    mediaType: 'text/html',
    title,
    maxHeight,
    heights,
  });
}

function visual(index, title, html, height) {
  const visualId = `vis_123e4567-e89b-42d3-a456-42661417410${index}`;
  return Object.freeze({
    toolUseId: `toolu-demo-visual-${index}`,
    resultMessageId: `demo-visual-result-${index}`,
    title,
    html,
    reference: reference({
      visualId,
      title,
      html,
      maxHeight: 720,
      heights: [[800, height]],
    }),
  });
}

/** Three realistic visuals, in the order they appear in the chat. */
export const DEMO_VISUALS = Object.freeze([
  visual(1, 'Weekly active users', USERS_DOCUMENT, 300),
  visual(2, 'Revenue by region', REVENUE_DOCUMENT, 260),
  visual(3, 'Plan comparison', PLANS_DOCUMENT, 230),
]);

/**
 * Seeds one chat holding every demo visual into an existing profile. Each
 * visual is staged and promoted through the trusted provider path, exactly as
 * a ShowVisual call does.
 */
export async function seedDemoVisualChat({ userDataDir }) {
  const timestamp = Date.parse('2026-10-07T12:00:00Z');
  seedWorktreeChat({
    userDataDir,
    workspaceId: DEMO_VISUAL_SCOPE.projectId,
    worktreeId: DEMO_VISUAL_SCOPE.worktreeId,
    activeTabId: DEMO_VISUAL_CHAT_ID,
    providerType: 'codex',
    tabs: [
      {
        id: DEMO_VISUAL_CHAT_ID,
        title: 'Quarterly review',
        messages: [
          {
            id: 'demo-visual-user',
            role: 'user',
            timestamp,
            blocks: [
              {
                type: 'text',
                text: 'Summarize the quarter: usage, revenue by region, and our plans.',
              },
            ],
          },
        ],
      },
    ],
  });

  const previousDataDir = process.env.CANOPY_DATA_DIR;
  process.env.CANOPY_DATA_DIR = userDataDir;
  const { require: tsRequire, register } = await import('tsx/cjs/api');
  const unregister = register();
  try {
    createRequire(import.meta.url)(
      '../../../src/main/agents/delegation/recovery.ts',
    );
    const { ChatStateV2Repository } = tsRequire(
      '../../../src/main/services/chat-state-v2-repository.ts',
      import.meta.url,
    );
    const root = join(userDataDir, 'workspaces', DEMO_VISUAL_SCOPE.projectId);
    const repository = new ChatStateV2Repository({
      resolvePaths: () => ({
        tabs: join(root, 'chats', `${DEMO_VISUAL_SCOPE.worktreeId}.json`),
        archives: join(
          root,
          'chat-archives',
          `${DEMO_VISUAL_SCOPE.worktreeId}.json`,
        ),
        journal: join(
          root,
          'chat-journals',
          `${DEMO_VISUAL_SCOPE.worktreeId}.jsonl`,
        ),
      }),
    });
    await repository.getState(DEMO_VISUAL_SCOPE);
    for (const item of DEMO_VISUALS) {
      await repository.stageVisual(
        DEMO_VISUAL_SCOPE,
        { chatId: DEMO_VISUAL_CHAT_ID },
        {
          visualId: item.reference.visualId,
          html: item.html,
          title: item.title,
          maxHeight: item.reference.maxHeight,
          heights: item.reference.heights,
        },
      );
    }
    const notes = [
      'Usage grew every week but one. Here are the headline numbers.',
      'Revenue is concentrated in two regions.',
      'For reference, the current plans.',
    ];
    let offset = 0;
    const messages = DEMO_VISUALS.flatMap((item, index) => [
      {
        id: `demo-visual-note-${index + 1}`,
        role: 'assistant',
        timestamp: timestamp + (offset += 1),
        blocks: [{ type: 'text', text: notes[index] }],
      },
      {
        id: `demo-visual-call-${index + 1}`,
        role: 'assistant',
        timestamp: timestamp + (offset += 1),
        blocks: [
          {
            type: 'tool_use',
            toolUseId: item.toolUseId,
            toolName: 'canopy_show_visual',
            input: JSON.stringify({ title: item.title, html: '<hidden>' }),
          },
        ],
      },
      {
        id: item.resultMessageId,
        role: 'assistant',
        timestamp: timestamp + (offset += 1),
        blocks: [
          {
            type: 'tool_result',
            toolUseId: item.toolUseId,
            toolName: 'canopy_show_visual',
            output: `${item.reference.visualId} Shown to the user above your reply.`,
            isError: false,
          },
        ],
      },
    ]);
    messages.push(
      {
        id: 'demo-visual-final',
        role: 'assistant',
        timestamp: timestamp + (offset += 1),
        blocks: [
          {
            type: 'text',
            text: 'Those three cover usage, revenue, and plans.',
          },
        ],
      },
      {
        id: 'demo-visual-timer',
        role: 'system',
        timestamp: timestamp + (offset += 1),
        blocks: [
          {
            type: 'turn_timer',
            startedAt: timestamp,
            completedAt: timestamp + offset,
          },
        ],
      },
    );
    await repository.transactProviderEventWith(
      DEMO_VISUAL_SCOPE,
      () =>
        messages.map((message) => ({
          type: 'message.upserted',
          chatId: DEMO_VISUAL_CHAT_ID,
          message,
        })),
      { source: 'provider' },
      { resolveToolKey: () => 'show_visual' },
    );
    const state = await repository.getState(DEMO_VISUAL_SCOPE, {
      chatIds: [DEMO_VISUAL_CHAT_ID],
    });
    const tab = state.tabsFile.tabs.find(
      (candidate) => candidate.id === DEMO_VISUAL_CHAT_ID,
    );
    for (const item of DEMO_VISUALS) {
      const promoted = tab?.messages
        .find((message) => message.id === item.resultMessageId)
        ?.blocks.find((block) => block.type === 'tool_result')?.visualRef;
      if (promoted?.sha256 !== item.reference.sha256)
        throw new Error(`Demo visual was not promoted: ${item.title}`);
    }
    await repository.drainAll();
  } finally {
    unregister();
    if (previousDataDir === undefined) delete process.env.CANOPY_DATA_DIR;
    else process.env.CANOPY_DATA_DIR = previousDataDir;
  }
}

/** A desktop profile holding the demo visual chat in a seeded demo worktree. */
export async function seedDemoChatVisuals() {
  const userDataDir = mkdtempSync(join(tmpdir(), 'chat-visuals-demo-'));
  writeFileSync(
    join(userDataDir, 'preferences.json'),
    JSON.stringify({
      version: 1,
      preferences: {
        onboardingCompleted: ['v1'],
        defaultChatInterfaceMode: 'canopy',
        defaultWorktreeProvider: 'codex',
        defaultChatProvider: 'codex',
      },
    }),
  );
  seedDemoWorkspaces({ userDataDir, apps: ['ts-pnpm-vite'] });
  await seedDemoVisualChat({ userDataDir });
  return { userDataDir };
}
