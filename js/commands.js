// Command implementations. Each command receives a context:
// { name, args, stdin, out(s), err(s), tty, io, sh, fs, p(path) } and returns an exit code.
import { normalize, FsError, parentPath, baseName, now } from './vfs.js';
import { MAN, HOSTS, SITES } from './world.js';
import { awkRun, calc, AwkError } from './awk.js';

export class Usage extends Error {}
export const commands = Object.create(null);
// Shell builtins have no binary in /usr/bin.
export const BUILTINS = new Set(['cd', 'export', 'unset', 'alias', 'unalias', 'history', 'source', '.', 'exit',
  'type', 'mission', 'hint', 'missions', 'stats', 'theme', 'reset', 'help', '[', 'test', 'true', 'false', 'echo', 'pwd']);

const E = '\x1b[';
export const C = {
  r: E + '0m', b: E + '1m', red: E + '31m', green: E + '32m', yellow: E + '33m', blue: E + '34m',
  magenta: E + '35m', cyan: E + '36m', gray: E + '90m',
  bred: E + '1;31m', bgreen: E + '1;32m', byellow: E + '1;33m', bblue: E + '1;34m', bcyan: E + '1;36m',
};

// ---------- helpers ----------

export function opts(ctx, bools, valued = '', long = {}, stopAtOperand = false) {
  const o = {}, rest = [];
  const a = ctx.args;
  for (let i = 0; i < a.length; i++) {
    const s = a[i];
    if (s === '--') { rest.push(...a.slice(i + 1)); break; }
    if (s.startsWith('--')) {
      const eq = s.indexOf('=');
      const k = eq < 0 ? s : s.slice(0, eq);
      const fl = long[k];
      if (!fl) throw new Usage(`unrecognized option '${k}'`);
      if (valued.includes(fl)) o[fl] = eq < 0 ? a[++i] : s.slice(eq + 1);
      else o[fl] = true;
      continue;
    }
    if (s[0] === '-' && s.length > 1) {
      for (let j = 1; j < s.length; j++) {
        const ch = s[j];
        if (valued.includes(ch)) {
          const v = s.slice(j + 1) || a[++i];
          if (v === undefined) throw new Usage(`option requires an argument -- '${ch}'`);
          o[ch] = v;
          break;
        }
        if (!bools.includes(ch)) throw new Usage(`invalid option -- '${ch}'`);
        o[ch] = true;
      }
      continue;
    }
    rest.push(s);
    if (stopAtOperand) { rest.push(...a.slice(i + 1)); break; }
  }
  return { o, rest };
}

export const lines = text => { const l = text.split('\n'); if (l[l.length - 1] === '') l.pop(); return l; };
export const pad = (n, w = 2, c = '0') => String(n).padStart(w, c);
export const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const cmpS = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
// Short time zone name (CET/CEST in Germany). Initials of the long name are wrong:
// "Central European Standard Time" would become "CEST".
export function tzAbbr(d = new Date()) {
  let s = 'UTC';
  try { s = new Intl.DateTimeFormat('en-US', { timeZoneName: 'short' }).formatToParts(d).find(p => p.type === 'timeZoneName')?.value ?? 'UTC'; } catch { /* no Intl */ }
  return { 'GMT+1': 'CET', 'GMT+2': 'CEST', GMT: 'UTC', UTC: 'UTC' }[s] ?? s;
}
export const UID = { root: 0, daemon: 1, 'www-data': 33, hacker: 1000 };

// Read operands (or stdin) as text; reports errors in the usual "cmd: file: msg" form.
export function readAll(ctx, files) {
  const res = [];
  if (!files.length) files = ['-'];
  for (const f of files) {
    if (f === '-') { res.push({ name: '-', text: ctx.stdin ?? '' }); continue; }
    try { res.push({ name: f, text: ctx.fs.readFile(ctx.p(f)) }); } catch (e) {
      ctx.err(`${ctx.name}: ${f}: ${e.message}\n`);
      ctx.fail = 1;
    }
  }
  return res;
}

export function human(n) {
  if (n < 1024) return String(n);
  for (const u of ['K', 'M', 'G', 'T']) {
    n /= 1024;
    if (n < 1024 || u === 'T') return (n < 10 ? (Math.ceil(n * 10) / 10).toFixed(1) : String(Math.ceil(n))) + u;
  }
}

export function modeStr(n) {
  const t = n.t === 'd' ? 'd' : n.t === 'l' ? 'l' : '-';
  let s = '';
  for (let i = 8; i >= 0; i--) s += (n.m >> i) & 1 ? 'rwx'[(8 - i) % 3] : '-';
  return t + s;
}

function lsDate(ts) {
  const d = new Date(ts * 1000);
  const old = Math.abs(Date.now() - d.getTime()) > 15552000000;
  return `${MON[d.getMonth()]} ${pad(d.getDate(), 2, ' ')} ${old ? ' ' + d.getFullYear() : pad(d.getHours()) + ':' + pad(d.getMinutes())}`;
}

const POSIX = {
  digit: '0-9', alpha: 'A-Za-z', alnum: 'A-Za-z0-9', upper: 'A-Z', lower: 'a-z',
  space: ' \\t\\n\\r', xdigit: '0-9A-Fa-f', punct: '!-\\/:-@\\[-`{-~',
};

// Convert a POSIX basic regular expression into JS syntax.
function bre(s) {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === '\\' && i + 1 < s.length) {
      const n = s[++i];
      out += '|+?(){}'.includes(n) ? n : n === '<' || n === '>' ? '\\b' : '\\' + n;
    } else if (c === '[') {
      const j = s.indexOf(']', i + 2);
      if (j < 0) out += '\\[';
      else { out += s.slice(i, j + 1); i = j; }
    } else if ('|+?(){}'.includes(c)) out += '\\' + c;
    else out += c;
  }
  return out;
}

export function toRegex(pat, { ext = false, fixed = false, icase = false, word = false, global = true } = {}) {
  let src;
  if (fixed) src = pat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  else {
    src = pat.replace(/\[:(\w+):\]/g, (m, c) => POSIX[c] ?? m);
    if (!ext) src = bre(src);
  }
  if (word) src = `\\b(?:${src})\\b`;
  return new RegExp(src, (global ? 'g' : '') + (icase ? 'i' : ''));
}

function globRe(pat, icase) {
  let re = '^';
  for (let i = 0; i < pat.length; i++) {
    const c = pat[i];
    if (c === '*') re += '.*';
    else if (c === '?') re += '.';
    else if (c === '[') {
      const j = pat.indexOf(']', i + 2);
      if (j < 0) re += '\\[';
      else { re += '[' + pat.slice(i + 1, j).replace(/^!/, '^') + ']'; i = j; }
    } else re += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(re + '$', icase ? 'i' : '');
}

export const joinPath = (a, b) => (a.endsWith('/') ? a + b : a + '/' + b);
const clone = n => JSON.parse(JSON.stringify(n));

// Depth-first walk yielding { disp, path, node, depth }.
function* walk(fs, disp, path, depth = 0, onError) {
  const node = fs.tryLookup(path, false);
  if (!node) return;
  yield { disp, path, node, depth };
  if (node.t !== 'd') return;
  let names;
  try { names = fs.readdir(path); } catch (e) { if (onError) onError(disp, e); return; }
  for (const n of names) yield* walk(fs, joinPath(disp, n), joinPath(path, n), depth + 1, onError);
}

// ---------- navigation ----------

commands.pwd = ctx => { ctx.out(ctx.sh.cwd + '\n'); };

commands.cd = ctx => {
  const sh = ctx.sh;
  if (ctx.args.length > 1) { ctx.err('bash: cd: too many arguments\n'); return 1; }
  let t = ctx.args[0];
  if (t === undefined) t = sh.env.HOME || '/';
  else if (t === '-') {
    t = sh.env.OLDPWD;
    if (!t) { ctx.err('bash: cd: OLDPWD not set\n'); return 1; }
    ctx.out(t + '\n');
  }
  const p = ctx.p(t);
  try {
    const n = ctx.fs.lookup(p);
    if (n.t !== 'd') throw new FsError('ENOTDIR');
    if (!ctx.fs.can(n, 'x')) throw new FsError('EACCES');
  } catch (e) { ctx.err(`bash: cd: ${t}: ${e.message}\n`); return 1; }
  sh.env.OLDPWD = sh.cwd;
  sh.cwd = p;
  sh.env.PWD = p;
};

commands.ls = ctx => {
  const { o, rest } = opts(ctx, 'laAhR1dtrSF', '', {
    '--all': 'a', '--almost-all': 'A', '--human-readable': 'h', '--recursive': 'R', '--reverse': 'r', '--color': '_',
  });
  const fs = ctx.fs;
  const targets = rest.length ? rest : ['.'];
  let code = 0;
  const files = [], dirs = [];
  for (const t of targets) {
    try {
      let n = fs.lookup(ctx.p(t), false);
      if (n.t === 'l' && !o.l && !o.d) n = fs.tryLookup(ctx.p(t)) || n;
      (n.t === 'd' && !o.d ? dirs : files).push({ name: t, node: n, path: ctx.p(t) });
    } catch (e) { ctx.err(`ls: cannot access '${t}': ${e.message}\n`); code = 2; }
  }
  const paint = (name, n) => {
    let s = name;
    if (ctx.tty) {
      if (n.t === 'd') s = C.bblue + name + C.r;
      else if (n.t === 'l') s = C.bcyan + name + C.r;
      else if (n.m & 0o111) s = C.bgreen + name + C.r;
    }
    if (o.F) s += n.t === 'd' ? '/' : n.t === 'l' ? '@' : n.m & 0o111 ? '*' : '';
    return s;
  };
  const order = ents => {
    ents.sort((a, b) => (o.t ? b.node.mt - a.node.mt : o.S ? fs.size(b.node) - fs.size(a.node) : 0) || cmpS(a.name, b.name));
    if (o.r) ents.reverse();
    return ents;
  };
  const print = ents => {
    if (o.l) {
      const rows = ents.map(e => {
        const n = e.node;
        const nlink = n.t === 'd' ? 2 + Object.values(n.c).filter(c => c.t === 'd').length : 1;
        const size = o.h ? human(fs.size(n)) : String(fs.size(n));
        return [modeStr(n), String(nlink), n.o, n.g, size, lsDate(n.mt), paint(e.name, n) + (n.t === 'l' ? ' -> ' + n.to : '')];
      });
      const w = i => Math.max(...rows.map(r => r[i].length), 0);
      const w1 = w(1), w2 = w(2), w3 = w(3), w4 = w(4);
      for (const r of rows) {
        ctx.out(`${r[0]} ${r[1].padStart(w1)} ${r[2].padEnd(w2)} ${r[3].padEnd(w3)} ${r[4].padStart(w4)} ${r[5]} ${r[6]}\n`);
      }
    } else if (!ctx.tty || o['1']) {
      for (const e of ents) ctx.out(paint(e.name, e.node) + '\n');
    } else if (ents.length) {
      const extra = o.F ? 1 : 0;
      const width = Math.max(...ents.map(e => e.name.length + extra)) + 2;
      const cols = Math.max(1, Math.floor(ctx.sh.cols / width));
      const rows = Math.ceil(ents.length / cols);
      for (let r = 0; r < rows; r++) {
        let line = '';
        for (let c = 0; c < cols; c++) {
          const e = ents[c * rows + r];
          if (!e) continue;
          const lastCol = !ents[(c + 1) * rows + r];
          line += paint(e.name, e.node) + (lastCol ? '' : ' '.repeat(width - e.name.length - (o.F && paint(e.name, e.node).match(/[/@*]$/) ? 1 : 0)));
        }
        ctx.out(line + '\n');
      }
    }
  };
  let first = true;
  const multi = targets.length > 1 || o.R;
  const listDir = (path, disp) => {
    let names;
    try { names = fs.readdir(path); } catch (e) {
      ctx.err(`ls: cannot open directory '${disp}': ${e.message}\n`); code = 2; return;
    }
    const dir = fs.lookup(path);
    let ents = names.filter(n => o.a || o.A || n[0] !== '.').map(n => ({ name: n, node: dir.c[n] }));
    order(ents);
    if (o.a) ents = [{ name: '.', node: dir }, { name: '..', node: fs.lookup(parentPath(path)) }, ...ents];
    if (!first) ctx.out('\n');
    first = false;
    if (multi) ctx.out(disp + ':\n');
    if (o.l) {
      const total = ents.reduce((s, e) => s + (e.node.t === 'd' ? 4 : e.node.t === 'l' ? 0 : Math.ceil(fs.size(e.node) / 4096) * 4), 0);
      ctx.out(`total ${total}\n`);
    }
    print(ents);
    if (o.R) {
      for (const e of ents) {
        if (e.node.t === 'd' && e.name !== '.' && e.name !== '..') listDir(joinPath(path, e.name), joinPath(disp, e.name));
      }
    }
  };
  if (files.length) { print(order(files)); first = false; }
  dirs.sort((a, b) => cmpS(a.name, b.name));
  for (const dd of dirs) listDir(dd.path, dd.name);
  return code;
};

commands.tree = ctx => {
  const { o, rest } = opts(ctx, 'ad', 'L');
  const fs = ctx.fs;
  let nd = 0, nf = 0, code = 0;
  const max = o.L ? parseInt(o.L) : Infinity;
  const rec = (path, prefix, depth) => {
    let names;
    try { names = fs.readdir(path); } catch { return; }
    const dir = fs.lookup(path);
    names = names.filter(n => (o.a || n[0] !== '.') && (!o.d || dir.c[n].t === 'd'));
    names.forEach((n, i) => {
      const node = dir.c[n];
      const last = i === names.length - 1;
      const label = node.t === 'd' && ctx.tty ? C.bblue + n + C.r : node.t === 'l' ? `${n} -> ${node.to}` : n;
      ctx.out(prefix + (last ? '└── ' : '├── ') + label + '\n');
      if (node.t === 'd') { nd++; if (depth < max) rec(joinPath(path, n), prefix + (last ? '    ' : '│   '), depth + 1); } else nf++;
    });
  };
  for (const t of rest.length ? rest : ['.']) {
    const n = fs.tryLookup(ctx.p(t));
    if (!n || n.t !== 'd') { ctx.out(`${t}  [error opening dir]\n`); code = 2; continue; }
    ctx.out((ctx.tty ? C.bblue + t + C.r : t) + '\n');
    rec(ctx.p(t), '', 1);
  }
  ctx.out(`\n${nd} director${nd === 1 ? 'y' : 'ies'}` + (o.d ? '\n' : `, ${nf} file${nf === 1 ? '' : 's'}\n`));
  return code;
};

// ---------- reading ----------

commands.cat = ctx => {
  const { o, rest } = opts(ctx, 'nAbE');
  let n = 1;
  for (const f of readAll(ctx, rest)) {
    if (!o.n && !o.b) { ctx.out(f.text); continue; }
    for (const l of lines(f.text)) ctx.out(o.b && !l ? '\n' : `${pad(n++, 6, ' ')}\t${l}\n`);
  }
};
commands.less = commands.more = ctx => { for (const f of readAll(ctx, ctx.args.filter(a => a[0] !== '-'))) ctx.out(f.text); };

function headTail(ctx, tail) {
  const args = ctx.args.flatMap(a => (/^-\d+$/.test(a) ? ['-n', a.slice(1)] : [a]));
  const { o, rest } = opts({ args }, 'qvf', 'nc', { '--lines': 'n' });
  let n = 10, from = false;
  if (o.n !== undefined) {
    if (!/^[+-]?\d+$/.test(o.n)) { ctx.err(`${ctx.name}: invalid number of lines: '${o.n}'\n`); return 1; }
    from = tail && o.n[0] === '+';
    n = Math.abs(parseInt(o.n));
  }
  const files = readAll(ctx, rest);
  files.forEach((f, i) => {
    if (files.length > 1 || o.v) ctx.out(`${i ? '\n' : ''}==> ${f.name === '-' ? 'standard input' : f.name} <==\n`);
    const l = lines(f.text);
    const sel = tail ? (from ? l.slice(n - 1) : n ? l.slice(-n) : []) : l.slice(0, n);
    if (sel.length) ctx.out(sel.join('\n') + '\n');
  });
}
commands.head = ctx => headTail(ctx, false);
commands.tail = ctx => headTail(ctx, true);

commands.tac = ctx => { for (const f of readAll(ctx, ctx.args)) { const l = lines(f.text).reverse(); if (l.length) ctx.out(l.join('\n') + '\n'); } };
commands.rev = ctx => { for (const f of readAll(ctx, ctx.args)) for (const l of lines(f.text)) ctx.out([...l].reverse().join('') + '\n'); };
commands.nl = ctx => {
  let n = 1;
  for (const f of readAll(ctx, ctx.args.filter(a => a[0] !== '-' || a === '-'))) {
    for (const l of lines(f.text)) ctx.out(l ? `${pad(n++, 6, ' ')}\t${l}\n` : '\n');
  }
};

commands.wc = ctx => {
  const { o, rest } = opts(ctx, 'lwcm', '', { '--lines': 'l', '--words': 'w', '--bytes': 'c' });
  const all = !o.l && !o.w && !o.c && !o.m;
  const files = readAll(ctx, rest);
  const enc = new TextEncoder();
  const rows = files.map(f => ({
    l: (f.text.match(/\n/g) || []).length,
    w: (f.text.match(/\S+/g) || []).length,
    c: o.m ? [...f.text].length : enc.encode(f.text).length,
    name: f.name === '-' ? '' : f.name,
  }));
  if (rows.length > 1) rows.push({ l: rows.reduce((s, r) => s + r.l, 0), w: rows.reduce((s, r) => s + r.w, 0), c: rows.reduce((s, r) => s + r.c, 0), name: 'total' });
  const cols = r => [all || o.l ? r.l : null, all || o.w ? r.w : null, all || o.c || o.m ? r.c : null].filter(v => v !== null);
  const single = cols(rows[0] || { l: 0, w: 0, c: 0 }).length === 1;
  const stdinOnly = !rest.length;
  const width = single && rows.length === 1 ? 1 : stdinOnly ? 7 : Math.max(...rows.flatMap(r => cols(r).map(v => String(v).length)));
  for (const r of rows) ctx.out(cols(r).map(v => String(v).padStart(width)).join(' ') + (r.name ? ' ' + r.name : '') + '\n');
};

commands.file = ctx => {
  for (const f of ctx.args) {
    const n = ctx.fs.tryLookup(ctx.p(f), false);
    let d;
    if (!n) d = 'cannot open `' + f + "' (No such file or directory)";
    else if (n.t === 'd') d = 'directory';
    else if (n.t === 'l') d = 'symbolic link to ' + n.to;
    else if (!n.d) d = 'empty';
    else if (n.d.startsWith('\x7fELF')) d = 'ELF 64-bit LSB pie executable, x86-64, dynamically linked, stripped';
    else if (n.d.startsWith('SIMTAR1\n')) d = 'POSIX tar archive (GNU)';
    else if (n.d.startsWith('\x1f\x8b')) { const nm = n.d.slice(4, Math.max(4, n.d.indexOf('\x00'))); d = `gzip compressed data${nm ? `, was "${nm}"` : ''}, from Unix`; }
    else if (n.d.startsWith('#!')) d = 'Bourne-Again shell script, ASCII text executable';
    else if (/^\s*<(!doctype|html)/i.test(n.d)) d = 'HTML document, ASCII text';
    else if (/[^\x00-\x7f]/.test(n.d)) d = 'Unicode text, UTF-8 text';
    else d = 'ASCII text';
    ctx.out(`${f}: ${d}\n`);
  }
};

commands.stat = ctx => {
  for (const f of ctx.args) {
    let n;
    try { n = ctx.fs.lookup(ctx.p(f), false); } catch (e) { ctx.err(`stat: cannot statx '${f}': ${e.message}\n`); ctx.fail = 1; continue; }
    const size = ctx.fs.size(n);
    const kind = n.t === 'd' ? 'directory' : n.t === 'l' ? 'symbolic link' : size ? 'regular file' : 'regular empty file';
    const d = new Date(n.mt * 1000);
    const ts = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.000000000`;
    const uid = UID[n.o] ?? 1000, gid = UID[n.g] ?? 1000;
    ctx.out(`  File: ${f}${n.t === 'l' ? ' -> ' + n.to : ''}\n`);
    ctx.out(`  Size: ${String(size).padEnd(10)}\tBlocks: ${String(Math.ceil(size / 4096) * 8).padEnd(10)} IO Block: 4096   ${kind}\n`);
    ctx.out(`Access: (${pad(n.m.toString(8), 4)}/${modeStr(n)})  Uid: (${pad(uid, 5, ' ')}/${n.o.padStart(8)})   Gid: (${pad(gid, 5, ' ')}/${n.g.padStart(8)})\n`);
    ctx.out(`Modify: ${ts}\nChange: ${ts}\n`);
  }
};

// ---------- file management ----------

commands.touch = ctx => {
  const { rest } = opts(ctx, 'acm');
  if (!rest.length) throw new Usage('missing file operand');
  for (const f of rest) {
    try {
      const n = ctx.fs.tryLookup(ctx.p(f));
      if (n) n.mt = now(); else ctx.fs.writeFile(ctx.p(f), '');
    } catch (e) { ctx.err(`touch: cannot touch '${f}': ${e.message}\n`); ctx.fail = 1; }
  }
};

commands.mkdir = ctx => {
  const { o, rest } = opts(ctx, 'pv', '', { '--parents': 'p' });
  if (!rest.length) throw new Usage('missing operand');
  for (const f of rest) {
    const p = ctx.p(f);
    try {
      if (o.p) {
        let cur = '';
        for (const part of p.split('/').filter(Boolean)) {
          cur += '/' + part;
          const n = ctx.fs.tryLookup(cur);
          if (!n) { ctx.fs.mkdir(cur); if (o.v) ctx.out(`mkdir: created directory '${cur}'\n`); }
          else if (n.t !== 'd') throw new FsError('ENOTDIR');
        }
      } else {
        ctx.fs.mkdir(p);
        if (o.v) ctx.out(`mkdir: created directory '${f}'\n`);
      }
    } catch (e) { ctx.err(`mkdir: cannot create directory '${f}': ${e.message}\n`); ctx.fail = 1; }
  }
};

commands.rmdir = ctx => {
  const { rest } = opts(ctx, 'pv');
  if (!rest.length) throw new Usage('missing operand');
  for (const f of rest) {
    try {
      const n = ctx.fs.lookup(ctx.p(f), false);
      if (n.t !== 'd') throw new FsError('ENOTDIR');
      if (Object.keys(n.c).length) throw new FsError('ENOTEMPTY');
      ctx.fs.remove(ctx.p(f));
    } catch (e) { ctx.err(`rmdir: failed to remove '${f}': ${e.message}\n`); ctx.fail = 1; }
  }
};

commands.rm = ctx => {
  const { o, rest } = opts(ctx, 'rRfiv', '', { '--recursive': 'r', '--force': 'f', '--no-preserve-root': '_' });
  const rec = o.r || o.R;
  if (!rest.length) { if (o.f) return 0; throw new Usage('missing operand'); }
  for (const f of rest) {
    const p = ctx.p(f);
    if (/(^|\/)\.\.?\/?$/.test(f)) { ctx.err(`rm: refusing to remove '.' or '..' directory: skipping '${f}'\n`); ctx.fail = 1; continue; }
    if (p === '/') {
      ctx.err("rm: it is dangerous to operate recursively on '/'\nrm: use --no-preserve-root to override this failsafe\n");
      ctx.fail = 1; continue;
    }
    try {
      const n = ctx.fs.lookup(p, false);
      if (n.t === 'd' && !rec) throw new FsError('EISDIR');
      if (ctx.sh.cwd === p || ctx.sh.cwd.startsWith(p + '/')) ctx.sh.flags.orphaned = true;
      ctx.fs.remove(p);
      if (o.v) ctx.out(`removed ${n.t === 'd' ? 'directory ' : ''}'${f}'\n`);
    } catch (e) {
      if (o.f && e.code === 'ENOENT') continue;
      ctx.err(`rm: cannot remove '${f}': ${e.message}\n`); ctx.fail = 1;
    }
  }
  if (!ctx.fs.tryLookup(ctx.sh.cwd)) ctx.sh.cwd = '/';
};

function copyMove(ctx, move) {
  const name = ctx.name;
  const { o, rest } = opts(ctx, 'rRfivpanu', '', { '--recursive': 'r', '--force': 'f' });
  const rec = o.r || o.R || o.a;
  if (!rest.length) throw new Usage('missing file operand');
  if (rest.length === 1) throw new Usage(`missing destination file operand after '${rest[0]}'`);
  const dest = rest.pop();
  const dnode = ctx.fs.tryLookup(ctx.p(dest));
  const intoDir = dnode && dnode.t === 'd';
  if (rest.length > 1 && !intoDir) { ctx.err(`${name}: target '${dest}': Not a directory\n`); return 1; }
  const chown = n => { n.o = n.g = ctx.fs.user; n.mt = now(); if (n.t === 'd') Object.values(n.c).forEach(chown); };
  for (const src of rest) {
    const sp = ctx.p(src);
    const base = baseName(sp) || src;
    const tp = intoDir ? joinPath(ctx.p(dest), base) : ctx.p(dest);
    const tdisp = intoDir ? joinPath(dest, base) : dest;
    try {
      const n = ctx.fs.lookup(sp, false);
      if (tp === sp) { ctx.err(`${name}: '${src}' and '${tdisp}' are the same file\n`); ctx.fail = 1; continue; }
      if (n.t === 'd' && (tp + '/').startsWith(sp + '/')) {
        ctx.err(`${name}: cannot ${move ? 'move' : 'copy'} '${src}' ${move ? 'to a subdirectory of' : 'into'} itself, '${tdisp}'\n`);
        ctx.fail = 1; continue;
      }
      const existing = ctx.fs.tryLookup(tp, false);
      if (existing && existing.t === 'd' && n.t !== 'd') {
        ctx.err(`${name}: cannot overwrite directory '${tdisp}' with non-directory\n`); ctx.fail = 1; continue;
      }
      if (move) {
        ctx.fs.parent(tp); // fail early if the target directory is missing
        const { dir } = ctx.fs.parent(sp);
        if (!ctx.fs.can(dir, 'w')) throw new FsError('EACCES');
        ctx.fs.put(tp, n);
        ctx.fs.remove(sp);
      } else {
        if (n.t === 'd' && !rec) { ctx.err(`cp: -r not specified; omitting directory '${src}'\n`); ctx.fail = 1; continue; }
        if (n.t === 'f' && !ctx.fs.can(n, 'r')) throw new FsError('EACCES');
        if (n.t === 'f' && existing && existing.t === 'f') ctx.fs.writeFile(tp, n.d);
        else { const c = clone(n); if (!o.p && !o.a) chown(c); ctx.fs.put(tp, c); }
      }
      if (o.v) ctx.out(`${move ? 'renamed ' : ''}'${src}' -> '${tdisp}'\n`);
    } catch (e) {
      const what = move ? `cannot move '${src}' to '${tdisp}'` : e.code === 'ENOENT' && !ctx.fs.tryLookup(sp, false) ? `cannot stat '${src}'` : `cannot create regular file '${tdisp}'`;
      ctx.err(`${name}: ${move && !ctx.fs.tryLookup(sp, false) ? `cannot stat '${src}'` : what}: ${e.message}\n`);
      ctx.fail = 1;
    }
  }
}
commands.cp = ctx => copyMove(ctx, false);
commands.mv = ctx => copyMove(ctx, true);

commands.ln = ctx => {
  const { o, rest } = opts(ctx, 'sfv');
  if (!rest.length) throw new Usage('missing file operand');
  const target = rest[0];
  let link = rest[1] ?? baseName(target);
  const ln = ctx.fs.tryLookup(ctx.p(link));
  if (ln && ln.t === 'd') link = joinPath(link, baseName(target));
  try {
    if (ctx.fs.tryLookup(ctx.p(link), false)) {
      if (!o.f) throw new FsError('EEXIST');
      ctx.fs.remove(ctx.p(link));
    }
    if (o.s) ctx.fs.put(ctx.p(link), ctx.fs.node('l', { to: target }, 0o777));
    else {
      const n = ctx.fs.lookup(ctx.p(target));
      if (n.t === 'd') { ctx.err(`ln: ${target}: hard link not allowed for directory\n`); return 1; }
      ctx.fs.put(ctx.p(link), n);
    }
  } catch (e) { ctx.err(`ln: failed to create ${o.s ? 'symbolic' : 'hard'} link '${link}': ${e.message}\n`); return 1; }
};

commands.readlink = ctx => {
  for (const f of ctx.args.filter(a => a[0] !== '-')) {
    const n = ctx.fs.tryLookup(ctx.p(f), false);
    if (n && n.t === 'l') ctx.out(n.to + '\n'); else ctx.fail = 1;
  }
};
commands.realpath = ctx => { for (const f of ctx.args) ctx.out(ctx.p(f) + '\n'); };
commands.basename = ctx => {
  if (!ctx.args.length) throw new Usage('missing operand');
  let b = ctx.args[0].replace(/\/+$/, '').split('/').pop() || '/';
  if (ctx.args[1] && b.endsWith(ctx.args[1]) && b !== ctx.args[1]) b = b.slice(0, -ctx.args[1].length);
  ctx.out(b + '\n');
};
commands.dirname = ctx => {
  if (!ctx.args.length) throw new Usage('missing operand');
  for (const a of ctx.args) {
    const s = a.replace(/\/+$/, '');
    const i = s.lastIndexOf('/');
    ctx.out((i < 0 ? '.' : i === 0 ? '/' : s.slice(0, i)) + '\n');
  }
};

commands.nano = commands.vi = commands.vim = ctx => {
  const f = ctx.args.find(a => a[0] !== '-');
  if (!f) { ctx.err(`${ctx.name}: bitte eine Datei angeben, z.B. ${ctx.name} notes.txt\n`); return 1; }
  const p = ctx.p(f);
  let text = '';
  const n = ctx.fs.tryLookup(p);
  if (n) {
    if (n.t === 'd') { ctx.err(`${ctx.name}: ${f}: Is a directory\n`); return 1; }
    try { text = ctx.fs.readFile(p); } catch (e) { ctx.err(`${ctx.name}: ${f}: ${e.message}\n`); return 1; }
  }
  ctx.sh.request = { type: 'editor', path: p, name: f, text, editor: ctx.name, user: ctx.fs.user };
};

commands.tar = ctx => {
  const a = [...ctx.args];
  if (!a.length) throw new Usage('You must specify one of the -c, -t, -x options');
  let flags = a.shift().replace(/^-/, '');
  while (a[0] && /^-[a-zA-Z]+$/.test(a[0])) flags += a.shift().slice(1);
  if (/[^cxtvzfjJ]/.test(flags)) throw new Usage(`invalid option -- '${flags.match(/[^cxtvzfjJ]/)[0]}'`);
  if (!flags.includes('f')) { ctx.err('tar: Refusing to read/write archive from/to terminal (missing -f option?)\n'); return 2; }
  const archive = a.shift();
  if (!archive) throw new Usage("option requires an argument -- 'f'");
  const v = flags.includes('v');
  if (flags.includes('c')) {
    if (!a.length) { ctx.err('tar: Cowardly refusing to create an empty archive\n'); return 2; }
    const entries = [];
    for (const src of a) {
      const disp = src.replace(/^\/+/, '').replace(/\/+$/, '');
      if (!ctx.fs.tryLookup(ctx.p(src), false)) { ctx.err(`tar: ${src}: Cannot stat: No such file or directory\n`); ctx.fail = 1; continue; }
      for (const e of walk(ctx.fs, disp, ctx.p(src))) {
        const n = e.node;
        if (n.t === 'f' && !ctx.fs.can(n, 'r')) { ctx.err(`tar: ${e.disp}: Cannot open: Permission denied\n`); ctx.fail = 1; continue; }
        entries.push({ p: e.disp, t: n.t, m: n.m, d: n.t === 'f' ? n.d : undefined, to: n.to });
        if (v) ctx.out(e.disp + (n.t === 'd' ? '/' : '') + '\n');
      }
    }
    try { ctx.fs.writeFile(ctx.p(archive), 'SIMTAR1\n' + JSON.stringify(entries)); } catch (e) { ctx.err(`tar: ${archive}: Cannot open: ${e.message}\n`); return 2; }
    return ctx.fail ? 2 : 0;
  }
  let entries;
  try {
    const raw = ctx.fs.readFile(ctx.p(archive));
    if (!raw.startsWith('SIMTAR1\n')) { ctx.err('tar: This does not look like a tar archive\ntar: Exiting with failure status due to previous errors\n'); return 2; }
    entries = JSON.parse(raw.slice(8));
  } catch (e) { ctx.err(`tar: ${archive}: Cannot open: ${e.message}\n`); return 2; }
  // The archive is a plain file the user can edit, so treat every entry as untrusted.
  const valid = e => e && typeof e === 'object' && typeof e.p === 'string' && e.p && ['f', 'd', 'l'].includes(e.t)
    && (e.t !== 'f' || typeof e.d === 'string') && (e.t !== 'l' || typeof e.to === 'string');
  if (!Array.isArray(entries) || !entries.every(valid)) {
    ctx.err('tar: Archive is corrupt\ntar: Exiting with failure status due to previous errors\n');
    return 2;
  }
  for (const e of entries) {
    if (flags.includes('t') || v) ctx.out(e.p + (e.t === 'd' ? '/' : '') + '\n');
    if (!flags.includes('x')) continue;
    const p = ctx.p(e.p);
    try {
      if (e.t === 'd') { if (!ctx.fs.tryLookup(p)) ctx.fs.mkdir(p); }
      else if (e.t === 'l') ctx.fs.put(p, ctx.fs.node('l', { to: e.to }, 0o777));
      else {
        ctx.fs.writeFile(p, e.d);
        // Like real tar: restore permission bits only on files we own, never setuid bits.
        const n = ctx.fs.lookup(p);
        if (Number.isInteger(e.m) && (n.o === ctx.fs.user || ctx.fs.user === 'root')) n.m = e.m & 0o777;
      }
    } catch (er) { ctx.err(`tar: ${e.p}: Cannot open: ${er.message}\n`); ctx.fail = 1; }
  }
  return ctx.fail ? 2 : 0;
};

// ---------- text ----------

const unescape = s => s.replace(/\\(n|t|r|e|a|\\|0[0-7]{0,3}|x[0-9a-fA-F]{1,2})/g, (m, c) => {
  if (c === 'n') return '\n';
  if (c === 't') return '\t';
  if (c === 'r') return '\r';
  if (c === 'e') return '\x1b';
  if (c === 'a') return '';
  if (c === '\\') return '\\';
  if (c[0] === 'x') return String.fromCharCode(parseInt(c.slice(1), 16));
  return String.fromCharCode(parseInt(c, 8) || 0);
});

commands.echo = ctx => {
  const a = [...ctx.args];
  let nl = true, esc = false;
  while (a.length && /^-[neE]+$/.test(a[0])) {
    const f = a.shift();
    if (f.includes('n')) nl = false;
    if (f.includes('e')) esc = true;
    if (f.includes('E')) esc = false;
  }
  let s = a.join(' ');
  if (esc) s = unescape(s);
  ctx.out(s + (nl ? '\n' : ''));
};

commands.printf = ctx => {
  if (!ctx.args.length) throw new Usage('usage: printf format [arguments]');
  const fmt = unescape(ctx.args[0]);
  const args = ctx.args.slice(1);
  let i = 0;
  const once = () => fmt.replace(/%(-?\d*)(?:\.(\d+))?([sdifxc%])/g, (m, w, prec, t) => {
    if (t === '%') return '%';
    const a = args[i++] ?? '';
    let s;
    if (t === 's') s = prec ? a.slice(0, +prec) : a;
    else if (t === 'c') s = a[0] ?? '';
    else if (t === 'f') s = (parseFloat(a) || 0).toFixed(prec ? +prec : 6);
    else if (t === 'x') s = (parseInt(a) || 0).toString(16);
    else s = String(parseInt(a) || 0);
    const width = Math.abs(+w || 0);
    return w.startsWith('-') ? s.padEnd(width) : w.startsWith('0') && t !== 's' ? s.padStart(width, '0') : s.padStart(width);
  });
  do { ctx.out(once()); } while (i < args.length && i > 0);
};

commands.grep = commands.egrep = commands.fgrep = ctx => {
  // Collect every -e PATTERN first: opts() keeps only the last value of an option.
  const pats = [], args = [];
  for (let i = 0; i < ctx.args.length; i++) {
    const x = ctx.args[i];
    if (x === '--') { args.push(...ctx.args.slice(i)); break; }
    const m = /^-([ivnclrRwoEFqHhs]*)e(.*)$/.exec(x);
    if (m) {
      if (m[1]) args.push('-' + m[1]);
      if (m[2]) pats.push(m[2]);
      else if (i + 1 < ctx.args.length) pats.push(ctx.args[++i]);
      else throw new Usage("option requires an argument -- 'e'");
      continue;
    }
    if (x.startsWith('--regexp=')) { pats.push(x.slice(9)); continue; }
    if (x === '--regexp' && i + 1 < ctx.args.length) { pats.push(ctx.args[++i]); continue; }
    args.push(x);
  }
  const { o, rest } = opts({ args }, 'ivnclrRwoEFqHhs', 'ABC', {
    '--color': '_', '--ignore-case': 'i', '--invert-match': 'v', '--line-number': 'n', '--count': 'c',
    '--recursive': 'r', '--extended-regexp': 'E', '--fixed-strings': 'F', '--quiet': 'q',
    '--after-context': 'A', '--before-context': 'B', '--context': 'C',
  });
  const ctxN = v => { const n = parseInt(v ?? '0'); if (!(n >= 0)) throw new Usage(`${v}: invalid context length argument`); return n; };
  const after = ctxN(o.A ?? o.C), before = ctxN(o.B ?? o.C);
  if (ctx.name === 'egrep') o.E = true;
  if (ctx.name === 'fgrep') o.F = true;
  const files = [...rest];
  if (!pats.length) {
    if (!files.length) throw new Usage('Usage: grep [OPTION]... PATTERNS [FILE]...');
    pats.push(files.shift());
  }
  let re;
  try {
    // Several patterns (or a pattern with newlines) match if any of them matches.
    const parts = pats.flatMap(p => p.split('\n')).map(p => toRegex(p, { ext: o.E, fixed: o.F, icase: o.i, word: o.w }));
    re = parts.length === 1 ? parts[0] : new RegExp(parts.map(r => `(?:${r.source})`).join('|'), parts[0].flags);
  } catch { ctx.err('grep: Invalid regular expression\n'); return 2; }
  const rec = o.r || o.R;
  const implicit = !files.length;
  if (implicit) files.push(rec ? '.' : '-');
  const inputs = [];
  let bad = false;
  for (const f of files) {
    if (f === '-') { inputs.push({ name: '(standard input)', text: ctx.stdin ?? '' }); continue; }
    const n = ctx.fs.tryLookup(ctx.p(f));
    if (!n) { if (!o.s) ctx.err(`grep: ${f}: No such file or directory\n`); bad = true; continue; }
    if (n.t === 'd') {
      if (!rec) { ctx.err(`grep: ${f}: Is a directory\n`); bad = true; continue; }
      for (const e of walk(ctx.fs, f, ctx.p(f), 0, (dd, er) => { ctx.err(`grep: ${dd}: ${er.message}\n`); bad = true; })) {
        if (e.node.t !== 'f') continue;
        const name = implicit ? e.disp.replace(/^\.\//, '') : e.disp;
        if (!ctx.fs.can(e.node, 'r')) { if (!o.s) ctx.err(`grep: ${name}: Permission denied\n`); bad = true; continue; }
        if (e.node.d.startsWith('\x7fELF')) continue;
        inputs.push({ name, text: e.node.d });
      }
      continue;
    }
    try { inputs.push({ name: f, text: ctx.fs.readFile(ctx.p(f)) }); } catch (e) { ctx.err(`grep: ${f}: ${e.message}\n`); bad = true; }
  }
  const showName = (o.H || inputs.length > 1 || rec) && !o.h;
  const col = ctx.tty;
  let any = false;
  for (const f of inputs) {
    let count = 0;
    const sepd = ch => (col ? `${C.cyan}${ch}${C.r}` : ch);
    const prefix = showName ? (col ? `${C.magenta}${f.name}${C.r}` : f.name) + sepd(':') : '';
    // Context lines (-A/-B/-C) use "-" instead of ":" and groups are separated by "--".
    const all = lines(f.text);
    let lastOut = -1, pending = 0;
    const ctxLine = k => {
      const pre = showName ? (col ? `${C.magenta}${f.name}${C.r}` : f.name) + sepd('-') : '';
      const nm = o.n ? (col ? `${C.green}${k + 1}${C.r}` : `${k + 1}`) + sepd('-') : '';
      ctx.out(pre + nm + all[k] + '\n');
      lastOut = k;
    };
    const gap = first => { if (lastOut >= 0 && first > lastOut + 1) ctx.out(sepd('--') + '\n'); };
    all.forEach((line, idx) => {
      re.lastIndex = 0;
      const hit = re.test(line) !== !!o.v;
      if (!hit) {
        if (pending > 0 && !(o.c || o.l || o.q)) { ctxLine(idx); pending--; }
        return;
      }
      count++; any = true;
      if (o.c || o.l || o.q) return;
      if (after || before) {
        const from = Math.max(lastOut + 1, idx - before);
        gap(from);
        for (let k = from; k < idx; k++) ctxLine(k);
        lastOut = idx;
        pending = after;
      }
      const num = o.n ? (col ? `${C.green}${idx + 1}${C.r}${C.cyan}:${C.r}` : `${idx + 1}:`) : '';
      if (o.o && !o.v) {
        re.lastIndex = 0;
        for (const m of line.matchAll(re)) if (m[0]) ctx.out(prefix + num + (col ? C.bred + m[0] + C.r : m[0]) + '\n');
      } else {
        re.lastIndex = 0;
        ctx.out(prefix + num + (col && !o.v ? line.replace(re, m => (m ? C.bred + m + C.r : m)) : line) + '\n');
      }
    });
    if (o.c) ctx.out(prefix + count + '\n');
    else if (o.l && count) ctx.out((col ? C.magenta + f.name + C.r : f.name) + '\n');
  }
  return bad ? 2 : any ? 0 : 1;
};

commands.sort = ctx => {
  const { o, rest } = opts(ctx, 'rnufbh', 'kto', { '--reverse': 'r', '--numeric-sort': 'n', '--unique': 'u' });
  let ls = readAll(ctx, rest).flatMap(f => lines(f.text));
  let key = l => l;
  if (o.k) {
    const [a, b] = o.k.split(',').map(x => parseInt(x));
    key = l => (o.t ? l.split(o.t) : l.trim().split(/\s+/)).slice(a - 1, b || undefined).join(o.t || ' ');
  }
  const num = s => { const v = parseFloat(s); return isNaN(v) ? 0 : v; };
  const hnum = s => { const m = /^\s*(-?[\d.]+)([KMGT]?)/.exec(s); return m ? parseFloat(m[1]) * 1024 ** ' KMGT'.indexOf(m[2] || ' ') : 0; };
  const loc = (a, b) => a.localeCompare(b) || cmpS(a, b);
  const cmpKey = (a, b) => {
    const ka = key(a), kb = key(b);
    return o.h ? hnum(ka) - hnum(kb) : o.n ? num(ka) - num(kb) : o.f ? loc(ka.toLowerCase(), kb.toLowerCase()) : loc(ka, kb);
  };
  ls.sort((a, b) => cmpKey(a, b) || loc(a, b));
  if (o.r) ls.reverse();
  if (o.u) ls = ls.filter((l, i) => i === 0 || cmpKey(l, ls[i - 1]) !== 0);
  const text = ls.length ? ls.join('\n') + '\n' : '';
  if (o.o) ctx.fs.writeFile(ctx.p(o.o), text); else ctx.out(text);
};

commands.uniq = ctx => {
  const { o, rest } = opts(ctx, 'cdui', '', { '--count': 'c' });
  const ls = readAll(ctx, rest.slice(0, 1)).flatMap(f => lines(f.text));
  const eq = (a, b) => (o.i ? a.toLowerCase() === b.toLowerCase() : a === b);
  const groups = [];
  for (const l of ls) {
    const g = groups[groups.length - 1];
    if (g && eq(g.l, l)) g.n++; else groups.push({ l, n: 1 });
  }
  for (const g of groups) {
    if ((o.d && g.n < 2) || (o.u && g.n > 1)) continue;
    ctx.out((o.c ? String(g.n).padStart(7) + ' ' : '') + g.l + '\n');
  }
};

function parseList(spec) {
  return spec.split(',').map(r => {
    const m = /^(\d*)(-?)(\d*)$/.exec(r);
    if (!m || (!m[1] && !m[3])) throw new Usage(`invalid field value '${r}'`);
    const a = m[1] ? +m[1] : 1;
    return [a, m[2] ? (m[3] ? +m[3] : Infinity) : a];
  });
}

commands.cut = ctx => {
  const { o, rest } = opts(ctx, 's', 'dfcb', { '--delimiter': 'd', '--fields': 'f', '--characters': 'c' });
  const spec = o.f ?? o.c ?? o.b;
  if (spec === undefined) throw new Usage('you must specify a list of bytes, characters, or fields');
  const ranges = parseList(spec);
  const pick = arr => arr.filter((x, i) => ranges.some(([a, b]) => i + 1 >= a && i + 1 <= b));
  const delim = o.d ?? '\t';
  for (const f of readAll(ctx, rest)) {
    for (const l of lines(f.text)) {
      if (o.f === undefined) { ctx.out(pick([...l]).join('') + '\n'); continue; }
      if (!l.includes(delim)) { if (!o.s) ctx.out(l + '\n'); continue; }
      ctx.out(pick(l.split(delim)).join(delim) + '\n');
    }
  }
};

function trSet(s) {
  s = unescape(s.replace(/\[:(\w+):\]/g, (m, c) => ({
    upper: 'A-Z', lower: 'a-z', digit: '0-9', alpha: 'A-Za-z', alnum: 'A-Za-z0-9', space: ' \\t\\n',
    punct: '!-/:-@[-`{-~',
  }[c] ?? m)));
  const out = [];
  const ch = [...s];
  for (let i = 0; i < ch.length; i++) {
    if (ch[i + 1] === '-' && ch[i + 2] !== undefined) {
      for (let c = ch[i].codePointAt(0); c <= ch[i + 2].codePointAt(0); c++) out.push(String.fromCodePoint(c));
      i += 2;
    } else out.push(ch[i]);
  }
  return out;
}

commands.tr = ctx => {
  const { o, rest } = opts(ctx, 'dsc');
  if (!rest.length) throw new Usage('missing operand');
  const s1 = trSet(rest[0]);
  const s2 = rest[1] !== undefined ? trSet(rest[1]) : [];
  if (!o.d && !o.s && !s2.length) throw new Usage(`missing operand after '${rest[0]}'`);
  const inSet = c => s1.includes(c) !== !!o.c;
  let out = '';
  let lastSq = null;
  for (const c of ctx.stdin ?? '') {
    let r = c;
    if (inSet(c)) {
      if (o.d) continue;
      if (s2.length) r = o.c ? s2[s2.length - 1] : s2[Math.min(s1.indexOf(c), s2.length - 1)];
    }
    if (o.s) {
      const sq = s2.length ? s2.includes(r) : inSet(c);
      if (sq && lastSq === r) continue;
      lastSq = sq ? r : null;
    }
    out += r;
  }
  ctx.out(out);
};

function parseSed(script, ext) {
  const cmds = [];
  let i = 0;
  const err = msg => new Usage(`-e expression #1, char ${i + 1}: ${msg}`);
  const delimited = delim => {
    let s = '';
    while (i < script.length && script[i] !== delim) {
      if (script[i] === '\\' && script[i + 1] === delim) { s += delim; i += 2; continue; }
      if (script[i] === '\\') { s += script[i] + (script[i + 1] ?? ''); i += 2; continue; }
      s += script[i++];
    }
    if (script[i] !== delim) throw err('unterminated command');
    i++;
    return s;
  };
  const addr = () => {
    if (/\d/.test(script[i])) { let n = ''; while (/\d/.test(script[i])) n += script[i++]; return { n: +n }; }
    if (script[i] === '$') { i++; return { last: true }; }
    if (script[i] === '/') { i++; return { re: toRegex(delimited('/'), { ext, global: false }) }; }
    return null;
  };
  while (i < script.length) {
    while (/[\s;]/.test(script[i] ?? '')) i++;
    if (i >= script.length) break;
    const c = {};
    c.a1 = addr();
    if (c.a1 && script[i] === ',') { i++; c.a2 = addr(); if (!c.a2) throw err('unexpected `,\''); }
    while (script[i] === ' ') i++;
    if (script[i] === '!') { c.neg = true; i++; }
    c.cmd = script[i++];
    if (c.cmd === 's') {
      const delim = script[i++];
      if (!delim) throw err('unterminated `s\' command');
      const pat = delimited(delim), rep = delimited(delim);
      let flags = '';
      while (/[gipI\d]/.test(script[i] ?? '')) flags += script[i++];
      c.re = toRegex(pat, { ext, global: flags.includes('g'), icase: /[iI]/.test(flags) });
      c.rep = rep.replace(/\$/g, '$$$$').replace(/\\(\d)|\\(n)|\\(&)|(&)|\\(.)/g, (m, d, n, ea, amp, other) =>
        d ? '$' + d : n ? '\n' : ea ? '&' : amp ? '$&' : other);
      c.print = flags.includes('p');
    } else if (!'dpq'.includes(c.cmd ?? '')) throw err(`unknown command: \`${c.cmd ?? ''}'`);
    cmds.push(c);
  }
  return cmds;
}

commands.sed = ctx => {
  const { o, rest } = opts(ctx, 'nEri', 'e', { '--quiet': 'n', '--in-place': 'i' });
  const script = o.e ?? rest.shift();
  if (script === undefined) throw new Usage('Usage: sed [OPTION]... {script} [input-file]...');
  const cmds = parseSed(script, o.E || o.r);
  if (o.i && !rest.length) { ctx.err('sed: no input files\n'); return 1; }
  const m = (a, n, line, last) => (a.n !== undefined ? a.n === n : a.last ? last : a.re.test(line));
  const process = text => {
    const ls = lines(text);
    let out = '';
    for (const c of cmds) c.active = false;
    for (let n = 1; n <= ls.length; n++) {
      let line = ls[n - 1];
      const last = n === ls.length;
      let deleted = false, quit = false;
      for (const c of cmds) {
        let hit = true;
        if (c.a1 && !c.a2) hit = m(c.a1, n, line, last);
        else if (c.a2) {
          if (c.active) { hit = true; if (c.a2.n !== undefined ? n >= c.a2.n : m(c.a2, n, line, last)) c.active = false; }
          else if (m(c.a1, n, line, last)) { hit = true; c.active = !(c.a2.n !== undefined && c.a2.n <= n); }
          else hit = false;
        }
        if (hit === !!c.neg) continue;
        if (c.cmd === 's') {
          const nl = line.replace(c.re, c.rep);
          const changed = c.re.test(line);
          c.re.lastIndex = 0;
          line = nl;
          if (changed && c.print) out += line + '\n';
        } else if (c.cmd === 'd') { deleted = true; break; }
        else if (c.cmd === 'p') out += line + '\n';
        else if (c.cmd === 'q') { quit = true; break; }
      }
      if (!deleted && !o.n) out += line + '\n';
      if (quit) break;
    }
    return out;
  };
  if (o.i) {
    for (const f of rest) {
      try { ctx.fs.writeFile(ctx.p(f), process(ctx.fs.readFile(ctx.p(f)))); } catch (e) { ctx.err(`sed: can't read ${f}: ${e.message}\n`); ctx.fail = 1; }
    }
    return;
  }
  for (const f of readAll(ctx, rest)) ctx.out(process(f.text));
};

commands.awk = ctx => {
  const { o, rest } = opts(ctx, '', 'Fv');
  const prog = rest.shift();
  if (prog === undefined) throw new Usage("usage: awk [-F fs] 'program' [file ...]");
  const vars = {};
  if (o.v) { const eq = o.v.indexOf('='); if (eq > 0) vars[o.v.slice(0, eq)] = o.v.slice(eq + 1); }
  const input = function* () { for (const f of readAll(ctx, rest)) yield* lines(f.text); };
  try {
    awkRun(prog, input, { out: ctx.out, FS: o.F ?? ' ', vars });
  } catch (e) {
    if (!(e instanceof AwkError)) throw e;
    ctx.err(`awk: ${e.message}\n`);
    return 2;
  }
};

commands.tee = ctx => {
  const { o, rest } = opts(ctx, 'a');
  const data = ctx.stdin ?? '';
  for (const f of rest) {
    try { ctx.fs.writeFile(ctx.p(f), data, !!o.a); } catch (e) { ctx.err(`tee: ${f}: ${e.message}\n`); ctx.fail = 1; }
  }
  ctx.out(data);
};

commands.xargs = ctx => {
  const { o, rest } = opts(ctx, 'tr0', 'nI', {}, true);
  const cmd = rest.length ? rest : ['echo'];
  const io = { ...ctx.io, stdin: null };
  let code = 0;
  const run = argv => { const c = ctx.sh.execArgv(argv, io); if (c) code = 123; };
  if (o.I) {
    for (const l of lines(ctx.stdin ?? '')) if (l.trim()) run(cmd.map(a => a.split(o.I).join(l.trim())));
    return code;
  }
  const items = (ctx.stdin ?? '').split(/\s+/).filter(Boolean);
  if (!items.length) { if (!o.r && !rest.length) ctx.out('\n'); return 0; }
  const n = o.n ? Math.max(1, parseInt(o.n)) : items.length;
  for (let i = 0; i < items.length; i += n) run([...cmd, ...items.slice(i, i + n)]);
  return code;
};

commands.diff = ctx => {
  const { o, rest } = opts(ctx, 'qsu');
  if (rest.length < 2) throw new Usage(`missing operand after '${rest[0] ?? 'diff'}'`);
  const fl = readAll(ctx, rest.slice(0, 2));
  if (fl.length < 2) return 2;
  const a = lines(fl[0].text), b = lines(fl[1].text);
  const L = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) L[i][j] = a[i] === b[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const hunks = [];
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) { i++; j++; continue; }
    const h = { a0: i, b0: j };
    while ((i < a.length || j < b.length) && !(i < a.length && j < b.length && a[i] === b[j])) {
      if (j >= b.length || (i < a.length && L[i + 1][j] >= L[i][j + 1])) i++; else j++;
    }
    h.a1 = i; h.b1 = j;
    hunks.push(h);
  }
  if (!hunks.length) { if (o.s) ctx.out(`Files ${rest[0]} and ${rest[1]} are identical\n`); return 0; }
  if (o.q) { ctx.out(`Files ${rest[0]} and ${rest[1]} differ\n`); return 1; }
  const rng = (s, e) => (e - s <= 1 ? String(e - s === 0 ? s : s + 1) : `${s + 1},${e}`);
  for (const h of hunks) {
    const del = h.a1 > h.a0, add = h.b1 > h.b0;
    ctx.out(`${rng(h.a0, h.a1)}${del && add ? 'c' : del ? 'd' : 'a'}${rng(h.b0, h.b1)}\n`);
    for (let k = h.a0; k < h.a1; k++) ctx.out((ctx.tty ? C.red : '') + '< ' + a[k] + (ctx.tty ? C.r : '') + '\n');
    if (del && add) ctx.out('---\n');
    for (let k = h.b0; k < h.b1; k++) ctx.out((ctx.tty ? C.green : '') + '> ' + b[k] + (ctx.tty ? C.r : '') + '\n');
  }
  return 1;
};

commands.base64 = ctx => {
  const { o, rest } = opts(ctx, 'di', 'w', { '--decode': 'd' });
  const f = readAll(ctx, rest.slice(0, 1))[0];
  if (!f) return 1;
  if (o.d) {
    try {
      const bin = atob(f.text.replace(/\s+/g, ''));
      ctx.out(new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0))));
    } catch { ctx.err('base64: invalid input\n'); return 1; }
  } else {
    const bytes = new TextEncoder().encode(f.text);
    let bin = '';
    for (const b of bytes) bin += String.fromCharCode(b);
    ctx.out(btoa(bin).replace(/(.{76})/g, '$1\n').replace(/\n$/, '') + '\n');
  }
};

commands.seq = ctx => {
  const n = ctx.args.filter(a => /^-?\d+(\.\d+)?$/.test(a)).map(Number);
  if (!n.length) throw new Usage('missing operand');
  const [first, step, last] = n.length === 1 ? [1, 1, n[0]] : n.length === 2 ? [n[0], 1, n[1]] : n;
  if (!step) return 1;
  let out = '';
  for (let v = first, k = 0; (step > 0 ? v <= last : v >= last) && k < 10000; v += step, k++) out += v + '\n';
  ctx.out(out);
};

commands.bc = ctx => {
  let scale = 0;
  for (const l of lines(ctx.stdin ?? '').flatMap(x => x.split(';'))) {
    if (!l.trim()) continue;
    const m = /^\s*scale\s*=\s*(\d+)\s*$/.exec(l);
    if (m) { scale = +m[1]; continue; }
    try {
      if (!/^[\d\s+\-*/%().^]+$/.test(l)) throw new AwkError('syntax error');
      const v = calc(l, { int: scale === 0 }).value;
      const f = 10 ** scale;
      ctx.out((Number.isInteger(v) ? String(v) : (Math.trunc(v * f) / f).toFixed(scale)) + '\n');
    } catch (e) { ctx.err(`(standard_in) 1: ${e instanceof AwkError ? e.message : 'syntax error'}\n`); }
  }
};

// ---------- search ----------

commands.find = ctx => {
  const a = [...ctx.args];
  const paths = [];
  while (a.length && !a[0].startsWith('-') && a[0] !== '!' && a[0] !== '(') paths.push(a.shift());
  if (!paths.length) paths.push('.');
  const tests = [];
  let maxd = Infinity, mind = 0, del = false, exec = null, print = true;
  const need = flag => { if (!a.length) throw new Usage(`missing argument to \`${flag}'`); return a.shift(); };
  while (a.length) {
    const t = a.shift();
    if (t === '-name' || t === '-iname') { const re = globRe(need(t), t === '-iname'); tests.push(e => re.test(baseName(e.path) || '/')); }
    else if (t === '-path') { const re = globRe(need(t)); tests.push(e => re.test(e.disp)); }
    else if (t === '-type') { const k = need(t); tests.push(e => e.node.t === k); }
    else if (t === '-maxdepth') maxd = parseInt(need(t));
    else if (t === '-mindepth') mind = parseInt(need(t));
    else if (t === '-empty') tests.push(e => (e.node.t === 'd' ? !Object.keys(e.node.c).length : e.node.t === 'f' && !e.node.d));
    else if (t === '-user') { const u = need(t); tests.push(e => e.node.o === u); }
    else if (t === '-perm') { const m = parseInt(need(t).replace(/^[-/]/, ''), 8); tests.push(e => (e.node.m & 0o777) === m); }
    else if (t === '-size') {
      const m = /^([+-]?)(\d+)([ckMG]?)$/.exec(need(t));
      if (!m) throw new Usage('invalid argument to `-size\'');
      const unit = { c: 1, k: 1024, M: 1048576, G: 1073741824 }[m[3]] ?? 512;
      tests.push(e => { const s = Math.ceil(ctx.fs.size(e.node) / unit); return m[1] === '+' ? s > +m[2] : m[1] === '-' ? s < +m[2] : s === +m[2]; });
    } else if (t === '-delete') { del = true; print = false; }
    else if (t === '-print') print = true;
    else if (t === '-exec') {
      exec = [];
      while (a.length && a[0] !== ';' && a[0] !== '+') exec.push(a.shift());
      if (!a.length) throw new Usage('missing argument to `-exec\'');
      a.shift();
      print = false;
    } else if (t.startsWith('-')) throw new Usage(`unknown predicate \`${t}'`);
    else throw new Usage(`paths must precede expression: \`${t}'`);
  }
  let code = 0;
  const hits = [];
  for (const p of paths) {
    if (!ctx.fs.tryLookup(ctx.p(p), false)) { ctx.err(`find: ‘${p}’: No such file or directory\n`); code = 1; continue; }
    const onErr = (dd, e) => { ctx.err(`find: ‘${dd}’: ${e.message}\n`); code = 1; };
    for (const e of walk(ctx.fs, p, ctx.p(p), 0, onErr)) {
      if (e.depth > maxd || e.depth < mind) continue;
      if (tests.every(t => t(e))) hits.push(e);
    }
  }
  const sel = maxd === Infinity ? hits : hits;
  for (const e of del ? [...sel].reverse() : sel) {
    if (print) ctx.out(e.disp + '\n');
    if (exec) { if (ctx.sh.execArgv(exec.map(x => x.split('{}').join(e.disp)), { ...ctx.io, stdin: null })) code = 1; }
    if (del) { try { ctx.fs.remove(e.path); } catch (er) { ctx.err(`find: cannot delete ‘${e.disp}’: ${er.message}\n`); code = 1; } }
  }
  return code;
};

commands.which = ctx => {
  for (const n of ctx.args) {
    if (commands[n] && !BUILTINS.has(n)) ctx.out(`/usr/bin/${n}\n`); else ctx.fail = 1;
  }
};

commands.type = ctx => {
  for (const n of ctx.args) {
    if (Object.hasOwn(ctx.sh.aliases, n)) ctx.out(`${n} is aliased to \`${ctx.sh.aliases[n]}'\n`);
    else if (Object.hasOwn(ctx.sh.funcs ?? {}, n)) ctx.out(`${n} is a function\n`);
    else if (BUILTINS.has(n)) ctx.out(`${n} is a shell builtin\n`);
    else if (commands[n]) ctx.out(`${n} is /usr/bin/${n}\n`);
    else { ctx.err(`bash: type: ${n}: not found\n`); ctx.fail = 1; }
  }
};

// ---------- permissions ----------

commands.chmod = ctx => {
  const a = ctx.args.filter(x => !/^-[Rvf]+$/.test(x));
  const rec = ctx.args.some(x => /^-[vf]*R/.test(x));
  if (a.length < 2) throw new Usage(a.length ? `missing operand after '${a[0]}'` : 'missing operand');
  const spec = a.shift();
  let apply;
  if (/^[0-7]{1,4}$/.test(spec)) apply = () => parseInt(spec, 8);
  else {
    const clauses = spec.split(',').map(c => /^([ugoa]*)([+\-=])([rwxX]*)$/.exec(c));
    if (clauses.some(c => !c)) { ctx.err(`chmod: invalid mode: '${spec}'\n`); return 1; }
    apply = n => {
      let m = n.m;
      for (const [, who, op, perms] of clauses) {
        let bits = 0;
        for (const p of perms) bits |= p === 'r' ? 4 : p === 'w' ? 2 : p === 'x' || n.t === 'd' || (n.m & 0o111) ? 1 : 0;
        let mask = 0, all = 0;
        for (const w of who || 'a') {
          for (const sh of w === 'u' ? [6] : w === 'g' ? [3] : w === 'o' ? [0] : [6, 3, 0]) { mask |= bits << sh; all |= 7 << sh; }
        }
        m = op === '+' ? m | mask : op === '-' ? m & ~mask : (m & ~all) | mask;
      }
      return m;
    };
  }
  for (const f of a) {
    try {
      const root = ctx.fs.lookup(ctx.p(f));
      const nodes = rec ? [...walk(ctx.fs, f, ctx.p(f))].map(e => e.node) : [root];
      for (const n of nodes) {
        if (ctx.fs.user !== 'root' && n.o !== ctx.fs.user) { ctx.err(`chmod: changing permissions of '${f}': Operation not permitted\n`); ctx.fail = 1; break; }
        n.m = apply(n);
      }
    } catch (e) { ctx.err(`chmod: cannot access '${f}': ${e.message}\n`); ctx.fail = 1; }
  }
};

commands.chown = ctx => {
  const a = ctx.args.filter(x => !/^-[Rvf]+$/.test(x));
  const rec = ctx.args.some(x => /^-[vf]*R/.test(x));
  if (a.length < 2) throw new Usage('missing operand');
  const [user, group] = a.shift().split(':');
  for (const f of a) {
    try {
      ctx.fs.lookup(ctx.p(f));
      if (ctx.fs.user !== 'root') { ctx.err(`chown: changing ownership of '${f}': Operation not permitted\n`); ctx.fail = 1; continue; }
      for (const e of rec ? walk(ctx.fs, f, ctx.p(f)) : [{ node: ctx.fs.lookup(ctx.p(f)) }]) {
        if (user) e.node.o = user;
        if (group) e.node.g = group;
      }
    } catch (e) { ctx.err(`chown: cannot access '${f}': ${e.message}\n`); ctx.fail = 1; }
  }
};

commands.sudo = ctx => {
  const a = ctx.args.filter((x, i) => !(i === 0 && /^-[EHn]+$/.test(x)));
  if (!a.length) { ctx.err('usage: sudo command\n'); return 1; }
  if (['su', '-i', '-s', 'bash', 'sh'].includes(a[0]) && a.length <= 2) {
    ctx.err('sudo: eine Root-Shell ist in der Simulation gesperrt - nutze "sudo <befehl>"\n');
    return 1;
  }
  const sh = ctx.sh;
  if (!sh.flags.lectured) {
    sh.flags.lectured = true;
    ctx.err('We trust you have received the usual lecture from the local System\nAdministrator. It usually boils down to these three things:\n\n    #1) Respect the privacy of others.\n    #2) Think before you type.\n    #3) With great power comes great responsibility.\n\n');
  }
  const prev = ctx.fs.user;
  ctx.fs.user = 'root';
  try { return sh.execArgv(a, ctx.io); } finally { ctx.fs.user = prev; }
};
commands.su = ctx => { ctx.err('su: Authentication failure\n'); return 1; };
commands.passwd = ctx => { ctx.err('passwd: Authentication token manipulation error\npasswd: password unchanged\n'); return 10; };

// ---------- system ----------

commands.whoami = ctx => { ctx.out(ctx.fs.user + '\n'); };
commands.id = ctx => {
  ctx.out(ctx.fs.user === 'root' ? 'uid=0(root) gid=0(root) groups=0(root)\n' : 'uid=1000(hacker) gid=1000(hacker) groups=1000(hacker),27(sudo)\n');
};
commands.groups = ctx => { ctx.out(ctx.fs.user === 'root' ? 'root\n' : 'hacker sudo\n'); };
commands.hostname = ctx => { ctx.out('box\n'); };
commands.uname = ctx => {
  const { o } = opts(ctx, 'asnrvmo');
  const parts = { s: 'Linux', n: 'box', r: '6.8.0-hackterm', v: '#1 SMP PREEMPT_DYNAMIC', m: 'x86_64', o: 'GNU/Linux' };
  const keys = o.a ? 'snrvmo' : Object.keys(o).length ? 'snrvmo'.split('').filter(k => o[k]).join('') : 's';
  ctx.out([...keys].map(k => parts[k]).join(' ') + '\n');
};

commands.date = ctx => {
  const d = new Date();
  const tz = tzAbbr(d);
  const fmtArg = ctx.args.find(a => a[0] === '+');
  if (!fmtArg) {
    ctx.out(`${DAY[d.getDay()]} ${MON[d.getMonth()]} ${pad(d.getDate(), 2, ' ')} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${tz} ${d.getFullYear()}\n`);
    return;
  }
  const map = {
    Y: d.getFullYear(), m: pad(d.getMonth() + 1), d: pad(d.getDate()), H: pad(d.getHours()), M: pad(d.getMinutes()),
    S: pad(d.getSeconds()), s: Math.floor(d / 1000), a: DAY[d.getDay()], b: MON[d.getMonth()], y: pad(d.getFullYear() % 100),
    Z: tz, u: d.getDay() || 7, n: '\n', '%': '%',
  };
  map.F = `${map.Y}-${map.m}-${map.d}`;
  map.T = `${map.H}:${map.M}:${map.S}`;
  map.R = `${map.H}:${map.M}`;
  map.A = d.toLocaleDateString('en-US', { weekday: 'long' });
  map.B = d.toLocaleDateString('en-US', { month: 'long' });
  ctx.out(fmtArg.slice(1).replace(/%(.)/g, (m, c) => map[c] ?? m) + '\n');
};

commands.cal = ctx => {
  const d = new Date();
  const y = d.getFullYear(), m = d.getMonth();
  const title = `${d.toLocaleDateString('en-US', { month: 'long' })} ${y}`;
  ctx.out(' '.repeat(Math.max(0, Math.floor((20 - title.length) / 2))) + title + '\nSu Mo Tu We Th Fr Sa\n');
  let line = '   '.repeat(new Date(y, m, 1).getDay());
  const days = new Date(y, m + 1, 0).getDate();
  for (let i = 1; i <= days; i++) {
    const cell = pad(i, 2, ' ');
    line += (i === d.getDate() && ctx.tty ? E + '7m' + cell + C.r : cell) + ' ';
    if (new Date(y, m, i).getDay() === 6 || i === days) { ctx.out(line.trimEnd() + '\n'); line = ''; }
  }
};

commands.uptime = ctx => {
  const d = new Date();
  ctx.out(` ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} up 3 days,  2:14,  1 user,  load average: 0.97, 0.99, 1.02\n`);
};

commands.free = ctx => {
  const { o } = opts(ctx, 'hmg');
  const v = o.h ? ['7.7Gi', '1.6Gi', '4.9Gi', '12Mi', '1.2Gi', '6.1Gi', '2.0Gi', '0B', '2.0Gi']
    : ['8048576', '1699840', '5120000', '12288', '1228736', '6400000', '2097148', '0', '2097148'];
  ctx.out('               total        used        free      shared  buff/cache   available\n');
  ctx.out('Mem:    ' + v.slice(0, 6).map(x => x.padStart(12)).join('') + '\n');
  ctx.out('Swap:   ' + v.slice(6).map(x => x.padStart(12)).join('') + '\n');
};

commands.df = ctx => {
  const { o } = opts(ctx, 'hT');
  const used = Math.ceil(ctx.fs.usage() / 1024) + 4200000;
  const rows = [
    ['/dev/sda1', 20511312, used, '/'],
    ['tmpfs', 804856, 1200, '/run'],
    ['tmpfs', 4024284, 0, '/dev/shm'],
  ];
  const f = n => (o.h ? human(n * 1024) : String(n));
  ctx.out(`Filesystem     ${o.h ? ' Size  Used Avail' : '1K-blocks    Used Available'} Use% Mounted on\n`);
  for (const [dev, size, u, mnt] of rows) {
    const w = o.h ? 5 : 9;
    ctx.out(`${dev.padEnd(14)} ${f(size).padStart(w)} ${f(u).padStart(o.h ? 5 : 7)} ${f(size - u).padStart(o.h ? 5 : 9)} ${String(Math.ceil((u / size) * 100)).padStart(3)}% ${mnt}\n`);
  }
};

commands.du = ctx => {
  const { o, rest } = opts(ctx, 'shac', 'd', { '--max-depth': 'd' });
  const fs = ctx.fs;
  const maxd = o.s ? 0 : o.d !== undefined ? parseInt(o.d) : Infinity;
  const show = (kb, name) => ctx.out(`${o.h ? human(kb * 1024) : kb}\t${name}\n`);
  let grand = 0;
  const rec = (path, disp, depth) => {
    const n = fs.tryLookup(path, false);
    if (!n) return 0;
    if (n.t !== 'd') {
      const kb = n.t === 'l' ? 0 : Math.max(Math.ceil(fs.size(n) / 4096) * 4, n.d ? 4 : 0);
      if ((o.a && depth <= maxd) || depth === 0) show(kb, disp);
      return kb;
    }
    let sum = 4;
    let names = [];
    try { names = fs.readdir(path); } catch (e) { ctx.err(`du: cannot read directory '${disp}': ${e.message}\n`); ctx.fail = 1; }
    for (const c of names) sum += rec(joinPath(path, c), joinPath(disp, c), depth + 1);
    if (depth <= maxd) show(sum, disp);
    return sum;
  };
  for (const t of rest.length ? rest : ['.']) {
    if (!fs.tryLookup(ctx.p(t), false)) { ctx.err(`du: cannot access '${t}': No such file or directory\n`); ctx.fail = 1; continue; }
    grand += rec(ctx.p(t), t, 0);
  }
  if (o.c) show(grand, 'total');
};

// ---------- processes ----------

commands.ps = ctx => {
  const flags = ctx.args.join('').replace(/-/g, '');
  const all = /[aexA]/.test(flags);
  const self = { pid: ctx.sh.nextPid++, user: 'hacker', cpu: 0, mem: 0.1, tty: 'pts/0', time: '0:00', cmd: 'ps ' + ctx.args.join(' ') };
  const procs = [...ctx.sh.procs, self].filter(p => all || p.tty === 'pts/0');
  if (flags.includes('u')) {
    ctx.out('USER         PID %CPU %MEM    VSZ   RSS TTY      STAT START   TIME COMMAND\n');
    for (const p of procs) {
      ctx.out(`${p.user.padEnd(8)} ${pad(p.pid, 7, ' ')} ${p.cpu.toFixed(1).padStart(4)} ${p.mem.toFixed(1).padStart(4)} ${pad(Math.round(4000 + p.mem * 21000), 6, ' ')} ${pad(Math.round(900 + p.mem * 8000), 5, ' ')} ${p.tty.padEnd(8)} ${p.cpu > 50 ? 'R' : 'S'}    08:13 ${p.time.padStart(6)} ${p.cmd.trim()}\n`);
    }
  } else if (flags.includes('f')) {
    ctx.out('UID          PID    PPID  C STIME TTY          TIME CMD\n');
    for (const p of procs) ctx.out(`${p.user.padEnd(8)} ${pad(p.pid, 7, ' ')} ${pad(p.pid === 1 ? 0 : p.pid > 2048 ? 2048 : 1, 7, ' ')} ${pad(Math.round(p.cpu), 2, ' ')} 08:13 ${p.tty.padEnd(8)} 00:${pad(p.time.replace(/.*:/, ''))}:00 ${p.cmd.trim()}\n`);
  } else {
    ctx.out('    PID TTY          TIME CMD\n');
    for (const p of procs) ctx.out(`${pad(p.pid, 7, ' ')} ${p.tty.padEnd(8)} 00:00:${pad(p.time.replace(/.*:/, ''))} ${p.cmd.replace(/^-/, '').split(' ')[0]}\n`);
  }
};

commands.top = commands.htop = ctx => {
  const procs = [...ctx.sh.procs].sort((a, b) => b.cpu - a.cpu);
  const load = procs.some(p => p.pid === 1337) ? '0.97, 0.99, 1.02' : '0.02, 0.11, 0.42';
  ctx.out(`top - up 3 days,  1 user,  load average: ${load}\nTasks: ${procs.length} total,   1 running\n\n`);
  ctx.out((ctx.tty ? E + '7m' : '') + '    PID USER      %CPU  %MEM     TIME+ COMMAND' + (ctx.tty ? C.r : '') + '\n');
  for (const p of procs) ctx.out(`${pad(p.pid, 7, ' ')} ${p.user.padEnd(8)} ${p.cpu.toFixed(1).padStart(5)} ${p.mem.toFixed(1).padStart(5)} ${p.time.padStart(9)} ${p.cmd.trim()}\n`);
};

function killPid(ctx, pid) {
  const sh = ctx.sh;
  const idx = sh.procs.findIndex(p => p.pid === pid);
  if (idx < 0) { ctx.err(`bash: kill: (${pid}) - No such process\n`); return false; }
  const p = sh.procs[idx];
  if (pid === 1 || (p.user !== ctx.fs.user && ctx.fs.user !== 'root')) { ctx.err(`bash: kill: (${pid}) - Operation not permitted\n`); return false; }
  if (pid === 2048) return true;
  sh.procs.splice(idx, 1);
  return true;
}
commands.kill = ctx => {
  if (ctx.args[0] === '-l') { ctx.out(' 1) SIGHUP\t 2) SIGINT\t 3) SIGQUIT\t 9) SIGKILL\t15) SIGTERM\n'); return 0; }
  const a = ctx.args.filter((x, i) => !(x.startsWith('-') || ctx.args[i - 1] === '-s'));
  if (!a.length) { ctx.err('kill: usage: kill [-s sigspec | -n signum | -sigspec] pid\n'); return 2; }
  for (const x of a) {
    if (!/^\d+$/.test(x)) { ctx.err(`bash: kill: ${x}: arguments must be process or job IDs\n`); ctx.fail = 1; continue; }
    if (!killPid(ctx, +x)) ctx.fail = 1;
  }
};
commands.killall = commands.pkill = ctx => {
  const a = ctx.args.filter(x => !x.startsWith('-'));
  if (!a.length) throw new Usage('no process name specified');
  for (const name of a) {
    const hits = ctx.sh.procs.filter(p => (ctx.name === 'pkill' ? p.cmd.includes(name) : p.cmd.replace(/^[-./]*/, '').split(/[ :]/)[0].endsWith(name)));
    if (!hits.length) { if (ctx.name === 'killall') ctx.err(`${name}: no process found\n`); ctx.fail = 1; continue; }
    for (const p of hits) if (!killPid(ctx, p.pid)) ctx.fail = 1;
  }
};
commands.pgrep = ctx => {
  const name = ctx.args.find(x => !x.startsWith('-'));
  const hits = ctx.sh.procs.filter(p => name && p.cmd.includes(name));
  for (const p of hits) ctx.out(p.pid + '\n');
  return hits.length ? 0 : 1;
};
commands.sleep = () => 0;
commands.true = () => 0;
commands.false = () => 1;

// ---------- network (simulated) ----------

commands.ping = ctx => {
  const { o, rest } = opts(ctx, '46q', 'ciW');
  const host = rest[0];
  if (!host) throw new Usage('usage error: Destination address required');
  const ip = HOSTS[host];
  if (!ip) { ctx.err(`ping: ${host}: Name or service not known\n`); return 2; }
  const n = Math.min(parseInt(o.c ?? '4') || 4, 20);
  const base = ip.startsWith('127.') ? 0.04 : ip.startsWith('10.') ? 0.6 : 14;
  ctx.out(`PING ${host} (${ip}) 56(84) bytes of data.\n`);
  const times = [];
  for (let i = 1; i <= n; i++) {
    const t = base + Math.random() * base * 0.4;
    times.push(t);
    ctx.out(`64 bytes from ${ip}: icmp_seq=${i} ttl=${ip.startsWith('127.') ? 64 : 57} time=${t.toFixed(t < 1 ? 3 : 1)} ms\n`);
  }
  const avg = times.reduce((a, b) => a + b, 0) / n;
  ctx.out(`\n--- ${host} ping statistics ---\n${n} packets transmitted, ${n} received, 0% packet loss, time ${(n - 1) * 1001}ms\n`);
  ctx.out(`rtt min/avg/max/mdev = ${Math.min(...times).toFixed(3)}/${avg.toFixed(3)}/${Math.max(...times).toFixed(3)}/0.042 ms\n`);
};

const siteOf = url => url.replace(/^https?:\/\//, '').replace(/[/:].*$/, '');
commands.curl = ctx => {
  const { o, rest } = opts(ctx, 'sILOkv', 'o', { '--head': 'I', '--silent': 's', '--output': 'o' });
  const url = rest[0];
  if (!url) { ctx.err("curl: try 'curl --help' for more information\n"); return 2; }
  const host = siteOf(url);
  const body = SITES[host];
  if (body === undefined) {
    ctx.err(HOSTS[host] ? `curl: (7) Failed to connect to ${host} port 80: Connection refused\n` : `curl: (6) Could not resolve host: ${host}\n`);
    return HOSTS[host] ? 7 : 6;
  }
  if (o.I) { ctx.out(`HTTP/1.1 200 OK\nServer: nginx/1.24.0\nContent-Type: text/html; charset=UTF-8\nContent-Length: ${body.length}\nConnection: keep-alive\n\n`); return 0; }
  const file = o.o ?? (o.O ? (url.replace(/\/+$/, '').split('/').pop() === host ? 'index.html' : url.split('/').pop()) : null);
  if (file) { ctx.fs.writeFile(ctx.p(file), body); return 0; }
  ctx.out(body);
};
commands.wget = ctx => {
  const { o, rest } = opts(ctx, 'q', 'O');
  const url = rest[0];
  if (!url) { ctx.err('wget: missing URL\n'); return 1; }
  const host = siteOf(url);
  const body = SITES[host];
  if (body === undefined) { ctx.err(`wget: unable to resolve host address ‘${host}’\n`); return 4; }
  const file = o.O ?? 'index.html';
  ctx.fs.writeFile(ctx.p(file), body);
  if (!o.q) ctx.err(`Resolving ${host}... ${HOSTS[host] ?? '127.0.0.1'}\nConnecting to ${host}:80... connected.\nHTTP request sent, awaiting response... 200 OK\nLength: ${body.length} [text/html]\nSaving to: ‘${file}’\n\n${file}        100%[===================>]     ${body.length}  --.-KB/s    in 0s\n\n`);
};
commands.ifconfig = ctx => {
  ctx.out('eth0: flags=4163<UP,BROADCAST,RUNNING,MULTICAST>  mtu 1500\n        inet 192.168.1.10  netmask 255.255.255.0  broadcast 192.168.1.255\n        ether 02:42:ac:11:00:02  txqueuelen 0  (Ethernet)\n\nlo: flags=73<UP,LOOPBACK,RUNNING>  mtu 65536\n        inet 127.0.0.1  netmask 255.0.0.0\n');
};
commands.ip = ctx => {
  const a = ctx.args[0] ?? '';
  if (/^a/.test(a)) ctx.out('1: lo: <LOOPBACK,UP,LOWER_UP> mtu 65536 state UNKNOWN\n    inet 127.0.0.1/8 scope host lo\n2: eth0: <BROADCAST,MULTICAST,UP,LOWER_UP> mtu 1500 state UP\n    link/ether 02:42:ac:11:00:02 brd ff:ff:ff:ff:ff:ff\n    inet 192.168.1.10/24 brd 192.168.1.255 scope global eth0\n');
  else if (/^r/.test(a)) ctx.out('default via 192.168.1.1 dev eth0\n192.168.1.0/24 dev eth0 proto kernel scope link src 192.168.1.10\n');
  else { ctx.err('Usage: ip [ OPTIONS ] OBJECT { COMMAND | help }\nwhere  OBJECT := { address | route }\n'); return 255; }
};
commands.ssh = ctx => {
  const t = ctx.args.find(x => !x.startsWith('-'));
  if (!t) { ctx.err('usage: ssh [user@]hostname\n'); return 255; }
  const host = t.split('@').pop();
  ctx.err(HOSTS[host] ? `ssh: connect to host ${host} port 22: Connection refused\n` : `ssh: Could not resolve hostname ${host}: Name or service not known\n`);
  return 255;
};
commands.apt = commands['apt-get'] = ctx => {
  if (ctx.fs.user !== 'root') { ctx.err('E: Could not open lock file /var/lib/dpkg/lock-frontend - open (13: Permission denied)\nE: Unable to acquire the dpkg frontend lock, are you root?\n'); return 100; }
  ctx.out('Reading package lists... Done\nBuilding dependency tree... Done\nAll packages are up to date. (Simulation: kein echtes Netzwerk)\n');
};

// ---------- shell builtins ----------

commands.env = commands.printenv = ctx => {
  const sh = ctx.sh;
  if (ctx.name === 'printenv' && ctx.args.length) {
    for (const k of ctx.args) { if (sh.exported.has(k) && k in sh.env) ctx.out(sh.env[k] + '\n'); else ctx.fail = 1; }
    return;
  }
  for (const k of Object.keys(sh.env)) if (sh.exported.has(k)) ctx.out(`${k}=${k === 'PWD' ? sh.cwd : sh.env[k]}\n`);
};
commands.export = ctx => {
  const sh = ctx.sh;
  const a = ctx.args.filter(x => x !== '-p');
  if (!a.length) { for (const k of [...sh.exported].sort()) if (k in sh.env) ctx.out(`declare -x ${k}="${sh.env[k]}"\n`); return; }
  for (const x of a) {
    const eq = x.indexOf('=');
    const k = eq < 0 ? x : x.slice(0, eq);
    if (!/^[A-Za-z_]\w*$/.test(k)) { ctx.err(`bash: export: \`${x}': not a valid identifier\n`); ctx.fail = 1; continue; }
    if (eq >= 0) sh.env[k] = x.slice(eq + 1);
    sh.exported.add(k);
  }
};
commands.unset = ctx => { for (const k of ctx.args) { delete ctx.sh.env[k]; ctx.sh.exported.delete(k); } };
commands.alias = ctx => {
  const sh = ctx.sh;
  if (!ctx.args.length) { for (const k of Object.keys(sh.aliases).sort()) ctx.out(`alias ${k}='${sh.aliases[k]}'\n`); return; }
  for (const x of ctx.args) {
    const eq = x.indexOf('=');
    if (eq > 0) sh.aliases[x.slice(0, eq)] = x.slice(eq + 1);
    else if (Object.hasOwn(sh.aliases, x)) ctx.out(`alias ${x}='${sh.aliases[x]}'\n`);
    else { ctx.err(`bash: alias: ${x}: not found\n`); ctx.fail = 1; }
  }
};
commands.unalias = ctx => {
  for (const k of ctx.args) {
    if (Object.hasOwn(ctx.sh.aliases, k)) delete ctx.sh.aliases[k];
    else { ctx.err(`bash: unalias: ${k}: not found\n`); ctx.fail = 1; }
  }
};
commands.history = ctx => {
  if (ctx.args[0] === '-c') { ctx.sh.history = []; return; }
  const h = ctx.sh.history;
  const n = /^\d+$/.test(ctx.args[0] ?? '') ? +ctx.args[0] : h.length;
  h.slice(-n).forEach((l, i) => ctx.out(`${pad(h.length - Math.min(n, h.length) + i + 1, 5, ' ')}  ${l}\n`));
};
commands.clear = ctx => { ctx.sh.write('', 'clear'); };
commands.exit = commands.logout = ctx => {
  if (ctx.sh.depth > 0) { ctx.sh.exiting = true; return parseInt(ctx.args[0] ?? ctx.sh.lastCode) || 0; }
  ctx.out('logout\n');
  ctx.err('Es gibt kein Entkommen aus HackTerm. ;)\n');
};

function runFile(ctx, f, args) {
  let text;
  try { text = ctx.fs.readFile(ctx.p(f)); } catch (e) { ctx.err(`bash: ${f}: ${e.message}\n`); return 127; }
  return ctx.sh.runScript(text, [f, ...args], ctx.io);
}
commands.bash = commands.sh = ctx => {
  if (ctx.args[0] === '-c' && ctx.args[1] !== undefined) return ctx.sh.runScript(ctx.args[1], ['bash', ...ctx.args.slice(2)], ctx.io);
  const f = ctx.args.find(a => !a.startsWith('-'));
  if (!f) { ctx.err('bash: verschachtelte Shells gibt es in der Simulation nicht - nutze "bash script.sh"\n'); return 1; }
  return runFile(ctx, f, ctx.args.slice(ctx.args.indexOf(f) + 1));
};
commands.source = commands['.'] = ctx => {
  if (!ctx.args.length) { ctx.err('bash: source: filename argument required\n'); return 2; }
  return runFile(ctx, ctx.args[0], ctx.args.slice(1));
};

commands.test = commands['['] = ctx => {
  const a = [...ctx.args];
  if (ctx.name === '[') { if (a.pop() !== ']') { ctx.err("bash: [: missing `]'\n"); return 2; } }
  const st = f => ctx.fs.tryLookup(ctx.p(f));
  const prim = () => {
    if (a[0] === '!') { a.shift(); return !prim(); }
    if (a.length >= 3 && /^(=|==|!=|-eq|-ne|-lt|-le|-gt|-ge)$/.test(a[1])) {
      const [l, op, r] = a.splice(0, 3);
      switch (op) {
        case '=': case '==': return l === r;
        case '!=': return l !== r;
        case '-eq': return +l === +r;
        case '-ne': return +l !== +r;
        case '-lt': return +l < +r;
        case '-le': return +l <= +r;
        case '-gt': return +l > +r;
        default: return +l >= +r;
      }
    }
    if (a.length >= 2 && /^-[efdzrwxnsL]$/.test(a[0])) {
      const [op, v] = a.splice(0, 2);
      const n = 'zn'.includes(op[1]) ? null : st(v);
      switch (op[1]) {
        case 'e': return !!n;
        case 'f': return !!n && n.t === 'f';
        case 'd': return !!n && n.t === 'd';
        case 'L': return ctx.fs.tryLookup(ctx.p(v), false)?.t === 'l';
        case 's': return !!n && ctx.fs.size(n) > 0;
        case 'r': case 'w': case 'x': return !!n && ctx.fs.can(n, op[1]);
        case 'z': return v === '';
        default: return v !== '';
      }
    }
    return (a.shift() ?? '') !== '';
  };
  let res = prim();
  while (a.length) {
    const op = a.shift();
    if (op === '-a') res = prim() && res;
    else if (op === '-o') res = prim() || res;
    else { ctx.err(`bash: ${ctx.name}: too many arguments\n`); return 2; }
  }
  return res ? 0 : 1;
};

// ---------- help ----------

commands.man = ctx => {
  const n = ctx.args.find(a => !a.startsWith('-'));
  if (!n) { ctx.err('What manual page do you want?\nFor example, try \'man man\'.\n'); return 1; }
  const m = MAN[n];
  if (!m) { ctx.err(`No manual entry for ${n}\n`); return 16; }
  const B = ctx.tty ? C.b : '', R = ctx.tty ? C.r : '';
  let s = `${B}NAME${R}\n    ${n} - ${m[1]}\n\n${B}SYNOPSIS${R}\n    ${m[0]}\n`;
  if (m[2].length) s += `\n${B}BEISPIELE${R}\n` + m[2].map(x => `    ${ctx.tty ? C.green : ''}$ ${x}${R}`).join('\n') + '\n';
  ctx.out(s);
};
commands.whatis = ctx => {
  for (const n of ctx.args) {
    if (MAN[n]) ctx.out(`${n} (1) - ${MAN[n][1]}\n`); else { ctx.err(`${n}: nothing appropriate.\n`); ctx.fail = 1; }
  }
};
commands.apropos = ctx => {
  const q = (ctx.args[0] ?? '').toLowerCase();
  const hits = Object.entries(MAN).filter(([n, m]) => n.includes(q) || m[1].toLowerCase().includes(q));
  for (const [n, m] of hits) ctx.out(`${n} (1) - ${m[1]}\n`);
  return hits.length ? 0 : 1;
};
commands.help = ctx => {
  const cats = {};
  for (const [n, m] of Object.entries(MAN)) (cats[m[3]] ??= []).push(n);
  const B = ctx.tty ? C.bcyan : '', R = ctx.tty ? C.r : '';
  let s = `${B}HackTerm - Befehlsuebersicht${R}\n`;
  for (const [cat, names] of Object.entries(cats)) s += `\n${B}${cat}${R}\n  ${names.join('  ')}\n`;
  s += `\nDetails: ${ctx.tty ? C.green : ''}man <befehl>${R}   Operatoren: | > >> < && || ; $VAR $(cmd) * ? {a,b}\n`;
  ctx.out(s);
};

// ---------- fun / UI ----------

commands.theme = ctx => {
  const names = ['green', 'amber', 'cyan', 'red', 'mono'];
  if (!names.includes(ctx.args[0])) { ctx.out(`usage: theme [${names.join('|')}]\n`); return ctx.args.length ? 1 : 0; }
  ctx.sh.request = { type: 'theme', name: ctx.args[0] };
};
commands.cmatrix = ctx => { ctx.sh.request = { type: 'matrix' }; };
commands.reboot = commands.shutdown = commands.poweroff = ctx => {
  if (ctx.fs.user !== 'root') { ctx.err(`${ctx.name}: must be superuser.\n`); return 1; }
  ctx.sh.request = { type: 'reboot' };
};
commands.neofetch = ctx => {
  const g = ctx.tty ? C.bgreen : '', r = ctx.tty ? C.r : '';
  const art = ['   ┌──────────┐ ', '   │ >_       │ ', '   │          │ ', '   │  HACK    │ ', '   │  TERM    │ ', '   └──────────┘ ', '                '];
  const info = [`${g}${ctx.fs.user}@box${r}`, '-----------', `${g}OS${r}: HackTerm Linux 1.0 (Nightfall)`, `${g}Kernel${r}: 6.8.0-hackterm`, `${g}Shell${r}: bash 5.2.21`, `${g}CPU${r}: HackTerm Virtual CPU (4)`, `${g}Memory${r}: 1660MiB / 7860MiB`];
  ctx.out(art.map((a, i) => g + a + r + (info[i] ?? '')).join('\n') + '\n');
};
commands.cowsay = ctx => {
  const t = ctx.args.join(' ') || (ctx.stdin ?? '').trim() || 'Moo';
  ctx.out(` ${'_'.repeat(t.length + 2)}\n< ${t} >\n ${'-'.repeat(t.length + 2)}\n        \\   ^__^\n         \\  (oo)\\_______\n            (__)\\       )\\/\\\n                ||----w |\n                ||     ||\n`);
};
commands.fortune = ctx => {
  const f = ['There is no place like 127.0.0.1.', 'rm -rf / ist keine Loesung. Meistens.', 'Es ist immer DNS.', 'Wer Backups hat, braucht keinen Mut.', 'chmod 777 ist kein Sicherheitskonzept.', 'Lies die Logs. Immer.'];
  ctx.out(f[Math.floor(Math.random() * f.length)] + '\n');
};
