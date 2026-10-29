// Test-only Electron host for the canonical shared Portal Chats component.
import { build } from 'esbuild';
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { seedPanelWorktree } from './panelHarness.mjs';
import { closeCanopy } from './launchCanopy.mjs';
export async function launchPortalChatsGroupCompositionHarness() {
  const root = process.cwd();
  const dir = path.join(
    root,
    '.playwright/merge-stack-sidebar-groups/chats-component-host',
  );
  mkdirSync(dir, { recursive: true });
  const js = path.join(dir, 'fixture.js');
  await build({
    stdin: {
      resolveDir: root,
      loader: 'tsx',
      contents: `
      import {useState} from 'react'; import {createRoot} from 'react-dom/client';
      import {StandaloneChatsSidebarSection} from './packages/ui-app/src/code/shell/StandaloneChatsSidebarSection';
      const workspace={localId:'cowork-default',name:'Chats',type:'cowork',layout:'flat',itemGroups:[{id:'grp-work',name:'Release',color:'neutral',collapsed:false,memberIds:['entry-a','entry-b']}]};
      const snapshot={workspaces:[workspace],standaloneChats:['a','b'].map((suffix)=>({localId:suffix,projectLocalId:workspace.localId,workEntryId:'entry-'+suffix,title:suffix==='a'?'Research task':'Other task',workEntryLastMessageAt:'2026-01-01T00:00:00.000Z'}))};
      function Host(){
        const [collapsed,setCollapsed]=useState(false);const [choice,setChoice]=useState('all');
        return <main data-testid="chats-composition-host" className="bg-sidebar fg-primary p-4" style={{width:360,minHeight:350}}>
          <StandaloneChatsSidebarSection workspace={workspace} snapshot={snapshot} headerPresentation="section" selectedStandaloneChatId="a" onSelectChat={()=>{}} collapsed={collapsed} onCollapsedChange={setCollapsed}
            testIds={{sectionToggle:'fixture-chats-toggle'}} itemGroupCommands={{create:async()=>workspace.itemGroups[0],update:()=>{},ungroup:()=>{},moveItem:()=>{},moveGroup:()=>{}}}
            workEntryNotifications={{getState:()=>({status:'ready',override:choice==='all'?null:choice}),onOpen:()=>{},onSelect:(_workspace,_entry,next)=>setChoice(next)}}/>
          <output data-testid="fixture-notification-choice">{choice}</output>
        </main>;
      }createRoot(document.getElementById('root')).render(<Host/>);
    `,
    },
    outfile: js,
    bundle: true,
    platform: 'browser',
    format: 'iife',
    jsx: 'automatic',
    loader: { '.css': 'empty' },
    define: { 'process.env.NODE_ENV': '"production"' },
    alias: {
      react: path.join(root, 'node_modules/react'),
      'react-dom': path.join(root, 'node_modules/react-dom'),
    },
  });
  const assets = path.join(root, 'out-e2e/renderer/assets');
  const css = readdirSync(assets).filter((name) => name.endsWith('.css'));
  const html = path.join(dir, 'fixture.html');
  writeFileSync(
    html,
    `<!doctype html><html class="${process.env.CANOPY_E2E_CAPTURE_COLOR_MODE === 'dark' ? 'dark' : ''}" data-theme="default" data-color-mode="${process.env.CANOPY_E2E_CAPTURE_COLOR_MODE ?? 'light'}"><head>${css.map((name) => `<link rel="stylesheet" href="${pathToFileURL(path.join(assets, name))}">`).join('')}</head><body><div id="root"></div><script src="${pathToFileURL(js)}"></script></body></html>`,
  );
  const app = await seedPanelWorktree();
  try {
    await app.window.goto(pathToFileURL(html).href);
    await app.window.getByTestId('chats-composition-host').waitFor();
    return app;
  } catch (error) {
    await closeCanopy(app.electronApp, app.userDataDir);
    throw error;
  }
}
