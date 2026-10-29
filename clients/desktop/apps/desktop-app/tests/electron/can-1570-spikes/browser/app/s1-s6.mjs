import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const S1_HTML = `<!doctype html>
<meta charset="utf-8">
<title>CAN-1570 S1 input fixture</title>
<style>
  html, body { margin: 0; width: 100%; height: 100%; font: 16px sans-serif; }
  #mouseTarget, #zoomTarget, #dialogTarget { position: absolute; left: 32px; width: 160px; height: 42px; }
  #mouseTarget { top: 28px; }
  #keyTarget { position: absolute; left: 32px; top: 88px; width: 240px; height: 32px; }
  #zoomTarget { top: 142px; }
  #dialogTarget { top: 194px; }
  #scrollBox { position: absolute; left: 32px; top: 252px; width: 360px; height: 200px; overflow: auto; border: 1px solid; }
  #scrollContent { height: 1600px; background: linear-gradient(white, #ddd); }
</style>
<button id="mouseTarget">mouse target</button>
<input id="keyTarget" value="seed">
<button id="zoomTarget">zoom target</button>
<button id="dialogTarget" onmousedown="alert('CAN-1570 dialog probe')">dialog target</button>
<div id="scrollBox"><div id="scrollContent">scroll content</div></div>
<script>
  (() => {
    const state = { events: [], buttonClicks: 0, zoomClicks: 0, inputEvents: 0 };
    const describe = (event) => ({
      type: event.type,
      targetId: event.target && event.target.id || event.target && event.target.tagName || null,
      currentTarget: event.currentTarget && event.currentTarget.id || null,
      clientX: Number.isFinite(event.clientX) ? event.clientX : null,
      clientY: Number.isFinite(event.clientY) ? event.clientY : null,
      key: event.key || null,
      code: event.code || null,
      button: Number.isFinite(event.button) ? event.button : null,
      buttons: Number.isFinite(event.buttons) ? event.buttons : null,
      deltaX: Number.isFinite(event.deltaX) ? event.deltaX : null,
      deltaY: Number.isFinite(event.deltaY) ? event.deltaY : null,
    });
    for (const type of ['pointermove', 'pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'keydown', 'keyup', 'beforeinput', 'input', 'wheel', 'scroll', 'focus', 'blur']) {
      document.addEventListener(type, (event) => state.events.push(describe(event)), true);
    }
    document.getElementById('mouseTarget').addEventListener('click', () => state.buttonClicks++);
    document.getElementById('zoomTarget').addEventListener('click', () => state.zoomClicks++);
    document.getElementById('keyTarget').addEventListener('input', () => state.inputEvents++);
    window.__probeReset = () => {
      state.events.length = 0;
      state.buttonClicks = 0;
      state.zoomClicks = 0;
      state.inputEvents = 0;
      document.getElementById('keyTarget').value = '';
      document.getElementById('scrollBox').scrollTop = 0;
      document.documentElement.scrollTop = 0;
      document.body.scrollTop = 0;
    };
    window.__probeReadback = () => {
      const rect = (id) => {
        const element = document.getElementById(id);
        const box = element.getBoundingClientRect();
        return { x: box.x, y: box.y, width: box.width, height: box.height };
      };
      const keyTarget = document.getElementById('keyTarget');
      return {
        events: state.events.slice(),
        buttonClicks: state.buttonClicks,
        zoomClicks: state.zoomClicks,
        inputEvents: state.inputEvents,
        inputValue: keyTarget.value,
        activeElement: document.activeElement && document.activeElement.id || document.activeElement && document.activeElement.tagName || null,
        hasFocus: document.hasFocus(),
        visibilityState: document.visibilityState,
        scrollBoxTop: document.getElementById('scrollBox').scrollTop,
        pageScrollTop: document.scrollingElement ? document.scrollingElement.scrollTop : null,
        zoomTarget: rect('zoomTarget'),
        devicePixelRatio: window.devicePixelRatio,
        visualViewportScale: window.visualViewport ? window.visualViewport.scale : null,
      };
    };
  })();
</script>`;

const OVERLAY_HTML = `<!doctype html><meta charset="utf-8"><title>CAN-1570 overlay fixture</title>
<style>html,body,#overlayTarget{margin:0;width:100%;height:100%;}#overlayTarget{display:grid;place-items:center;background:rgba(160,20,20,.96);color:white;font:24px sans-serif}</style>
<div id="overlayTarget">app overlay</div>
<script>window.__overlayEvents=[];for(const type of ['pointerdown','mousedown','click','keydown','wheel'])document.addEventListener(type,e=>window.__overlayEvents.push({type,target:e.target.id||e.target.tagName,clientX:e.clientX||0,clientY:e.clientY||0}),true);window.__overlayReadback=()=>({events:window.__overlayEvents.slice(),hasFocus:document.hasFocus()});</script>`;

const S6_HTML = `<!doctype html>
<meta charset="utf-8"><title>CAN-1570 S6 drag fixture</title>
<style>
  html,body{margin:0;font:16px sans-serif} .box{position:absolute;width:210px;height:110px;border:2px dashed #555;display:grid;place-items:center}
  #source{left:30px;top:30px;width:145px;height:60px;background:#def;border:1px solid #356;cursor:grab}
  #dropTarget{left:250px;top:30px;background:#efe}
  #fileDrop{left:30px;top:190px;width:430px;height:150px;background:#f4f0e8}
</style>
<div id="source" draggable="true">HTML5 drag source</div>
<div id="dropTarget" class="box">HTML5 drop target</div>
<div id="fileDrop" class="box">synthetic file drop target</div>
<script>
  (() => {
    const state = { sourceEvents: [], targetEvents: [], fileEvents: [], html5Drops: [], fileDrops: [], pendingFiles: null };
    document.getElementById('source').addEventListener('dragstart', (event) => {
      event.dataTransfer.setData('text/plain', 'CAN-1570 HTML5 drag payload');
      event.dataTransfer.setData('text/uri-list', location.origin + '/synthetic-drag');
      state.sourceEvents.push({type:'dragstart',types:Array.from(event.dataTransfer.types)});
    });
    const dropTarget = document.getElementById('dropTarget');
    for (const type of ['dragenter','dragover','drop']) dropTarget.addEventListener(type, (event) => {
      if (type !== 'drop') event.preventDefault();
      if (type === 'drop') {
        event.preventDefault();
        state.html5Drops.push({type, text:event.dataTransfer.getData('text/plain'), types:Array.from(event.dataTransfer.types), files:Array.from(event.dataTransfer.files).map(file=>({name:file.name,size:file.size,type:file.type}))});
      } else state.targetEvents.push({type,types:Array.from(event.dataTransfer.types)});
    });
    const fileDrop = document.getElementById('fileDrop');
    for (const type of ['dragenter','dragover','drop']) fileDrop.addEventListener(type, (event) => {
      if (type !== 'drop') event.preventDefault();
      if (type === 'drop') {
        event.preventDefault();
        const files = Array.from(event.dataTransfer.files);
        state.fileEvents.push({type, types:Array.from(event.dataTransfer.types), names:files.map(file=>file.name)});
        state.pendingFiles = Promise.all(files.map(async (file) => ({
          name:file.name,
          size:file.size,
          type:file.type,
          text:await file.text(),
          bytes:Array.from(new Uint8Array(await file.arrayBuffer())),
        }))).then((readback) => { state.fileDrops = readback; return readback; });
      } else state.fileEvents.push({type,types:Array.from(event.dataTransfer.types)});
    });
    window.__dragReadback = () => ({sourceEvents:state.sourceEvents.slice(),targetEvents:state.targetEvents.slice(),fileEvents:state.fileEvents.slice(),html5Drops:state.html5Drops.slice(),fileDrops:state.fileDrops.slice()});
  })();
</script>`;

function errorText(error) {
  return String(error?.stack ?? error);
}

function compactInput(input) {
  return {
    type: input?.type ?? null,
    key: input?.key ?? null,
    code: input?.code ?? null,
    alt: Boolean(input?.alt),
    control: Boolean(input?.control),
    meta: Boolean(input?.meta),
    shift: Boolean(input?.shift),
    text: input?.text ?? null,
    isAutoRepeat: Boolean(input?.isAutoRepeat),
  };
}

// Faithful local transcription of browser-shortcuts.ts's pure resolver. This
// spike deliberately does not import production code so the observed CDP
// before-input-event records can be compared without coupling the probe.
function copiedShortcutPredicate(input, platform) {
  if (input.type !== 'keyDown' || input.shift) return null;
  if (platform === 'darwin') {
    if (!input.meta || input.control || input.alt) return null;
    return (
      {
        KeyT: 'new-tab',
        KeyL: 'focus-address-bar',
        KeyB: 'toggle-sidebar',
        ArrowLeft: 'back',
        ArrowRight: 'forward',
      }[input.code] ?? null
    );
  }
  if (input.control && !input.meta && !input.alt) {
    return (
      { KeyT: 'new-tab', KeyL: 'focus-address-bar', KeyB: 'toggle-sidebar' }[
        input.code
      ] ?? null
    );
  }
  if (input.alt && !input.control && !input.meta) {
    return { ArrowLeft: 'back', ArrowRight: 'forward' }[input.code] ?? null;
  }
  return null;
}

function beforeInputObserver(view) {
  const records = [];
  const listener = (_event, input) => {
    const normalized = compactInput(input);
    records.push({
      seq: records.length,
      atMs: performance.now(),
      input: normalized,
      predictedBrowserShortcut: copiedShortcutPredicate(
        normalized,
        process.platform,
      ),
    });
  };
  view.wc.on('before-input-event', listener);
  return {
    records,
    remove: () => view.wc.removeListener('before-input-event', listener),
  };
}

async function send(view, method, params = {}, sessionId) {
  try {
    return {
      status: 'resolved',
      result: await view.send(method, params, sessionId),
    };
  } catch (error) {
    return { status: 'error', error: errorText(error) };
  }
}

async function evaluate(view, expression, sessionId) {
  try {
    return {
      status: 'read',
      value: await view.evaluate(expression, sessionId),
    };
  } catch (error) {
    return { status: 'error', error: errorText(error) };
  }
}

async function readback(view) {
  return evaluate(view, 'window.__probeReadback()');
}

async function rectCenter(view, selector) {
  return view.evaluate(
    `(() => { const e = document.querySelector(${JSON.stringify(selector)}); if (!e) throw new Error('missing ' + ${JSON.stringify(selector)}); const r = e.getBoundingClientRect(); return { x:r.x+r.width/2, y:r.y+r.height/2, rect:{x:r.x,y:r.y,width:r.width,height:r.height} }; })()`,
  );
}

function hostState(view) {
  try {
    return {
      windowVisible: view.window.isVisible(),
      paneVisible: view.view.getVisible(),
      focusEmulation: view.focusEmulation,
      windowFocused: view.window.isFocused(),
      webContentsFocused: view.wc.isFocused(),
      paneBounds: view.view.getBounds(),
      windowDestroyed: view.window.isDestroyed(),
      webContentsDestroyed: view.wc.isDestroyed(),
    };
  } catch (error) {
    return { error: errorText(error) };
  }
}

async function runInputOperation(view, name, beforeInput) {
  const commandsStart = view.commands.length;
  const eventsStart = view.events.length;
  const beforeInputStart = beforeInput.records.length;
  const setup = await evaluate(view, 'window.__probeReset(); true');
  let point;
  let focusSetup = null;
  if (name === 'mouse')
    point = await rectCenter(view, '#mouseTarget').catch((error) => ({
      error: errorText(error),
    }));
  if (name === 'key') {
    focusSetup = await evaluate(
      view,
      "(() => { const e=document.getElementById('keyTarget'); e.focus(); return {active:document.activeElement.id,hasFocus:document.hasFocus()}; })()",
    );
  }
  if (name === 'wheel' || name === 'scrollGesture')
    point = await rectCenter(view, '#scrollBox').catch((error) => ({
      error: errorText(error),
    }));
  const before = await readback(view);
  const commandResults = [];
  if (name === 'mouse') {
    const x = point?.x ?? 100;
    const y = point?.y ?? 45;
    commandResults.push(
      await send(view, 'Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x,
        y,
        button: 'none',
        buttons: 0,
      }),
    );
    commandResults.push(
      await send(view, 'Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x,
        y,
        button: 'left',
        buttons: 1,
        clickCount: 1,
      }),
    );
    commandResults.push(
      await send(view, 'Input.dispatchMouseEvent', {
        type: 'mouseReleased',
        x,
        y,
        button: 'left',
        buttons: 0,
        clickCount: 1,
      }),
    );
  } else if (name === 'key') {
    commandResults.push(
      await send(view, 'Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: 'x',
        code: 'KeyX',
        text: 'x',
        unmodifiedText: 'x',
        windowsVirtualKeyCode: 88,
        nativeVirtualKeyCode: 88,
      }),
    );
    commandResults.push(
      await send(view, 'Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'x',
        code: 'KeyX',
        windowsVirtualKeyCode: 88,
        nativeVirtualKeyCode: 88,
      }),
    );
  } else if (name === 'wheel') {
    const x = point?.x ?? 100;
    const y = point?.y ?? 300;
    commandResults.push(
      await send(view, 'Input.dispatchMouseEvent', {
        type: 'mouseWheel',
        x,
        y,
        deltaX: 0,
        deltaY: 180,
        modifiers: 0,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
  } else if (name === 'scrollGesture') {
    const x = point?.x ?? 100;
    const y = point?.y ?? 300;
    commandResults.push(
      await send(view, 'Input.synthesizeScrollGesture', {
        x,
        y,
        xDistance: 0,
        // Positive yDistance scrolls up; the box starts at the top.
        yDistance: -180,
        speed: 600,
        preventFling: true,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 140));
  }
  const after = await readback(view);
  // A second readback separates input that is delivered late from input that
  // never arrives.
  await new Promise((resolve) => setTimeout(resolve, 700));
  const afterSettled = await readback(view);
  return {
    status: 'recorded',
    operation: name,
    setup,
    focusSetup,
    point: point?.error
      ? point
      : point
        ? { x: point.x, y: point.y, rect: point.rect }
        : null,
    before,
    after,
    afterSettled,
    commandResults,
    observedBeforeInputEvents: beforeInput.records.slice(beforeInputStart),
    rawDebuggerEvents: view.events.slice(eventsStart),
    rawCommands: view.commands.slice(commandsStart),
  };
}

async function runInputMatrixCase(ctx, name, viewOptions = {}) {
  const entry = {
    status: 'recorded',
    question: name,
    focusEmulation: viewOptions.focusEmulation !== false,
    hostPolicy:
      'BrowserWindow remains show:false; visible means WebContentsView.setVisible(true) only, not an OS-visible/composited window. Focus emulation is on unless focusEmulation is false.',
    findings: [],
    operations: {},
    evidence: { views: [] },
  };
  let pane;
  let overlay;
  let focusPeer;
  let observer;
  try {
    pane = await ctx.newView(
      `${ctx.server.mainOrigin}/can-1570/s1`,
      viewOptions,
    );
    if (name === 'visiblePane') pane.view.setVisible(true);
    if (name === 'hiddenPane') pane.view.setVisible(false);
    if (name === 'detachedPane') {
      pane.view.setVisible(true);
      pane.window.contentView.removeChildView(pane.view);
      entry.attachment = 'removed from the hidden host contentView';
    }
    if (name === 'appOverlayWebContentsView') {
      overlay = await ctx.newView(`${ctx.server.mainOrigin}/can-1570/overlay`);
      overlay.window.contentView.removeChildView(overlay.view);
      pane.window.contentView.addChildView(overlay.view);
      pane.view.setBounds({ x: 0, y: 0, width: 800, height: 600 });
      overlay.view.setBounds({ x: 0, y: 0, width: 800, height: 600 });
      pane.view.setVisible(true);
      overlay.view.setVisible(true);
      entry.overlay =
        'second WebContentsView reparented into the target hidden BrowserWindow above the pane';
    }
    if (name === 'unfocusedHost') {
      focusPeer = await ctx.newView(`${ctx.server.mainOrigin}/can-1570/s1`);
      focusPeer.wc.focus();
      await ctx.sleep(60);
      entry.peerFocusAttempt = {
        attempted: true,
        target: hostState(pane),
        peer: hostState(focusPeer),
      };
    }
    entry.hostBefore = hostState(pane);
    observer = beforeInputObserver(pane);
    for (const operation of ['mouse', 'key', 'wheel', 'scrollGesture']) {
      try {
        entry.operations[operation] = await runInputOperation(
          pane,
          operation,
          observer,
        );
      } catch (error) {
        entry.operations[operation] = {
          status: 'recorded',
          error: errorText(error),
          readback: await readback(pane),
          rawDebuggerEvents: pane.events.slice(),
          rawCommands: pane.commands.slice(),
        };
      }
    }
    entry.observedBeforeInputEvents = observer.records.slice();
    entry.hostAfter = hostState(pane);
    if (overlay)
      entry.overlayReadback = await evaluate(
        overlay,
        'window.__overlayReadback()',
      );
  } catch (error) {
    entry.findings.push({ kind: 'case-error', error: errorText(error) });
  } finally {
    observer?.remove();
    if (pane && overlay) {
      try {
        pane.window.contentView.removeChildView(overlay.view);
      } catch {
        // Cleanup is best effort.
      }
    }
    for (const [role, view] of [
      ['pane', pane],
      ['overlay', overlay],
      ['focusPeer', focusPeer],
    ]) {
      if (!view) continue;
      try {
        entry.evidence.views.push({
          role,
          host: hostState(view),
          evidence: view.evidence(),
        });
      } catch (error) {
        entry.evidence.views.push({ role, error: errorText(error) });
      }
      try {
        view.dispose();
      } catch {
        // Cleanup is best effort.
      }
    }
  }
  return entry;
}

async function runFocusEmulation(ctx) {
  const entry = {
    status: 'recorded',
    states: [],
    findings: [],
    evidence: null,
  };
  let view;
  let observer;
  try {
    view = await ctx.newView(`${ctx.server.mainOrigin}/can-1570/s1`);
    view.wc.focus();
    entry.wcFocusAttempt = hostState(view);
    observer = beforeInputObserver(view);
    for (const enabled of [false, true]) {
      const commandStart = view.commands.length;
      const toggle = await send(view, 'Emulation.setFocusEmulationEnabled', {
        enabled,
      });
      const before = await evaluate(
        view,
        "(() => { window.__probeReset(); const e=document.getElementById('keyTarget'); e.focus(); return {documentHasFocus:document.hasFocus(), visibilityState:document.visibilityState, activeElement:document.activeElement.id, inputValue:e.value}; })()",
      );
      const keyDown = await send(view, 'Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: 'f',
        code: 'KeyF',
        text: 'f',
        unmodifiedText: 'f',
        windowsVirtualKeyCode: 70,
        nativeVirtualKeyCode: 70,
      });
      const keyUp = await send(view, 'Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'f',
        code: 'KeyF',
        windowsVirtualKeyCode: 70,
        nativeVirtualKeyCode: 70,
      });
      const after = await evaluate(
        view,
        "(() => ({documentHasFocus:document.hasFocus(), visibilityState:document.visibilityState, activeElement:document.activeElement.id, inputValue:document.getElementById('keyTarget').value, events:window.__probeReadback().events}))()",
      );
      entry.states.push({
        enabled,
        toggle,
        before,
        keyDown,
        keyUp,
        after,
        rawCommands: view.commands.slice(commandStart),
      });
    }
    entry.observedBeforeInputEvents = observer.records.slice();
  } catch (error) {
    entry.findings.push({
      kind: 'focus-emulation-error',
      error: errorText(error),
    });
  } finally {
    observer?.remove();
    if (view) {
      try {
        await send(view, 'Emulation.setFocusEmulationEnabled', {
          enabled: false,
        });
      } catch {
        // Cleanup is best effort.
      }
      entry.evidence = { host: hostState(view), ...view.evidence() };
      try {
        view.dispose();
      } catch {
        // Cleanup is best effort.
      }
    }
  }
  return entry;
}

function shortcutSamples() {
  const mac = [
    { label: 'plain-T', key: 't', code: 'KeyT', modifiers: 0 },
    { label: 'Cmd-T', key: 't', code: 'KeyT', modifiers: 4 },
    { label: 'Cmd-L', key: 'l', code: 'KeyL', modifiers: 4 },
    { label: 'Cmd-B', key: 'b', code: 'KeyB', modifiers: 4 },
    { label: 'Cmd-Left', key: 'ArrowLeft', code: 'ArrowLeft', modifiers: 4 },
    { label: 'Cmd-Right', key: 'ArrowRight', code: 'ArrowRight', modifiers: 4 },
    { label: 'Shift-Cmd-T', key: 't', code: 'KeyT', modifiers: 12 },
    { label: 'Ctrl-T', key: 't', code: 'KeyT', modifiers: 2 },
  ];
  const other = [
    { label: 'plain-T', key: 't', code: 'KeyT', modifiers: 0 },
    { label: 'Ctrl-T', key: 't', code: 'KeyT', modifiers: 2 },
    { label: 'Ctrl-L', key: 'l', code: 'KeyL', modifiers: 2 },
    { label: 'Ctrl-B', key: 'b', code: 'KeyB', modifiers: 2 },
    { label: 'Alt-Left', key: 'ArrowLeft', code: 'ArrowLeft', modifiers: 1 },
    { label: 'Alt-Right', key: 'ArrowRight', code: 'ArrowRight', modifiers: 1 },
    { label: 'Shift-Ctrl-T', key: 't', code: 'KeyT', modifiers: 10 },
    { label: 'Meta-T', key: 't', code: 'KeyT', modifiers: 4 },
  ];
  return process.platform === 'darwin' ? mac : other;
}

async function runShortcutComparison(ctx) {
  const entry = {
    status: 'recorded',
    implementation:
      'Local transcription of browser-shortcuts.ts::resolveBrowserShortcutAction; production module is not imported.',
    predicateSamples: [],
    observedBeforeInputEvents: [],
    findings: [],
    evidence: null,
  };
  let view;
  let observer;
  try {
    view = await ctx.newView(`${ctx.server.mainOrigin}/can-1570/s1`);
    observer = beforeInputObserver(view);
    const samples = shortcutSamples();
    // Electron raises before-input-event for rawKeyDown and keyUp only, and
    // key tables send chords as rawKeyDown, so both down types are sampled.
    for (const [sample, downType] of samples.flatMap((sample) => [
      [sample, 'rawKeyDown'],
      [sample, 'keyDown'],
    ])) {
      const start = observer.records.length;
      const vkey =
        { KeyT: 84, KeyL: 76, KeyB: 66, ArrowLeft: 37, ArrowRight: 39 }[
          sample.code
        ] ?? 0;
      await send(view, 'Input.dispatchKeyEvent', {
        type: downType,
        key: sample.key,
        code: sample.code,
        modifiers: sample.modifiers,
        windowsVirtualKeyCode: vkey,
        nativeVirtualKeyCode: vkey,
      });
      await send(view, 'Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: sample.key,
        code: sample.code,
        modifiers: sample.modifiers,
        windowsVirtualKeyCode: vkey,
        nativeVirtualKeyCode: vkey,
      });
      const expected = copiedShortcutPredicate(
        {
          type: 'keyDown',
          code: sample.code,
          alt: Boolean(sample.modifiers & 1),
          control: Boolean(sample.modifiers & 2),
          meta: Boolean(sample.modifiers & 4),
          shift: Boolean(sample.modifiers & 8),
        },
        process.platform,
      );
      entry.predicateSamples.push({
        ...sample,
        downType,
        localPredicateResult: expected,
        observedBeforeInputEvents: observer.records.slice(start),
      });
    }
    entry.observedBeforeInputEvents = observer.records.slice();
    entry.platformResults = Object.fromEntries(
      ['darwin', 'win32', 'linux'].map((platform) => [
        platform,
        shortcutSamplesForPlatform(platform).map((sample) => ({
          label: sample.label,
          code: sample.code,
          modifiers: sample.modifiers,
          action: copiedShortcutPredicate(
            {
              type: 'keyDown',
              code: sample.code,
              alt: Boolean(sample.modifiers & 1),
              control: Boolean(sample.modifiers & 2),
              meta: Boolean(sample.modifiers & 4),
              shift: Boolean(sample.modifiers & 8),
            },
            platform,
          ),
        })),
      ]),
    );
  } catch (error) {
    entry.findings.push({
      kind: 'shortcut-observation-error',
      error: errorText(error),
    });
  } finally {
    observer?.remove();
    if (view) {
      entry.evidence = { host: hostState(view), ...view.evidence() };
      try {
        view.dispose();
      } catch {
        // Cleanup is best effort.
      }
    }
  }
  return entry;
}

function shortcutSamplesForPlatform(platform) {
  if (platform === 'darwin') {
    return [
      { label: 'plain-T', code: 'KeyT', modifiers: 0 },
      { label: 'Cmd-T', code: 'KeyT', modifiers: 4 },
      { label: 'Cmd-L', code: 'KeyL', modifiers: 4 },
      { label: 'Cmd-B', code: 'KeyB', modifiers: 4 },
      { label: 'Cmd-Left', code: 'ArrowLeft', modifiers: 4 },
      { label: 'Cmd-Right', code: 'ArrowRight', modifiers: 4 },
      { label: 'Shift-Cmd-T', code: 'KeyT', modifiers: 12 },
      { label: 'Ctrl-T', code: 'KeyT', modifiers: 2 },
      { label: 'Alt-Left', code: 'ArrowLeft', modifiers: 1 },
    ];
  }
  return [
    { label: 'plain-T', code: 'KeyT', modifiers: 0 },
    { label: 'Ctrl-T', code: 'KeyT', modifiers: 2 },
    { label: 'Ctrl-L', code: 'KeyL', modifiers: 2 },
    { label: 'Ctrl-B', code: 'KeyB', modifiers: 2 },
    { label: 'Alt-Left', code: 'ArrowLeft', modifiers: 1 },
    { label: 'Alt-Right', code: 'ArrowRight', modifiers: 1 },
    { label: 'Shift-Ctrl-T', code: 'KeyT', modifiers: 10 },
    { label: 'Meta-T', code: 'KeyT', modifiers: 4 },
  ];
}

async function runZoomCoordinates(ctx) {
  const entry = {
    status: 'recorded',
    zoomFactorRequested: 1.5,
    findings: [],
    evidence: null,
  };
  let view;
  try {
    view = await ctx.newView(`${ctx.server.mainOrigin}/can-1570/s1`);
    try {
      view.wc.setZoomFactor(1.5);
      entry.zoomFactorActual = view.wc.getZoomFactor();
      entry.zoomCall = {
        status: 'resolved',
        method: 'webContents.setZoomFactor',
        factor: 1.5,
      };
    } catch (error) {
      entry.zoomCall = { status: 'error', error: errorText(error) };
    }
    const before = await readback(view);
    const point = await rectCenter(view, '#zoomTarget').catch((error) => ({
      error: errorText(error),
    }));
    const cssHitTest = point.error
      ? { status: 'error', error: point.error }
      : await evaluate(
          view,
          `(() => { const hit=document.elementFromPoint(${point.x},${point.y}); return {x:${point.x},y:${point.y},hitId:hit&&hit.id||null,hitTag:hit&&hit.tagName||null}; })()`,
        );
    entry.cssGeometry = { before, targetPoint: point, cssHitTest };
    const start = view.commands.length;
    const results = [];
    if (!point.error) {
      results.push(
        await send(view, 'Input.dispatchMouseEvent', {
          type: 'mouseMoved',
          x: point.x,
          y: point.y,
          button: 'none',
          buttons: 0,
        }),
      );
      results.push(
        await send(view, 'Input.dispatchMouseEvent', {
          type: 'mousePressed',
          x: point.x,
          y: point.y,
          button: 'left',
          buttons: 1,
          clickCount: 1,
        }),
      );
      results.push(
        await send(view, 'Input.dispatchMouseEvent', {
          type: 'mouseReleased',
          x: point.x,
          y: point.y,
          button: 'left',
          buttons: 0,
          clickCount: 1,
        }),
      );
    }
    entry.inputResults = results;
    entry.rawInputCommands = view.commands.slice(start);
    entry.after = await readback(view);
    entry.conclusionEvidence =
      'Compare the CSS getBoundingClientRect center, CDP Input command x/y, elementFromPoint, and click clientX/clientY in the readback; all are retained without coordinate normalization.';
  } catch (error) {
    entry.findings.push({ kind: 'zoom-case-error', error: errorText(error) });
  } finally {
    if (view) {
      entry.evidence = { host: hostState(view), ...view.evidence() };
      try {
        view.dispose();
      } catch {
        // Cleanup is best effort.
      }
    }
  }
  return entry;
}

async function runDialogTiming(ctx) {
  const entry = {
    status: 'recorded',
    targetDelayMs: 3250,
    findings: [],
    timeline: [],
    pressOutcome: null,
    evidence: null,
  };
  let view;
  let timer;
  let fallbackTimer;
  let answerPromise;
  let listener;
  let dialogObserved = false;
  let pressFinished = false;
  const origin = performance.now();
  const mark = (kind, details = {}) =>
    entry.timeline.push({
      seq: entry.timeline.length,
      atMs: performance.now() - origin,
      kind,
      ...details,
    });
  try {
    view = await ctx.newView(`${ctx.server.mainOrigin}/can-1570/s1`);
    listener = (_event, method, params) => {
      if (method !== 'Page.javascriptDialogOpening') return;
      dialogObserved = true;
      mark('Page.javascriptDialogOpening', { params });
      if (timer) return;
      timer = setTimeout(() => {
        mark('auto-answer-start', { delayFromDialogMs: 3250 });
        answerPromise = send(view, 'Page.handleJavaScriptDialog', {
          accept: true,
        }).then((result) => {
          mark('auto-answer-complete', { result });
          return result;
        });
      }, 3250);
    };
    view.wc.debugger.on('message', listener);
    const point = await rectCenter(view, '#dialogTarget');
    await send(view, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: point.x,
      y: point.y,
      button: 'none',
      buttons: 0,
    });
    mark('mousePressed-command-start', { x: point.x, y: point.y });
    const pressPromise = view
      .send('Input.dispatchMouseEvent', {
        type: 'mousePressed',
        x: point.x,
        y: point.y,
        button: 'left',
        buttons: 1,
        clickCount: 1,
      })
      .then((result) => {
        pressFinished = true;
        mark('mousePressed-command-resolved', { result });
        return { status: 'resolved', result };
      })
      .catch((error) => {
        pressFinished = true;
        mark('mousePressed-command-error', { error: errorText(error) });
        return { status: 'error', error: errorText(error) };
      });
    fallbackTimer = setTimeout(() => {
      if (dialogObserved || pressFinished || answerPromise) return;
      mark('dialog-event-fallback-answer-start', {
        delayFromMousePressedMs: 4500,
      });
      answerPromise = send(view, 'Page.handleJavaScriptDialog', {
        accept: true,
      }).then((result) => {
        mark('dialog-event-fallback-answer-complete', { result });
        return result;
      });
    }, 4500);
    entry.pressOutcome = await ctx
      .bounded(pressPromise, 7000)
      .catch((error) => {
        mark('outer-command-bound', { error: errorText(error) });
        return { status: 'bounded-error', error: errorText(error) };
      });
    if (answerPromise)
      entry.autoAnswerOutcome = await ctx
        .bounded(answerPromise, 4000)
        .catch((error) => ({
          status: 'bounded-error',
          error: errorText(error),
        }));
    entry.releaseOutcome = await send(view, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: point.x,
      y: point.y,
      button: 'left',
      buttons: 0,
      clickCount: 1,
    });
    entry.after = await readback(view);
    entry.dialogEvents = view.events.filter(
      (event) =>
        event.method === 'Page.javascriptDialogOpening' ||
        event.method === 'Page.javascriptDialogClosed',
    );
    if (
      !entry.dialogEvents.some(
        (event) => event.method === 'Page.javascriptDialogOpening',
      )
    )
      entry.findings.push({
        kind: 'negative-finding',
        finding:
          'No Page.javascriptDialogOpening event was observed for the mousePressed probe.',
      });
  } catch (error) {
    entry.findings.push({ kind: 'dialog-case-error', error: errorText(error) });
  } finally {
    if (timer) clearTimeout(timer);
    if (fallbackTimer) clearTimeout(fallbackTimer);
    if (view && listener) view.wc.debugger.removeListener('message', listener);
    if (view) {
      entry.evidence = { host: hostState(view), ...view.evidence() };
      try {
        view.dispose();
      } catch {
        // Cleanup is best effort.
      }
    }
  }
  return entry;
}

async function runMacEditingCommands(ctx) {
  const entry = {
    status: 'recorded',
    sequence: ['commands: [selectAll]', 'Backspace'],
    findings: [],
    evidence: null,
  };
  let view;
  let observer;
  try {
    view = await ctx.newView(`${ctx.server.mainOrigin}/can-1570/s1`);
    if (process.platform !== 'darwin') {
      entry.findings.push({
        kind: 'platform-skip',
        finding: `macOS editing commands not exercised on ${process.platform}.`,
      });
      return entry;
    }
    observer = beforeInputObserver(view);
    entry.initial = await evaluate(
      view,
      "(() => { const e=document.getElementById('keyTarget'); e.value='alpha-bravo'; e.focus(); return {value:e.value,active:document.activeElement.id,hasFocus:document.hasFocus()}; })()",
    );
    const start = view.commands.length;
    entry.selectAllKeyDown = await send(view, 'Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'a',
      code: 'KeyA',
      modifiers: 4,
      windowsVirtualKeyCode: 65,
      nativeVirtualKeyCode: 65,
      commands: ['selectAll'],
    });
    entry.selectAllKeyUp = await send(view, 'Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'a',
      code: 'KeyA',
      modifiers: 4,
      windowsVirtualKeyCode: 65,
      nativeVirtualKeyCode: 65,
    });
    entry.backspaceKeyDown = await send(view, 'Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'Backspace',
      code: 'Backspace',
      windowsVirtualKeyCode: 8,
      nativeVirtualKeyCode: 8,
    });
    entry.backspaceKeyUp = await send(view, 'Input.dispatchKeyEvent', {
      type: 'keyUp',
      key: 'Backspace',
      code: 'Backspace',
      windowsVirtualKeyCode: 8,
      nativeVirtualKeyCode: 8,
    });
    entry.rawCommands = view.commands.slice(start);
    entry.after = await evaluate(
      view,
      "(() => ({value:document.getElementById('keyTarget').value,active:document.activeElement.id,hasFocus:document.hasFocus(),events:window.__probeReadback().events}))()",
    );
    entry.observedBeforeInputEvents = observer.records.slice();
  } catch (error) {
    entry.findings.push({
      kind: 'mac-editing-case-error',
      error: errorText(error),
    });
  } finally {
    observer?.remove();
    if (view) {
      entry.evidence = { host: hostState(view), ...view.evidence() };
      try {
        view.dispose();
      } catch {
        // Cleanup is best effort.
      }
    }
  }
  return entry;
}

async function runS1(ctx) {
  const entry = {
    status: 'recorded',
    windowPolicy:
      'All BrowserWindows are created show:false by the harness. setVisible(true) means only the WebContentsView pane is visible inside that hidden host; no OS-visible compositor evidence is claimed.',
    question:
      'CDP mouse, key, wheel and scroll gestures across WebContentsView visibility, attachment, overlay and focus states; focus emulation; shortcut routing; zoom coordinates; dialog-blocked mousePressed; macOS editing commands.',
    scenarios: {},
    controlWithoutFocusEmulation: {},
    findings: [],
  };
  // Control: the same matrix without the focus emulation production enables.
  for (const name of ['visiblePane', 'hiddenPane']) {
    try {
      entry.controlWithoutFocusEmulation[name] = await runInputMatrixCase(
        ctx,
        name,
        { focusEmulation: false },
      );
    } catch (error) {
      entry.controlWithoutFocusEmulation[name] = {
        status: 'recorded',
        findings: [{ kind: 'case-error', error: errorText(error) }],
        operations: {},
        evidence: { views: [] },
      };
    }
  }
  for (const name of [
    'visiblePane',
    'hiddenPane',
    'detachedPane',
    'appOverlayWebContentsView',
    'unfocusedHost',
  ]) {
    try {
      entry.scenarios[name] = await runInputMatrixCase(ctx, name);
    } catch (error) {
      entry.scenarios[name] = {
        status: 'recorded',
        findings: [{ kind: 'case-error', error: errorText(error) }],
        operations: {},
        evidence: { views: [] },
      };
    }
  }
  for (const [name, run] of [
    ['focusEmulation', runFocusEmulation],
    ['beforeInputAndBrowserShortcuts', runShortcutComparison],
    ['pageZoomCoordinates', runZoomCoordinates],
    ['mousePressedDialogTiming', runDialogTiming],
    ['macOSEditingCommands', runMacEditingCommands],
  ]) {
    try {
      entry.scenarios[name] = await run(ctx);
    } catch (error) {
      entry.scenarios[name] = {
        status: 'recorded',
        findings: [{ kind: 'case-error', error: errorText(error) }],
        evidence: null,
      };
    }
  }
  return entry;
}

async function runHtml5Drag(ctx) {
  const entry = { status: 'recorded', findings: [], evidence: null };
  let view;
  try {
    view = await ctx.newView(`${ctx.server.mainOrigin}/can-1570/s6`);
    const source = await rectCenter(view, '#source');
    const destination = await rectCenter(view, '#dropTarget');
    entry.sourceCssRect = source.rect;
    entry.destinationCssRect = destination.rect;
    const start = view.commands.length;
    entry.interceptEnable = await send(view, 'Input.setInterceptDrags', {
      enabled: true,
    });
    await send(view, 'Input.dispatchMouseEvent', {
      type: 'mouseMoved',
      x: source.x,
      y: source.y,
      button: 'none',
      buttons: 0,
    });
    entry.mousePressed = await send(view, 'Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x: source.x,
      y: source.y,
      button: 'left',
      buttons: 1,
      clickCount: 1,
    });
    for (let step = 1; step <= 10; step++) {
      const progress = step / 10;
      await send(view, 'Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: source.x + (destination.x - source.x) * progress,
        y: source.y + (destination.y - source.y) * progress,
        button: 'left',
        buttons: 1,
      });
    }
    const intercepted = await ctx
      .until(
        () =>
          view.events.find((event) => event.method === 'Input.dragIntercepted'),
        1800,
      )
      .catch((error) => {
        entry.findings.push({
          kind: 'negative-finding',
          finding:
            'Input.dragIntercepted was not observed during real mouse drag steps.',
          error: errorText(error),
        });
        return null;
      });
    entry.dragIntercepted = intercepted
      ? {
          seq: intercepted.seq,
          atMs: intercepted.atMs,
          sessionId: intercepted.sessionId,
          params: intercepted.params,
        }
      : null;
    if (intercepted?.params?.data) {
      const data = intercepted.params.data;
      entry.interceptedDataSummary = {
        items: data.items ?? [],
        files: data.files ?? [],
        dragOperationsMask: data.dragOperationsMask ?? null,
      };
      for (const type of ['dragEnter', 'dragOver', 'drop']) {
        entry.dispatchResults ??= [];
        entry.dispatchResults.push({
          type,
          result: await send(view, 'Input.dispatchDragEvent', {
            type,
            x: destination.x,
            y: destination.y,
            data,
          }),
        });
      }
    }
    entry.mouseReleased = await send(view, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: destination.x,
      y: destination.y,
      button: 'left',
      buttons: 0,
      clickCount: 1,
    });
    await ctx.sleep(80);
    entry.readback = await evaluate(view, 'window.__dragReadback()');
    entry.rawCommands = view.commands.slice(start);
    entry.rawDragEvents = view.events.filter(
      (event) =>
        event.method === 'Input.dragIntercepted' ||
        event.method === 'Input.dragEnded',
    );
    entry.interceptDisable = await send(view, 'Input.setInterceptDrags', {
      enabled: false,
    });
  } catch (error) {
    entry.findings.push({ kind: 'html5-drag-error', error: errorText(error) });
  } finally {
    if (view) {
      entry.evidence = { host: hostState(view), ...view.evidence() };
      try {
        view.dispose();
      } catch {
        // Cleanup is best effort.
      }
    }
  }
  return entry;
}

async function runSyntheticFileDrop(ctx) {
  const entry = { status: 'recorded', findings: [], evidence: null };
  let view;
  try {
    view = await ctx.newView(`${ctx.server.mainOrigin}/can-1570/s6`);
    const fileName = `can1570-synthetic-${Date.now()}.txt`;
    const bytes = Buffer.from(
      'CAN-1570 synthetic drag bytes\nsecond line\n',
      'utf8',
    );
    const workDir = path.resolve(ctx.config.workDir);
    const filePath = path.join(workDir, fileName);
    writeFileSync(filePath, bytes);
    entry.fixtureFile = {
      name: fileName,
      bytes: Array.from(bytes),
      utf8: bytes.toString('utf8'),
      byteLength: bytes.byteLength,
      storage: 'disposable probe workDir',
    };
    const destination = await rectCenter(view, '#fileDrop');
    entry.destinationCssRect = destination.rect;
    const data = {
      items: [
        {
          mimeType: 'text/plain',
          data: bytes.toString('utf8'),
          title: fileName,
          baseURL: ctx.server.mainOrigin,
        },
      ],
      files: [filePath],
      dragOperationsMask: 1,
    };
    const start = view.commands.length;
    entry.dispatchResults = [];
    for (const type of ['dragEnter', 'dragOver', 'drop']) {
      entry.dispatchResults.push({
        type,
        result: await send(view, 'Input.dispatchDragEvent', {
          type,
          x: destination.x,
          y: destination.y,
          data,
        }),
      });
    }
    entry.rawCommands = view.commands.slice(start);
    entry.asyncReadback = await ctx
      .until(
        () => view.evaluate('window.__dragReadback().fileDrops.length > 0'),
        3500,
      )
      .catch((error) => {
        entry.findings.push({
          kind: 'negative-finding',
          finding:
            'Synthetic file drop did not produce an asynchronous File readback.',
          error: errorText(error),
        });
        return false;
      });
    entry.readback = await evaluate(view, 'window.__dragReadback()');
    const observed = entry.readback?.value?.fileDrops ?? [];
    entry.byteAndNameMatch = observed.some(
      (file) =>
        file.name === fileName &&
        file.size === bytes.byteLength &&
        JSON.stringify(file.bytes) === JSON.stringify(Array.from(bytes)),
    );
  } catch (error) {
    entry.findings.push({
      kind: 'synthetic-file-drop-error',
      error: errorText(error),
    });
  } finally {
    if (view) {
      entry.evidence = { host: hostState(view), ...view.evidence() };
      try {
        view.dispose();
      } catch {
        // Cleanup is best effort.
      }
    }
  }
  return entry;
}

async function runS6(ctx) {
  const entry = {
    status: 'recorded',
    windowPolicy:
      'All BrowserWindows are created show:false by the harness; drag evidence is from the local page and CDP, not an OS-visible compositor.',
    question:
      'HTML5 drag interception and dispatch from real mouse steps, plus a DragData.files synthetic file drop with byte and filename readback.',
    html5Drag: null,
    syntheticFileDrop: null,
    findings: [],
  };
  try {
    entry.html5Drag = await runHtml5Drag(ctx);
  } catch (error) {
    entry.html5Drag = {
      status: 'recorded',
      findings: [{ kind: 'case-error', error: errorText(error) }],
      evidence: null,
    };
  }
  try {
    entry.syntheticFileDrop = await runSyntheticFileDrop(ctx);
  } catch (error) {
    entry.syntheticFileDrop = {
      status: 'recorded',
      findings: [{ kind: 'case-error', error: errorText(error) }],
      evidence: null,
    };
  }
  return entry;
}

function registerFixtures(ctx) {
  ctx.server.register('/can-1570/s1', S1_HTML);
  ctx.server.register('/can-1570/overlay', OVERLAY_HTML);
  ctx.server.register('/can-1570/s6', S6_HTML);
}

export async function runS1S6(ctx) {
  const result = {};
  try {
    registerFixtures(ctx);
  } catch (error) {
    const finding = {
      kind: 'fixture-registration-error',
      error: errorText(error),
    };
    return {
      S1: {
        status: 'recorded',
        question: 'S1 CDP input matrix',
        scenarios: {},
        findings: [finding],
      },
      S6: {
        status: 'recorded',
        question: 'S6 HTML5 and file drag',
        html5Drag: null,
        syntheticFileDrop: null,
        findings: [finding],
      },
    };
  }
  try {
    result.S1 = await runS1(ctx);
  } catch (error) {
    result.S1 = {
      status: 'recorded',
      question: 'S1 CDP input matrix',
      scenarios: {},
      findings: [{ kind: 'spike-error', error: errorText(error) }],
    };
  }
  try {
    result.S6 = await runS6(ctx);
  } catch (error) {
    result.S6 = {
      status: 'recorded',
      question: 'S6 HTML5 and file drag',
      html5Drag: null,
      syntheticFileDrop: null,
      findings: [{ kind: 'spike-error', error: errorText(error) }],
    };
  }
  return result;
}

export async function run(ctx) {
  return runS1S6(ctx);
}
