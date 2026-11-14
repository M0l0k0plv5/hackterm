// UI layer: terminal rendering, input handling, overlays and persistence.
import { Game, MISSIONS } from './game.js';
import { Shell } from './shell.js';
import { initialProcs } from './world.js';

const SAVE_KEY = 'hackterm.v1';
const MAX_NODES = 1500;
const $ = id => document.getElementById(id);
const out = $('out'), term = $('term'), input = $('cmd'), promptEl = $('prompt');

// ---------- storage (always guarded: private mode or blocked storage must not break the app) ----------
function load() {
  try { return JSON.parse(localStorage.getItem(SAVE_KEY) || 'null'); } catch { return null; }
}
function save() {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify({ shell: sh.serialize(), game: game.s, theme: document.body.dataset.theme }));
  } catch { /* storage unavailable or full */ }
}

const saved = load();
const game = new Game(saved?.game);
const sh = new Shell(saved?.shell);
sh.game = game;
if (saved?.theme) document.body.dataset.theme = saved.theme;

// ---------- ANSI -> HTML ----------
const COLORS = { 31: 'red', 32: 'green', 33: 'yellow', 34: 'blue', 35: 'magenta', 36: 'cyan', 90: 'gray', 37: '', 39: '' };
const esc = s => s.replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
let ansi = { b: false, c: '', inv: false };
function ansiToHtml(text) {
  let html = '';
  const parts = text.split(/\x1b\[([\d;]*)m/);
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) {
      for (const code of (parts[i] || '0').split(';').map(Number)) {
        if (code === 0) ansi = { b: false, c: '', inv: false };
        else if (code === 1) ansi.b = true;
        else if (code === 7) ansi.inv = true;
        else if (code === 22) ansi.b = false;
        else if (code in COLORS) ansi.c = COLORS[code];
      }
      continue;
    }
    if (!parts[i]) continue;
    const cls = [ansi.b && 'b', ansi.c && 'c-' + ansi.c, ansi.inv && 'inv'].filter(Boolean).join(' ');
    html += cls ? `<span class="${cls}">${esc(parts[i])}</span>` : esc(parts[i]);
  }
  return html;
}

function print(text, cls) {
  if (!text) return;
  const span = document.createElement('span');
  if (cls) span.className = cls;
  span.innerHTML = ansiToHtml(text);
  out.appendChild(span);
  while (out.childNodes.length > MAX_NODES) out.removeChild(out.firstChild);
}
function clearScreen() { out.innerHTML = ''; }
const scrollDown = () => { term.scrollTop = term.scrollHeight; };

sh.write = (text, kind) => {
  if (kind === 'clear') clearScreen();
  else print(text);
};

// ---------- HUD ----------
function updateHud() {
  const r = game.rank();
  $('rank').textContent = r.name;
  $('xp').textContent = r.next ? `${game.s.xp} / ${r.next} XP` : `${game.s.xp} XP`;
  $('xpbar').style.width = `${Math.round(r.progress * 100)}%`;
  $('mnum').textContent = game.mission ? `${String(game.s.idx + 1).padStart(2, '0')}/${MISSIONS.length}` : 'FREI';
}
function renderPrompt() {
  ansi = { b: false, c: '', inv: false };
  promptEl.innerHTML = ansiToHtml(sh.prompt());
}

// ---------- terminal width ----------
function measureCols() {
  const probe = document.createElement('span');
  probe.textContent = 'M'.repeat(50);
  probe.style.visibility = 'hidden';
  probe.style.position = 'absolute';
  out.appendChild(probe);
  const w = probe.getBoundingClientRect().width / 50;
  probe.remove();
  const avail = term.clientWidth - 24;
  sh.cols = Math.max(20, Math.floor(avail / (w || 8)));
}

// ---------- effects ----------
function haptic() { try { navigator.vibrate?.(30); } catch { /* unsupported */ } }
// Banners are queued so that several events in quick succession don't overlap.
const bannerQueue = [];
let bannerBusy = false;
function banner(big, sub, xp) {
  bannerQueue.push({ big, sub, xp });
  if (bannerQueue.length > 3) bannerQueue.splice(0, bannerQueue.length - 3);
  if (!bannerBusy) nextBanner();
}
function nextBanner() {
  const item = bannerQueue.shift();
  const b = $('banner');
  if (!item) { bannerBusy = false; b.hidden = true; return; }
  bannerBusy = true;
  b.innerHTML = `<div class="big">${esc(item.big)}</div>${item.sub ? `<div class="sub">${esc(item.sub)}</div>` : ''}${item.xp ? `<div class="xp">+${item.xp} XP</div>` : ''}`;
  b.hidden = false;
  b.className = 'show';
  document.body.classList.add('glitch');
  setTimeout(() => document.body.classList.remove('glitch'), 400);
  setTimeout(() => {
    b.className = 'hide';
    setTimeout(nextBanner, 500);
  }, bannerQueue.length ? 1200 : 1800);
}
function toast(text) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = text;
  $('toasts').appendChild(t);
  setTimeout(() => t.remove(), 3700);
}
function showEvents(events) {
  // Blank line after a mission box/notice so the next prompt doesn't stick to it.
  for (const e of events) {
    print(game.eventText(e));
    if (e.type === 'mission') {
      haptic();
      banner(e.mission.finale || (e.next ? 'MISSION COMPLETE' : 'SYSTEM PWNED'), e.mission.title, e.mission.xp);
    } else if (e.type === 'ach') toast(`🏆 ${e.ach.name} - ${e.ach.desc}`);
    else if (e.type === 'rank') banner('RANG-AUFSTIEG', e.rank.toUpperCase());
  }
  if (events.length) print('\n');
}

// ---------- matrix rain ----------
let matrixStop = null;
function startMatrix() {
  const cv = $('matrix');
  cv.hidden = false;
  const ctx = cv.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const size = 16;
  const resize = () => { cv.width = innerWidth * dpr; cv.height = innerHeight * dpr; ctx.scale(dpr, dpr); };
  resize();
  const glyphs = 'ｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝ0123456789$#@%&*<>/\\|';
  const cols = Math.ceil(innerWidth / size);
  const drops = Array.from({ length: cols }, () => Math.random() * -40);
  const color = getComputedStyle(document.body).getPropertyValue('--fg').trim() || '#33ff66';
  let raf;
  const tick = () => {
    ctx.fillStyle = 'rgba(0,0,0,0.08)';
    ctx.fillRect(0, 0, innerWidth, innerHeight);
    ctx.font = `${size}px monospace`;
    drops.forEach((y, i) => {
      const ch = glyphs[Math.floor(Math.random() * glyphs.length)];
      ctx.fillStyle = Math.random() < 0.05 ? '#fff' : color;
      ctx.fillText(ch, i * size, y * size);
      drops[i] = y * size > innerHeight && Math.random() > 0.975 ? 0 : y + 1;
    });
    raf = requestAnimationFrame(tick);
  };
  tick();
  const stop = () => {
    cancelAnimationFrame(raf);
    cv.hidden = true;
    removeEventListener('keydown', stop);
    cv.removeEventListener('pointerdown', stop);
    matrixStop = null;
    print('\x1b[90mWake up, Neo...\x1b[0m\n');
    focusInput();
  };
  matrixStop = stop;
  cv.addEventListener('pointerdown', stop);
  setTimeout(() => addEventListener('keydown', stop), 50);
}

// ---------- nano editor ----------
const ed = { req: null, original: '' };
function openEditor(req) {
  ed.req = req;
  ed.original = req.text;
  $('ed-name').textContent = req.name;
  $('ed-mod').textContent = '';
  $('ed-msg').innerHTML = req.text ? '' : '<span>[ Neue Datei ]</span>';
  $('ed-text').value = req.text;
  $('ed-foot').hidden = false;
  $('ed-ask').hidden = true;
  $('editor').hidden = false;
  input.blur();
  setTimeout(() => $('ed-text').focus(), 30);
}
function editorSave() {
  const text = $('ed-text').value;
  const prev = sh.fs.user;
  sh.fs.user = ed.req.user || prev;
  try {
    sh.fs.writeFile(ed.req.path, text);
    ed.original = text;
    $('ed-mod').textContent = '';
    const n = text ? text.split('\n').length - (text.endsWith('\n') ? 1 : 0) : 0;
    $('ed-msg').innerHTML = `<span>[ ${n} Zeile${n === 1 ? '' : 'n'} geschrieben ]</span>`;
    save();
    return true;
  } catch (e) {
    $('ed-msg').innerHTML = `<span>[ Fehler beim Schreiben von ${esc(ed.req.name)}: ${esc(e.message)} ]</span>`;
    return false;
  } finally {
    sh.fs.user = prev;
  }
}
function editorClose() {
  $('editor').hidden = true;
  ed.req = null;
  // Missions may depend on file content written in the editor.
  showEvents(game.afterRun(sh, { line: 'nano', cmds: [{ name: 'nano', args: [], code: 0 }], stdout: '', code: 0 }));
  updateHud();
  save();
  scrollDown();
  focusInput();
}
function editorAction(a) {
  if (a === 'save') editorSave();
  else if (a === 'exit') {
    if ($('ed-text').value === ed.original) editorClose();
    else { $('ed-foot').hidden = true; $('ed-ask').hidden = false; }
  } else if (a === 'yes') { if (editorSave()) editorClose(); }
  else if (a === 'no') editorClose();
  else if (a === 'cancel') { $('ed-foot').hidden = false; $('ed-ask').hidden = true; $('ed-text').focus(); }
}
$('editor').addEventListener('pointerdown', e => {
  const b = e.target.closest('button[data-e]');
  if (!b) return;
  e.preventDefault();
  editorAction(b.dataset.e);
});
$('ed-text').addEventListener('input', () => { $('ed-mod').textContent = 'Geändert'; $('ed-msg').innerHTML = ''; });
$('ed-text').addEventListener('keydown', e => {
  if (!e.ctrlKey) return;
  const k = e.key.toLowerCase();
  if (k === 'o' || k === 's') { e.preventDefault(); editorAction('save'); }
  else if (k === 'x') { e.preventDefault(); editorAction('exit'); }
});

// ---------- boot / reboot ----------
let busy = false;
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function bootSequence(lines, fast) {
  busy = true;
  $('line').style.visibility = 'hidden';
  let skip = fast;
  const onSkip = () => { skip = true; };
  addEventListener('pointerdown', onSkip);
  addEventListener('keydown', onSkip);
  for (const l of lines) {
    print(l + '\n');
    scrollDown();
    if (!skip) await sleep(l.startsWith('[') ? 90 : 220);
  }
  removeEventListener('pointerdown', onSkip);
  removeEventListener('keydown', onSkip);
  $('line').style.visibility = '';
  busy = false;
}
const BOOT = [
  '\x1b[90mHackTerm BIOS v1.0  (c) 2026\x1b[0m',
  '\x1b[90mMemory test: 8048576K OK\x1b[0m',
  '',
  'Booting Linux 6.8.0-hackterm ...',
  '[\x1b[32m  OK  \x1b[0m] Mounted virtual filesystem /',
  '[\x1b[32m  OK  \x1b[0m] Started OpenSSH server daemon',
  '[\x1b[32m  OK  \x1b[0m] Started nginx web server',
  '[\x1b[31mFAILED\x1b[0m] Integrity check: unknown process on CPU0',
  '[\x1b[32m  OK  \x1b[0m] Reached target Multi-User System',
  '',
  'box login: hacker',
  'Password: ********',
];
function welcome(restored) {
  if (restored) print(`\x1b[90m[ Sitzung wiederhergestellt · Rang: ${game.rank().name} · ${game.s.xp} XP ]\x1b[0m\n\n`);
  else {
    print('\n\x1b[1;32m  _   _            _    _____\n | | | | __ _  ___| | _|_   _|__ _ __ _ __ ___\n | |_| |/ _` |/ __| |/ / | |/ _ \\ \'__| \'_ ` _ \\\n |  _  | (_| | (__|   <  | |  __/ |  | | | | | |\n |_| |_|\\__,_|\\___|_|\\_\\ |_|\\___|_|  |_| |_| |_|\x1b[0m\n\n');
    print('Willkommen, Operator. Dies ist eine echte Linux-Shell - simuliert.\n');
    print('Alles was du hier lernst, funktioniert 1:1 auf echten Servern.\n');
    print('Befehle: \x1b[1mmission\x1b[0m  \x1b[1mhint\x1b[0m  \x1b[1mhelp\x1b[0m  \x1b[1mman <befehl>\x1b[0m  \x1b[1mstats\x1b[0m\n');
    const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
    if (/iPhone|iPad/.test(navigator.userAgent) && !standalone) {
      print('\x1b[90mTipp: Teilen -> "Zum Home-Bildschirm" fuer Vollbild & Offline.\x1b[0m\n');
    }
    print('\n');
  }
  print(game.missionText());
  print('\n');
}
async function reboot() {
  const alive = sh.procs.some(p => p.pid === 1337);
  print('\nBroadcast message from root@box: The system is going down for reboot NOW!\n');
  await sleep(700);
  clearScreen();
  sh.procs = initialProcs().filter(p => p.pid !== 1337 || alive);
  sh.cwd = sh.env.HOME;
  save();
  await bootSequence(BOOT, false);
  print('\n');
  renderPrompt();
  focusInput();
}

// ---------- command execution ----------
const hist = { idx: -1, draft: '' };
function submit() {
  if (busy) return;
  const line = input.value;
  input.value = '';
  hist.idx = -1;
  ansi = { b: false, c: '', inv: false };
  print(sh.prompt() + line + '\n', 'cmdline');
  let run;
  try {
    run = sh.run(line);
  } catch (e) {
    print(`bash: internal error: ${e.message}\n`);
    run = { line, code: 1, cmds: [], stdout: '' };
  }
  const req = sh.request;
  sh.request = null;
  showEvents(game.afterRun(sh, run));
  updateHud();
  renderPrompt();
  save();
  if (req) handleRequest(req);
  scrollDown();
}
function handleRequest(req) {
  if (req.type === 'editor') openEditor(req);
  else if (req.type === 'matrix') { input.blur(); startMatrix(); }
  else if (req.type === 'theme') { document.body.dataset.theme = req.name; save(); }
  else if (req.type === 'reboot') reboot();
  else if (req.type === 'reset') {
    try { localStorage.removeItem(SAVE_KEY); } catch { /* ignore */ }
    location.reload();
  }
}

function setInput(v) {
  input.value = v;
  const end = v.length;
  requestAnimationFrame(() => input.setSelectionRange(end, end));
}
function historyNav(dir) {
  const h = sh.history;
  if (!h.length) return;
  if (hist.idx === -1) { if (dir > 0) return; hist.draft = input.value; hist.idx = h.length; }
  hist.idx = Math.max(0, Math.min(h.length, hist.idx + dir));
  if (hist.idx === h.length) { hist.idx = -1; setInput(hist.draft); } else setInput(h[hist.idx]);
}
function complete() {
  const pos = input.selectionStart ?? input.value.length;
  const before = input.value.slice(0, pos), after = input.value.slice(pos);
  const res = sh.complete(before);
  if (res.options.length > 1) {
    ansi = { b: false, c: '', inv: false };
    print(sh.prompt() + input.value + '\n', 'cmdline');
    const w = Math.max(...res.options.map(o => o.length)) + 2;
    const cols = Math.max(1, Math.floor(sh.cols / w));
    const rows = Math.ceil(res.options.length / cols);
    let txt = '';
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const o = res.options[c * rows + r];
        if (o !== undefined) txt += res.options[(c + 1) * rows + r] !== undefined ? o.padEnd(w) : o;
      }
      txt += '\n';
    }
    print(txt);
    scrollDown();
  }
  input.value = res.line + after;
  input.setSelectionRange(res.line.length, res.line.length);
}
function ctrlC() {
  ansi = { b: false, c: '', inv: false };
  print(sh.prompt() + input.value + '^C\n', 'cmdline');
  input.value = '';
  hist.idx = -1;
  sh.pending = null; // also abandons an unfinished multi-line command
  sh.lastCode = 130;
  renderPrompt();
  scrollDown();
}
function insertText(t) {
  const s = input.selectionStart ?? input.value.length, e = input.selectionEnd ?? s;
  input.value = input.value.slice(0, s) + t + input.value.slice(e);
  input.setSelectionRange(s + t.length, s + t.length);
}
function moveCursor(d) {
  const p = Math.max(0, Math.min(input.value.length, (input.selectionStart ?? 0) + d));
  input.setSelectionRange(p, p);
}

input.addEventListener('keydown', e => {
  if (e.isComposing) return;
  const k = e.key;
  if (k === 'Enter') { e.preventDefault(); submit(); }
  else if (k === 'Tab') { e.preventDefault(); complete(); }
  else if (k === 'ArrowUp') { e.preventDefault(); historyNav(-1); }
  else if (k === 'ArrowDown') { e.preventDefault(); historyNav(1); }
  else if (e.ctrlKey && !e.metaKey) {
    const c = k.toLowerCase();
    if (c === 'c') { e.preventDefault(); ctrlC(); }
    else if (c === 'l') { e.preventDefault(); clearScreen(); }
    else if (c === 'u') { e.preventDefault(); input.value = input.value.slice(input.selectionStart); input.setSelectionRange(0, 0); }
    else if (c === 'a') { e.preventDefault(); input.setSelectionRange(0, 0); }
    else if (c === 'e') { e.preventDefault(); moveCursor(Infinity); }
  }
});

// Special keys bar: pointerdown + preventDefault keeps the software keyboard open.
$('keys').addEventListener('pointerdown', e => {
  const b = e.target.closest('button');
  if (!b) return;
  e.preventDefault();
  if (document.activeElement !== input) input.focus();
  if (b.dataset.i) insertText(b.dataset.i);
  else ({
    tab: complete, up: () => historyNav(-1), down: () => historyNav(1),
    left: () => moveCursor(-1), right: () => moveCursor(1), ctrlc: ctrlC, ctrll: clearScreen,
  })[b.dataset.k]?.();
});

function focusInput() {
  if (!$('editor').hidden || matrixStop) return;
  input.focus({ preventScroll: true });
}
// Tap anywhere in the terminal focuses the input, unless the user is selecting text.
term.addEventListener('click', () => {
  if (String(getSelection())) return;
  focusInput();
});
$('hud').addEventListener('click', () => {
  if (busy) return;
  print(game.missionText());
  scrollDown();
  focusInput();
});

// ---------- viewport (iOS keyboard handling) ----------
function fitViewport() {
  const vv = window.visualViewport;
  const h = vv ? vv.height : innerHeight;
  document.documentElement.style.setProperty('--vh', `${h}px`);
  if (vv) window.scrollTo(0, 0);
  measureCols();
  scrollDown();
}
window.visualViewport?.addEventListener('resize', fitViewport);
window.visualViewport?.addEventListener('scroll', () => window.scrollTo(0, 0));
addEventListener('resize', fitViewport);
addEventListener('pagehide', save);
document.addEventListener('visibilitychange', () => { if (document.hidden) save(); });

// ---------- service worker (offline) ----------
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
  navigator.serviceWorker.register('sw.js').catch(() => { /* offline support is optional */ });
}

// ---------- start ----------
(async () => {
  fitViewport();
  updateHud();
  renderPrompt();
  if (saved) welcome(true);
  else {
    await bootSequence(BOOT, false);
    welcome(false);
  }
  renderPrompt();
  scrollDown();
  focusInput();
})();
