// Additional commands: text tools, hashing and hex dumps, compression, system info,
// services, cron and a simulated network toolbox. Registers into the shared command table.
import { normalize, baseName, now } from './vfs.js';
import {
  commands, BUILTINS, Usage, C, opts, lines, pad, MON, DAY, UID, readAll, modeStr, toRegex, joinPath, tzAbbr,
} from './commands.js';
import { MAN, HOSTS, SITES, initialProcs } from './world.js';

const enc = new TextEncoder();
const dec = new TextDecoder();
const bytesOf = s => enc.encode(s);
const MAX_LINES = 10000;

// Run `fn` with root rights (for system bookkeeping such as cron spool directories).
function asRoot(fs, fn) {
  const prev = fs.user;
  fs.user = 'root';
  try { return fn(); } finally { fs.user = prev; }
}

// Expand \t, \n and \\ in delimiter lists (paste -d, column -o).
const delimEsc = s => s.replace(/\\(t|n|\\|0)/g, (m, c) => ({ t: '\t', n: '\n', '\\': '\\', 0: '' }[c]));

// ====================================================================================
// text
// ====================================================================================

commands.yes = ctx => {
  const s = (ctx.args.length ? ctx.args.join(' ') : 'y') + '\n';
  // A real `yes` never stops; the simulator stops after MAX_LINES lines.
  ctx.out(s.repeat(ctx.tty ? 1000 : MAX_LINES));
};

commands.paste = ctx => {
  const { o, rest } = opts(ctx, 's', 'd', { '--serial': 's', '--delimiters': 'd' });
  const delims = [...delimEsc(o.d ?? '\t')];
  if (!delims.length) delims.push('');
  const files = readAll(ctx, rest).map(f => lines(f.text));
  const join = parts => parts.reduce((acc, p, i) => (i ? acc + delims[(i - 1) % delims.length] + p : p), '');
  if (o.s) for (const f of files) ctx.out(join(f) + '\n');
  else {
    const n = Math.max(0, ...files.map(f => f.length));
    for (let i = 0; i < n; i++) ctx.out(join(files.map(f => f[i] ?? '')) + '\n');
  }
};

commands.comm = ctx => {
  const { o, rest } = opts(ctx, '123');
  if (rest.length !== 2) throw new Usage(rest.length < 2 ? `missing operand after '${rest[0] ?? ''}'` : `extra operand '${rest[2]}'`);
  const [a, b] = readAll(ctx, rest).map(f => lines(f.text));
  if (!a || !b) return 1;
  const col = (n, s) => {
    if (o[n]) return;
    const indent = [1, 2].filter(k => k < n && !o[k]).length;
    ctx.out('\t'.repeat(indent) + s + '\n');
  };
  let i = 0, j = 0;
  while (i < a.length || j < b.length) {
    if (j >= b.length || (i < a.length && a[i] < b[j])) col(1, a[i++]);
    else if (i >= a.length || b[j] < a[i]) col(2, b[j++]);
    else { col(3, a[i]); i++; j++; }
  }
};

commands.column = ctx => {
  const { o, rest } = opts(ctx, 'tx', 'so', { '--table': 't', '--separator': 's', '--output-separator': 'o' });
  const text = readAll(ctx, rest).map(f => f.text).join('');
  const rows = lines(text).filter(l => l.trim());
  if (o.t) {
    const sep = o.s ? new RegExp('[' + o.s.replace(/[\]\\^-]/g, '\\$&') + ']+') : /\s+/;
    const cells = rows.map(r => (o.s ? r : r.trim()).split(sep));
    const w = [];
    for (const r of cells) r.forEach((c, i) => { w[i] = Math.max(w[i] ?? 0, [...c].length); });
    const out = delimEsc(o.o ?? '  ');
    for (const r of cells) ctx.out(r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(w[i]))).join(out) + '\n');
    return;
  }
  // Without -t: fill columns first, like ls, within the terminal width.
  if (!rows.length) return;
  const width = Math.max(...rows.map(r => r.length)) + 2;
  const ncol = Math.max(1, Math.floor((ctx.sh.cols || 80) / width));
  const nrow = Math.ceil(rows.length / ncol);
  for (let r = 0; r < nrow; r++) {
    let line = '';
    for (let c = 0; c < ncol; c++) {
      const k = o.x ? r * ncol + c : c * nrow + r;
      if (k < rows.length) line += rows[k].padEnd(width);
    }
    ctx.out(line.trimEnd() + '\n');
  }
};

commands.fold = ctx => {
  const { o, rest } = opts(ctx, 'sb', 'w', { '--spaces': 's', '--width': 'w' });
  const w = parseInt(o.w ?? '80');
  if (!(w > 0)) throw new Usage(`invalid number of columns: '${o.w}'`);
  for (const f of readAll(ctx, rest)) {
    for (const line of lines(f.text)) {
      let s = line;
      while (s.length > w) {
        let cut = w;
        if (o.s) { const sp = s.lastIndexOf(' ', w - 1); if (sp > 0) cut = sp + 1; }
        ctx.out(s.slice(0, cut) + '\n');
        s = s.slice(cut);
      }
      ctx.out(s + '\n');
    }
  }
};

commands.shuf = ctx => {
  const { o, rest } = opts(ctx, 'e', 'ni', { '--echo': 'e', '--head-count': 'n', '--input-range': 'i' });
  let items;
  if (o.e) items = rest;
  else if (o.i) {
    const m = /^(\d+)-(\d+)$/.exec(o.i);
    if (!m || +m[1] > +m[2]) { ctx.err(`shuf: invalid input range: '${o.i}'\n`); return 1; }
    if (+m[2] - +m[1] >= MAX_LINES) { ctx.err(`shuf: input range too large (max ${MAX_LINES})\n`); return 1; }
    items = [];
    for (let k = +m[1]; k <= +m[2]; k++) items.push(String(k));
  } else items = readAll(ctx, rest.slice(0, 1)).flatMap(f => lines(f.text));
  for (let k = items.length - 1; k > 0; k--) {
    const r = Math.floor(Math.random() * (k + 1));
    [items[k], items[r]] = [items[r], items[k]];
  }
  const n = o.n === undefined ? items.length : parseInt(o.n);
  if (!(n >= 0)) { ctx.err(`shuf: invalid line count: '${o.n}'\n`); return 1; }
  for (const it of items.slice(0, n)) ctx.out(it + '\n');
};

// expr: a small recursive-descent evaluator over the argument list.
class ExprErr extends Error {}
commands.expr = ctx => {
  const t = ctx.args;
  if (!t.length) { ctx.err("expr: missing operand\nTry 'expr --help' for more information.\n"); return 2; }
  let i = 0;
  const isInt = v => /^-?\d+$/.test(String(v));
  const int = v => { if (!isInt(v)) throw new ExprErr('non-integer argument'); return BigInt(v); };
  const peek = () => t[i];
  const prim = () => {
    const tok = t[i++];
    if (tok === undefined) throw new ExprErr(`syntax error: missing argument after '${t[i - 2] ?? ''}'`);
    if (tok === '(') { const v = or(); if (t[i++] !== ')') throw new ExprErr("syntax error: expecting ')'"); return v; }
    if (tok === 'length') return String([...String(prim())].length);
    if (tok === 'substr') {
      const s = String(prim()), p = Number(prim()), l = Number(prim());
      return p >= 1 && l >= 1 ? [...s].slice(p - 1, p - 1 + l).join('') : '';
    }
    if (tok === 'index') {
      const s = String(prim()), chars = String(prim());
      const k = [...s].findIndex(c => chars.includes(c));
      return String(k + 1);
    }
    if (tok === 'match') return match(prim(), prim());
    return tok;
  };
  const match = (s, re) => {
    const r = new RegExp('^(?:' + toRegex(String(re), { global: false }).source + ')');
    const m = r.exec(String(s));
    if (/\\\(/.test(String(re))) return m ? m[1] ?? '' : '';
    return String(m ? m[0].length : 0);
  };
  const colon = () => { let v = prim(); while (peek() === ':') { i++; v = match(v, prim()); } return v; };
  const mul = () => {
    let v = colon();
    while (['*', '/', '%'].includes(peek())) {
      const op = t[i++], r = colon();
      const a = int(v), b = int(r);
      if (op !== '*' && b === 0n) throw new ExprErr('division by zero');
      v = String(op === '*' ? a * b : op === '/' ? a / b : a % b);
    }
    return v;
  };
  const add = () => {
    let v = mul();
    while (['+', '-'].includes(peek())) { const op = t[i++], r = mul(); v = String(op === '+' ? int(v) + int(r) : int(v) - int(r)); }
    return v;
  };
  const cmp = () => {
    let v = add();
    while (['=', '==', '!=', '<', '<=', '>', '>='].includes(peek())) {
      const op = t[i++], r = add();
      const c = isInt(v) && isInt(r) ? (BigInt(v) < BigInt(r) ? -1 : BigInt(v) > BigInt(r) ? 1 : 0) : (v < r ? -1 : v > r ? 1 : 0);
      v = ({ '=': c === 0, '==': c === 0, '!=': c !== 0, '<': c < 0, '<=': c <= 0, '>': c > 0, '>=': c >= 0 }[op]) ? '1' : '0';
    }
    return v;
  };
  const isNull = v => v === '' || (isInt(v) && BigInt(v) === 0n);
  const and = () => {
    let v = cmp();
    while (peek() === '&') { i++; const r = cmp(); v = isNull(v) || isNull(r) ? '0' : v; }
    return v;
  };
  const or = () => {
    let v = and();
    while (peek() === '|') { i++; const r = and(); v = isNull(v) ? (isNull(r) ? '0' : r) : v; }
    return v;
  };
  let v;
  try {
    v = or();
    if (i < t.length) throw new ExprErr(`syntax error: unexpected argument '${t[i]}'`);
  } catch (e) {
    if (!(e instanceof ExprErr)) throw e;
    ctx.err(`expr: ${e.message}\n`);
    return 2;
  }
  ctx.out(v + '\n');
  return isNull(v) ? 1 : 0;
};

commands.factor = ctx => {
  const nums = ctx.args.length ? ctx.args : (ctx.stdin ?? '').split(/\s+/).filter(Boolean);
  for (const s of nums) {
    if (!/^\d+$/.test(s)) { ctx.err(`factor: '${s}' is not a valid positive integer\n`); ctx.fail = 1; continue; }
    let n = Number(s);
    if (!Number.isSafeInteger(n)) { ctx.err(`factor: '${s}' is too large for this simulator\n`); ctx.fail = 1; continue; }
    const f = [];
    for (let p = 2; p * p <= n; p += p === 2 ? 1 : 2) while (n % p === 0) { f.push(p); n /= p; }
    if (n > 1) f.push(n);
    ctx.out(`${s}:${f.map(x => ' ' + x).join('')}\n`);
  }
};

// ====================================================================================
// hashes and hex dumps (pure JS, synchronous)
// ====================================================================================

const rotl = (x, n) => ((x << n) | (x >>> (32 - n))) >>> 0;
const rotr = (x, n) => ((x >>> n) | (x << (32 - n))) >>> 0;
const hex32 = words => words.map(x => x.toString(16).padStart(8, '0')).join('');

function md5(bytes) {
  const K = Array.from({ length: 64 }, (_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0);
  const S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
  const len = bytes.length, n = ((len + 8) >>> 6) + 1, w = new Uint32Array(n * 16);
  for (let i = 0; i < len; i++) w[i >> 2] |= bytes[i] << ((i % 4) * 8);
  w[len >> 2] |= 0x80 << ((len % 4) * 8);
  w[n * 16 - 2] = (len * 8) >>> 0;
  w[n * 16 - 1] = Math.floor(len / 2 ** 29);
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  for (let j = 0; j < w.length; j += 16) {
    let A = a0, B = b0, Cc = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F, g;
      if (i < 16) { F = (B & Cc) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & Cc); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ Cc ^ D; g = (3 * i + 5) % 16; }
      else { F = Cc ^ (B | ~D); g = (7 * i) % 16; }
      F = (F + A + K[i] + w[j + g]) >>> 0;
      A = D; D = Cc; Cc = B;
      B = (B + rotl(F, S[(i >> 4) * 4 + (i % 4)])) >>> 0;
    }
    a0 = (a0 + A) >>> 0; b0 = (b0 + B) >>> 0; c0 = (c0 + Cc) >>> 0; d0 = (d0 + D) >>> 0;
  }
  // MD5 output is little-endian per word.
  return [a0, b0, c0, d0].map(x => [0, 8, 16, 24].map(s => ((x >>> s) & 255).toString(16).padStart(2, '0')).join('')).join('');
}

function blocksBE(bytes) {
  const len = bytes.length, n = ((len + 8) >>> 6) + 1, w = new Uint32Array(n * 16);
  for (let i = 0; i < len; i++) w[i >> 2] |= bytes[i] << (24 - (i % 4) * 8);
  w[len >> 2] |= 0x80 << (24 - (len % 4) * 8);
  w[n * 16 - 1] = (len * 8) >>> 0;
  w[n * 16 - 2] = Math.floor(len / 2 ** 29);
  return w;
}

function sha1(bytes) {
  const w = blocksBE(bytes), W = new Uint32Array(80);
  const h = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];
  for (let j = 0; j < w.length; j += 16) {
    for (let t = 0; t < 80; t++) W[t] = t < 16 ? w[j + t] : rotl(W[t - 3] ^ W[t - 8] ^ W[t - 14] ^ W[t - 16], 1);
    let [a, b, c, d, e] = h;
    for (let t = 0; t < 80; t++) {
      const f = t < 20 ? (b & c) | (~b & d) : t < 40 ? b ^ c ^ d : t < 60 ? (b & c) | (b & d) | (c & d) : b ^ c ^ d;
      const k = t < 20 ? 0x5a827999 : t < 40 ? 0x6ed9eba1 : t < 60 ? 0x8f1bbcdc : 0xca62c1d6;
      const tmp = (rotl(a, 5) + f + e + k + W[t]) >>> 0;
      e = d; d = c; c = rotl(b, 30); b = a; a = tmp;
    }
    [a, b, c, d, e].forEach((x, i) => { h[i] = (h[i] + x) >>> 0; });
  }
  return hex32(h);
}

const PRIMES = [];
for (let n = 2; PRIMES.length < 64; n++) if (PRIMES.every(p => n % p)) PRIMES.push(n);
const frac32 = x => ((x - Math.floor(x)) * 2 ** 32) >>> 0;
const K256 = PRIMES.map(p => frac32(Math.cbrt(p)));
const H256 = PRIMES.slice(0, 8).map(p => frac32(Math.sqrt(p)));

function sha256(bytes) {
  const w = blocksBE(bytes), W = new Uint32Array(64), h = [...H256];
  for (let j = 0; j < w.length; j += 16) {
    for (let t = 0; t < 64; t++) {
      if (t < 16) { W[t] = w[j + t]; continue; }
      const s0 = rotr(W[t - 15], 7) ^ rotr(W[t - 15], 18) ^ (W[t - 15] >>> 3);
      const s1 = rotr(W[t - 2], 17) ^ rotr(W[t - 2], 19) ^ (W[t - 2] >>> 10);
      W[t] = (W[t - 16] + s0 + W[t - 7] + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h;
    for (let t = 0; t < 64; t++) {
      const t1 = (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K256[t] + W[t]) >>> 0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      hh = g; g = f; f = e; e = (d + t1) >>> 0; d = c; c = b; b = a; a = (t1 + t2) >>> 0;
    }
    [a, b, c, d, e, f, g, hh].forEach((x, i) => { h[i] = (h[i] + x) >>> 0; });
  }
  return hex32(h);
}

export const HASHES = { md5sum: md5, sha1sum: sha1, sha256sum: sha256 };
for (const [name, fn] of Object.entries(HASHES)) {
  commands[name] = ctx => {
    const { o, rest } = opts(ctx, 'c', '', { '--check': 'c' });
    if (!o.c) {
      for (const f of readAll(ctx, rest)) ctx.out(`${fn(bytesOf(f.text))}  ${f.name}\n`);
      return;
    }
    let bad = 0;
    for (const list of readAll(ctx, rest)) {
      for (const line of lines(list.text)) {
        const m = /^([0-9a-fA-F]+) [ *](.+)$/.exec(line);
        if (!m) continue;
        let text;
        try { text = ctx.fs.readFile(ctx.p(m[2])); } catch (e) {
          ctx.err(`${name}: ${m[2]}: ${e.message}\n`); ctx.out(`${m[2]}: FAILED open or read\n`); bad++; continue;
        }
        const ok = fn(bytesOf(text)) === m[1].toLowerCase();
        if (!ok) bad++;
        ctx.out(`${m[2]}: ${ok ? 'OK' : 'FAILED'}\n`);
      }
    }
    if (bad) { ctx.err(`${name}: WARNING: ${bad} computed checksum${bad > 1 ? 's' : ''} did NOT match\n`); return 1; }
  };
}

const printable = b => (b >= 0x20 && b < 0x7f ? String.fromCharCode(b) : '.');
const hx = (b, n = 2) => b.toString(16).padStart(n, '0');

commands.xxd = ctx => {
  const { o, rest } = opts(ctx, 'pru', 'lc');
  const f = readAll(ctx, rest.slice(0, 1))[0];
  if (!f) return 2;
  if (o.r) {
    const hexText = o.p ? f.text : lines(f.text).map(l => l.replace(/^[0-9a-f]+:\s?/i, '').split('  ')[0]).join('');
    const digits = hexText.replace(/[^0-9a-fA-F]/g, '');
    const out = new Uint8Array(digits.length >> 1);
    for (let i = 0; i < out.length; i++) out[i] = parseInt(digits.slice(i * 2, i * 2 + 2), 16);
    ctx.out(dec.decode(out));
    return;
  }
  let bytes = bytesOf(f.text);
  if (o.l !== undefined) bytes = bytes.slice(0, Math.max(0, parseInt(o.l) || 0));
  const up = s => (o.u ? s.toUpperCase() : s);
  if (o.p) {
    const all = [...bytes].map(b => hx(b)).join('');
    for (let i = 0; i < all.length; i += 60) ctx.out(up(all.slice(i, i + 60)) + '\n');
    return;
  }
  const cols = Math.min(Math.max(parseInt(o.c ?? '16') || 16, 1), 64);
  for (let off = 0; off < bytes.length; off += cols) {
    const chunk = [...bytes.slice(off, off + cols)];
    let h = '';
    chunk.forEach((b, i) => { h += hx(b) + (i % 2 ? ' ' : ''); });
    const width = cols * 2 + Math.ceil(cols / 2);
    ctx.out(`${hx(off, 8)}: ${up(h).padEnd(width)} ${chunk.map(printable).join('')}\n`);
  }
};

commands.hexdump = ctx => {
  const { o, rest } = opts(ctx, 'C', 'n');
  const f = readAll(ctx, rest.slice(0, 1))[0];
  if (!f) return 1;
  let bytes = [...bytesOf(f.text)];
  if (o.n !== undefined) bytes = bytes.slice(0, Math.max(0, parseInt(o.n) || 0));
  for (let off = 0; off < bytes.length; off += 16) {
    const chunk = bytes.slice(off, off + 16);
    if (o.C) {
      let h = '';
      chunk.forEach((b, i) => { h += hx(b) + ' ' + (i === 7 ? ' ' : ''); });
      ctx.out(`${hx(off, 8)}  ${h.padEnd(49)} |${chunk.map(printable).join('')}|\n`);
    } else {
      const words = [];
      for (let i = 0; i < chunk.length; i += 2) words.push(hx((chunk[i + 1] ?? 0) << 8 | chunk[i], 4));
      ctx.out(`${hx(off, 7)} ${words.join(' ')}\n`);
    }
  }
  if (bytes.length) ctx.out(hx(bytes.length, o.C ? 8 : 7) + '\n');
};

// ====================================================================================
// compression (simulated container: gzip magic, original name, base64 payload)
// ====================================================================================

export const GZ_MAGIC = '\x1f\x8b\x08\x08';
const b64 = s => { let bin = ''; for (const b of bytesOf(s)) bin += String.fromCharCode(b); return btoa(bin); };
const unb64 = s => dec.decode(Uint8Array.from(atob(s), c => c.charCodeAt(0)));
export const gzPack = (name, text) => `${GZ_MAGIC}${name}\x00${b64(text)}`;
export function gzUnpack(data) {
  if (!data.startsWith(GZ_MAGIC)) return null;
  const z = data.indexOf('\x00', GZ_MAGIC.length);
  if (z < 0) return null;
  try { return { name: data.slice(GZ_MAGIC.length, z), text: unb64(data.slice(z + 1)) }; } catch { return null; }
}

function gzip(ctx, mode) {
  const { o, rest } = opts(ctx, 'dckfvl1239', '', {
    '--decompress': 'd', '--stdout': 'c', '--keep': 'k', '--force': 'f', '--verbose': 'v', '--list': 'l',
  });
  const name = ctx.name;
  const decompress = mode === 'd' || o.d;
  const toStdout = mode === 'c' || o.c;
  if (!rest.length) {
    if (!decompress && ctx.tty && !o.f) {
      ctx.err(`${name}: compressed data not written to a terminal. Use -f to force compression.\nFor help, type: ${name} -h\n`);
      return 1;
    }
    if (decompress) {
      const u = gzUnpack(ctx.stdin ?? '');
      if (!u) { ctx.err(`${name}: stdin: not in gzip format\n`); return 1; }
      ctx.out(u.text);
    } else ctx.out(gzPack('', ctx.stdin ?? ''));
    return;
  }
  for (const f of rest) {
    const p = ctx.p(f);
    let data;
    try { data = ctx.fs.readFile(p); } catch (e) { ctx.err(`${name}: ${f}: ${e.message}\n`); ctx.fail = 1; continue; }
    const node = ctx.fs.lookup(p);
    if (decompress || o.l) {
      const u = gzUnpack(data);
      if (!u) { ctx.err(`${name}: ${f}: not in gzip format\n`); ctx.fail = 1; continue; }
      if (o.l) {
        ctx.out(`         compressed        uncompressed  ratio uncompressed_name\n${String(data.length).padStart(19)} ${String(bytesOf(u.text).length).padStart(19)} ${'-'.padStart(5)} ${f.replace(/\.gz$/, '')}\n`);
        continue;
      }
      if (toStdout) { ctx.out(u.text); continue; }
      if (!/\.gz$/.test(f)) { ctx.err(`${name}: ${f}: unknown suffix -- ignored\n`); ctx.fail = 1; continue; }
      const target = p.replace(/\.gz$/, '');
      if (ctx.fs.tryLookup(target) && !o.f) { ctx.err(`${name}: ${f.replace(/\.gz$/, '')} already exists; not overwritten\n`); ctx.fail = 1; continue; }
      try {
        ctx.fs.writeFile(target, u.text);
        ctx.fs.lookup(target).m = node.m;
        if (!o.k) ctx.fs.remove(p);
      } catch (e) { ctx.err(`${name}: ${f}: ${e.message}\n`); ctx.fail = 1; continue; }
      if (o.v) ctx.out(`${f}:\t -- replaced with ${f.replace(/\.gz$/, '')}\n`);
    } else {
      if (node.t !== 'f') { ctx.err(`${name}: ${f} is a directory -- ignored\n`); ctx.fail = 1; continue; }
      if (/\.gz$/.test(f)) { ctx.err(`${name}: ${f} already has .gz suffix -- unchanged\n`); ctx.fail = 1; continue; }
      const packed = gzPack(baseName(p), data);
      if (toStdout) { ctx.out(packed); continue; }
      if (ctx.fs.tryLookup(p + '.gz') && !o.f) { ctx.err(`${name}: ${f}.gz already exists; not overwritten\n`); ctx.fail = 1; continue; }
      try {
        ctx.fs.writeFile(p + '.gz', packed);
        ctx.fs.lookup(p + '.gz').m = node.m;
        if (!o.k) ctx.fs.remove(p);
      } catch (e) { ctx.err(`${name}: ${f}: ${e.message}\n`); ctx.fail = 1; continue; }
      if (o.v) ctx.out(`${f}:\t -- replaced with ${f}.gz\n`);
    }
  }
}
commands.gzip = ctx => gzip(ctx, '');
commands.gunzip = ctx => gzip(ctx, 'd');
// zcat always decompresses to stdout.
commands.zcat = ctx => { ctx.args = ['-dc', ...ctx.args]; return gzip(ctx, ''); };

// ====================================================================================
// files
// ====================================================================================

const GROUPS = ['root', 'daemon', 'sudo', 'www-data', 'hacker'];
const MEMBER = { hacker: ['hacker', 'sudo'] };

commands.chgrp = ctx => {
  const { o, rest } = opts(ctx, 'Rv', '', { '--recursive': 'R' });
  if (rest.length < 2) throw new Usage(rest.length ? `missing operand after '${rest[0]}'` : 'missing operand');
  const [grp, ...files] = rest;
  if (!GROUPS.includes(grp)) { ctx.err(`chgrp: invalid group: '${grp}'\n`); return 1; }
  const user = ctx.fs.user;
  const apply = (n, disp) => {
    if (user !== 'root' && (n.o !== user || !(MEMBER[user] ?? []).includes(grp))) {
      ctx.err(`chgrp: changing group of '${disp}': Operation not permitted\n`); ctx.fail = 1; return;
    }
    n.g = grp;
    if (o.v) ctx.out(`changed group of '${disp}' to ${grp}\n`);
    if (o.R && n.t === 'd') for (const k of Object.keys(n.c)) apply(n.c[k], joinPath(disp, k));
  };
  for (const f of files) {
    const n = ctx.fs.tryLookup(ctx.p(f));
    if (!n) { ctx.err(`chgrp: cannot access '${f}': No such file or directory\n`); ctx.fail = 1; continue; }
    apply(n, f);
  }
};

commands.mktemp = ctx => {
  const { o, rest } = opts(ctx, 'du', 'p', { '--directory': 'd', '--dry-run': 'u', '--tmpdir': 'p' });
  const tpl = rest[0] ?? 'tmp.XXXXXXXXXX';
  const m = /X{3,}$/.exec(tpl);
  if (!m) { ctx.err(`mktemp: too few X's in template '${tpl}'\n`); return 1; }
  const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const dir = o.p ?? (rest[0] && rest[0].includes('/') ? '' : '/tmp');
  let path, tries = 0;
  do {
    const name = tpl.slice(0, m.index) + Array.from({ length: m[0].length }, () => abc[Math.floor(Math.random() * abc.length)]).join('');
    path = dir ? joinPath(dir, name) : name;
  } while (ctx.fs.tryLookup(ctx.p(path)) && ++tries < 50);
  if (!o.u) {
    try {
      if (o.d) ctx.fs.mkdir(ctx.p(path)); else ctx.fs.writeFile(ctx.p(path), '');
      ctx.fs.lookup(ctx.p(path)).m = o.d ? 0o700 : 0o600;
    } catch (e) { ctx.err(`mktemp: failed to create ${o.d ? 'directory' : 'file'} via template '${path}': ${e.message}\n`); return 1; }
  }
  ctx.out(path + '\n');
};

// stat -c FORMAT / --format=FORMAT / --printf=FORMAT; everything else goes to the original stat.
const statPlain = commands.stat;
commands.stat = ctx => {
  const a = ctx.args;
  let fmt = null, printf = false;
  const files = [];
  for (let i = 0; i < a.length; i++) {
    if (a[i] === '-c' || a[i] === '--format') fmt = a[++i];
    else if (a[i].startsWith('-c') && a[i].length > 2) fmt = a[i].slice(2);
    else if (a[i].startsWith('--format=')) fmt = a[i].slice(9);
    else if (a[i].startsWith('--printf=')) { fmt = a[i].slice(9); printf = true; }
    else files.push(a[i]);
  }
  if (fmt === null) return statPlain(ctx);
  if (fmt === undefined) throw new Usage("option requires an argument -- 'c'");
  if (!files.length) throw new Usage('missing operand');
  for (const f of files) {
    let n;
    try { n = ctx.fs.lookup(ctx.p(f), false); } catch (e) { ctx.err(`stat: cannot statx '${f}': ${e.message}\n`); ctx.fail = 1; continue; }
    const size = ctx.fs.size(n);
    const d = new Date(n.mt * 1000);
    const y = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.000000000`;
    const type = n.t === 'd' ? 'directory' : n.t === 'l' ? 'symbolic link' : size ? 'regular file' : 'regular empty file';
    const map = {
      n: f, N: n.t === 'l' ? `'${f}' -> '${n.to}'` : `'${f}'`, s: String(size), a: n.m.toString(8), A: modeStr(n),
      U: n.o, G: n.g, u: String(UID[n.o] ?? 1000), g: String(UID[n.g] ?? 1000), F: type, y, Y: String(n.mt), '%': '%',
    };
    let s = fmt.replace(/%(.)/g, (m, k) => map[k] ?? m);
    if (printf) s = s.replace(/\\n/g, '\n').replace(/\\t/g, '\t'); else s += '\n';
    ctx.out(s);
  }
};

// ====================================================================================
// shell builtins
// ====================================================================================

BUILTINS.add('umask').add('time');

commands.umask = ctx => {
  const fs = ctx.fs;
  const a = ctx.args.filter(x => x !== '-S');
  const sym = ctx.args.includes('-S');
  if (!a.length) {
    if (!sym) { ctx.out(pad(fs.umask.toString(8), 4) + '\n'); return; }
    const allowed = 0o777 & ~fs.umask;
    const part = sh => 'rwx'.split('').filter((c, i) => (allowed >> (sh + 2 - i)) & 1).join('');
    ctx.out(`u=${part(6)},g=${part(3)},o=${part(0)}\n`);
    return;
  }
  if (!/^[0-7]{1,4}$/.test(a[0])) { ctx.err(`bash: umask: ${a[0]}: octal number out of range\n`); return 1; }
  fs.umask = parseInt(a[0], 8) & 0o777;
};

commands.time = ctx => {
  const t0 = performance.now();
  const code = ctx.args.length ? ctx.sh.execArgv(ctx.args, ctx.io) : 0;
  const ms = performance.now() - t0;
  const f = s => `0m${s.toFixed(3)}s`;
  ctx.err(`\nreal\t${f(ms / 1000 + 0.001)}\nuser\t${f(ms / 2000)}\nsys\t${f(0)}\n`);
  return code;
};

// ====================================================================================
// users, hardware, kernel
// ====================================================================================

const LOGIN = () => now() - 47 * 60;
const hm = ts => { const d = new Date(ts * 1000); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
const ymdhm = ts => { const d = new Date(ts * 1000); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hm(ts)}`; };

commands.who = ctx => {
  if (ctx.args[0] === 'am' || ctx.args.includes('-m')) { ctx.out(`hacker   pts/0        ${ymdhm(LOGIN())} (192.168.1.23)\n`); return; }
  if (ctx.args.includes('-b')) { ctx.out(`         system boot  ${ymdhm(now() - 3 * 86400 - 2 * 3600 - 14 * 60)}\n`); return; }
  ctx.out(`hacker   pts/0        ${ymdhm(LOGIN())} (192.168.1.23)\n`);
};

commands.w = ctx => {
  let up = '';
  commands.uptime({ ...ctx, out: s => { up += s; } });
  ctx.out(up);
  ctx.out('USER     TTY      FROM             LOGIN@   IDLE   JCPU   PCPU WHAT\n');
  ctx.out(`hacker   pts/0    192.168.1.23     ${hm(LOGIN())}    0.00s  0.04s  0.00s w\n`);
};

commands.last = ctx => {
  const { o } = opts(ctx, 'x', 'n');
  const rows = [
    ['hacker', 'pts/0', '192.168.1.23', 'Sat Nov 14', hm(LOGIN()), '  still logged in'],
    ['hacker', 'pts/0', '192.168.1.10', 'Thu Nov 12', '13:37', '- 14:02  (00:25)'],
    ['hacker', 'pts/1', '192.168.1.10', 'Thu Nov 12', '10:11', '- 10:58  (00:47)'],
    ['hacker', 'pts/0', '192.168.1.10', 'Thu Nov 12', '08:13', '- 09:40  (01:27)'],
    ['reboot', 'system boot', '6.8.0-hackterm', 'Wed Nov 11', '04:43', '  still running'],
  ];
  const n = o.n === undefined ? rows.length : Math.max(0, parseInt(o.n) || 0);
  for (const r of rows.slice(0, n)) ctx.out(`${r[0].padEnd(8)} ${r[1].padEnd(12)} ${r[2].padEnd(16)} ${r[3]} ${r[4]}  ${r[5]}\n`);
  ctx.out('\nwtmp begins Wed Nov 11 04:43:02 2026\n');
};

commands.lscpu = ctx => {
  const rows = [
    ['Architecture', 'x86_64'], ['CPU op-mode(s)', '32-bit, 64-bit'], ['Byte Order', 'Little Endian'],
    ['CPU(s)', '4'], ['On-line CPU(s) list', '0-3'], ['Vendor ID', 'HackTermVirt'],
    ['Model name', 'HackTerm Virtual CPU @ 3.20GHz'], ['Thread(s) per core', '1'], ['Core(s) per socket', '4'],
    ['Socket(s)', '1'], ['CPU max MHz', '3200.0000'], ['Virtualization', 'VT-x'],
    ['L1d cache', '128 KiB (4 instances)'], ['L2 cache', '2 MiB (4 instances)'], ['L3 cache', '8 MiB (1 instance)'],
  ];
  for (const [k, v] of rows) ctx.out(`${(k + ':').padEnd(24)}${v}\n`);
};

commands.lsblk = ctx => {
  ctx.out('NAME   MAJ:MIN RM  SIZE RO TYPE MOUNTPOINTS\n');
  ctx.out('sda      8:0    0   20G  0 disk \n└─sda1   8:1    0   20G  0 part /\nsr0     11:0    1 1024M  0 rom  \n');
};

const MOUNTS = `/dev/sda1 on / type ext4 (rw,relatime,errors=remount-ro)
proc on /proc type proc (rw,nosuid,nodev,noexec,relatime)
sysfs on /sys type sysfs (rw,nosuid,nodev,noexec,relatime)
devtmpfs on /dev type devtmpfs (rw,nosuid,relatime,size=4012345k,mode=755)
tmpfs on /run type tmpfs (rw,nosuid,nodev,noexec,relatime,size=804856k,mode=755)
tmpfs on /dev/shm type tmpfs (rw,nosuid,nodev)
`;
commands.mount = ctx => {
  if (!ctx.args.length || (ctx.args.length === 2 && ctx.args[0] === '-t')) {
    const t = ctx.args[1];
    ctx.out(t ? MOUNTS.split('\n').filter(l => l.includes(` type ${t} `)).map(l => l + '\n').join('') : MOUNTS);
    return;
  }
  if (ctx.fs.user !== 'root') { ctx.err('mount: only root can do that.\n'); return 1; }
  const dev = ctx.args.filter(x => x[0] !== '-')[0];
  ctx.err(`mount: ${ctx.args.at(-1)}: special device ${dev} does not exist.\n`);
  return 32;
};

const DMESG = `[    0.000000] Linux version 6.8.0-hackterm (gcc 13.2.0) #1 SMP PREEMPT_DYNAMIC
[    0.000000] Command line: BOOT_IMAGE=/boot/vmlinuz-6.8.0-hackterm root=/dev/sda1 ro quiet
[    0.112233] smpboot: Allowing 4 CPUs, 0 hotplug CPUs
[    1.204512] sd 0:0:0:0: [sda] 41943040 512-byte logical blocks: (21.5 GB/20.0 GiB)
[    1.230017]  sda: sda1
[    2.871104] EXT4-fs (sda1): mounted filesystem with ordered data mode.
[    3.402211] e1000: eth0 NIC Link is Up 1000 Mbps Full Duplex, Flow Control: RX
[  412.000144] audit: type=1400 apparmor="ALLOWED" operation="exec" profile="unconfined" name="/home/hacker/.cache/xmrig"
[ 4711.133700] perf: interrupt took too long (2510 > 2500), lowering kernel.perf_event_max_sample_rate to 79000
[ 8012.481337] CPU0: Core temperature above threshold, cpu clock throttled (total events = 1337)
`;
commands.dmesg = ctx => {
  if (ctx.fs.user !== 'root') { ctx.err('dmesg: read kernel buffer failed: Operation not permitted\n'); return 1; }
  ctx.out(DMESG);
};

// ====================================================================================
// services, logs, cron
// ====================================================================================

const SERVICES = {
  ssh: { pid: 811, desc: 'OpenBSD Secure Shell server', bin: 'sshd' },
  nginx: { pid: 902, desc: 'A high performance web server and a reverse proxy server', bin: 'nginx' },
  cron: { pid: 412, desc: 'Regular background program processing daemon', bin: 'cron' },
};
const svcName = s => { const n = s.replace(/\.service$/, ''); return n === 'sshd' ? 'ssh' : n; };
const running = (sh, svc) => sh.procs.some(p => p.pid === SERVICES[svc].pid);

commands.systemctl = ctx => {
  const sh = ctx.sh;
  const a = ctx.args.filter(x => !x.startsWith('--') && x !== '-l');
  const verb = a[0] ?? 'list-units';
  if (verb === 'list-units' || verb === 'list-unit-files') {
    ctx.out('  UNIT                LOAD   ACTIVE   SUB     DESCRIPTION\n');
    for (const [n, s] of Object.entries(SERVICES)) {
      const on = running(sh, n);
      ctx.out(`  ${(n + '.service').padEnd(19)} loaded ${(on ? 'active' : 'inactive').padEnd(8)} ${(on ? 'running' : 'dead').padEnd(7)} ${s.desc}\n`);
    }
    ctx.out(`\n${Object.keys(SERVICES).length} loaded units listed.\n`);
    return;
  }
  const units = a.slice(1).map(svcName);
  if (!units.length) { ctx.err(`Too few arguments.\n`); return 1; }
  let rc = 0;
  for (const u of units) {
    const s = SERVICES[u];
    if (!s) { ctx.err(`Unit ${u}.service could not be found.\n`); return verb === 'status' ? 4 : 5; }
    if (verb === 'status' || verb === 'is-active') {
      const on = running(sh, u);
      if (verb === 'is-active') { ctx.out((on ? 'active' : 'inactive') + '\n'); if (!on) rc = 3; continue; }
      const dot = ctx.tty ? (on ? C.bgreen : C.gray) + '●' + C.r : '●';
      ctx.out(`${dot} ${u}.service - ${s.desc}\n     Loaded: loaded (/usr/lib/systemd/system/${u}.service; enabled; preset: enabled)\n`);
      ctx.out(on ? `     Active: active (running) since Wed 2026-11-11 04:43:10 CET; 3 days ago\n   Main PID: ${s.pid} (${s.bin})\n`
        : `     Active: inactive (dead)\n`);
      if (!on) rc = 3;
      continue;
    }
    if (!['start', 'stop', 'restart', 'reload', 'enable', 'disable'].includes(verb)) { ctx.err(`Unknown command verb '${verb}'.\n`); return 1; }
    if (ctx.fs.user !== 'root') {
      ctx.err(`Failed to ${verb} ${u}.service: Interactive authentication required.\nSee system logs and 'systemctl status ${u}.service' for details.\n`);
      return 1;
    }
    if (verb === 'stop') sh.procs = sh.procs.filter(p => p.pid !== s.pid);
    if (['start', 'restart'].includes(verb) && !running(sh, u)) {
      const p = initialProcs().find(x => x.pid === s.pid);
      if (p) sh.procs = [...sh.procs, p].sort((x, y) => x.pid - y.pid);
    }
    if (verb === 'enable') ctx.out(`Synchronizing state of ${u}.service with SysV service script.\n`);
  }
  return rc;
};
commands.service = ctx => {
  const [name, verb] = ctx.args;
  if (!name || !verb) { ctx.err('Usage: service < option > | --status-all | [ service_name [ command | --full-restart ] ]\n'); return 1; }
  return commands.systemctl({ ...ctx, args: [verb, name] });
};

commands.journalctl = ctx => {
  const { o } = opts(ctx, 'efrx', 'un', { '--unit': 'u', '--lines': 'n', '--reverse': 'r', '--follow': 'f', '--pager-end': 'e', '--no-pager': 'x' });
  if (ctx.fs.user !== 'root') {
    ctx.err("Hint: You are currently not seeing messages from other users and the system.\n      Users in groups 'adm', 'systemd-journal' can see all messages.\n      Pass -q to turn off this notice.\n");
    ctx.out('-- No entries --\n');
    return 1;
  }
  let text = '';
  for (const f of ['/var/log/syslog', '/var/log/auth.log']) { try { text += ctx.fs.readFile(f); } catch { /* deleted */ } }
  let ls = lines(text).sort();
  if (o.u) {
    const u = svcName(o.u);
    const tag = { ssh: /sshd\[/, cron: /CRON\[|cron\[/, nginx: /nginx/ }[u] ?? new RegExp(u.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    ls = ls.filter(l => tag.test(l));
  }
  if (o.n !== undefined) ls = ls.slice(-Math.max(0, parseInt(o.n) || 0));
  if (o.r) ls.reverse();
  if (!ls.length) { ctx.out('-- No entries --\n'); return; }
  for (const l of ls) ctx.out(l + '\n');
};

const SPOOL = '/var/spool/cron/crontabs';
function ensureSpool(fs) {
  asRoot(fs, () => {
    for (const p of ['/var/spool', '/var/spool/cron', SPOOL]) if (!fs.tryLookup(p)) fs.mkdir(p);
    fs.lookup(SPOOL).m = 0o733; // writable for users, but not listable
  });
}
commands.crontab = ctx => {
  const { o, rest } = opts(ctx, 'lre', 'u');
  const user = o.u ?? ctx.fs.user;
  if (o.u && ctx.fs.user !== 'root' && o.u !== ctx.fs.user) { ctx.err('must be privileged to use -u\n'); return 1; }
  const path = `${SPOOL}/${user}`;
  ensureSpool(ctx.fs);
  const existing = asRoot(ctx.fs, () => ctx.fs.tryLookup(path));
  if (o.l) {
    if (!existing) { ctx.err(`no crontab for ${user}\n`); return 1; }
    ctx.out(existing.d);
    return;
  }
  if (o.r) {
    if (!existing) { ctx.err(`no crontab for ${user}\n`); return 1; }
    asRoot(ctx.fs, () => ctx.fs.remove(path));
    return;
  }
  const install = text => asRoot(ctx.fs, () => {
    ctx.fs.writeFile(path, text);
    const n = ctx.fs.lookup(path);
    n.o = user; n.g = 'crontab'; n.m = 0o600;
  });
  if (o.e) {
    if (!existing) {
      install('# Edit this file to introduce tasks to be run by cron.\n#\n# m h  dom mon dow   command\n');
      ctx.out(`no crontab for ${user} - using an empty one\n`);
    }
    ctx.sh.request = { type: 'editor', path, name: `/tmp/crontab.${Math.random().toString(36).slice(2, 8)}/crontab`, text: asRoot(ctx.fs, () => ctx.fs.readFile(path)), editor: 'nano', user: ctx.fs.user };
    return;
  }
  if (!rest.length) { ctx.err('crontab: usage error: file name or - (for stdin) must be specified\n'); return 1; }
  const src = readAll(ctx, rest.slice(0, 1))[0];
  if (!src) return 1;
  const bad = lines(src.text).findIndex(l => l.trim() && !l.trim().startsWith('#') && !/^\s*(@\w+\s+\S|(\S+\s+){5}\S)/.test(l) && !/^\s*\w+=/.test(l));
  if (bad >= 0) { ctx.err(`"${rest[0]}":${bad + 1}: bad minute\nerrors in crontab file, can't install.\n`); return 1; }
  install(src.text.endsWith('\n') || !src.text ? src.text : src.text + '\n');
};

// ====================================================================================
// processes
// ====================================================================================

const procName = cmd => {
  const first = cmd.replace(/^-/, '').split(/\s+/)[0].replace(/:$/, '');
  return baseName(first);
};
commands.pstree = ctx => {
  const showPid = ctx.args.some(a => /^-\w*p/.test(a));
  const procs = ctx.sh.procs.filter(p => p.pid !== 2);
  const label = p => procName(p.cmd) + (showPid ? `(${p.pid})` : '');
  const bash = procs.find(p => p.pid === 2048);
  const kids = new Map();
  const add = (parent, p) => { if (!kids.has(parent)) kids.set(parent, []); kids.get(parent).push(p); };
  for (const p of procs) {
    if (p.pid === 1) continue;
    if (p.pid === 2048) add(procs.some(q => q.pid === 811) ? 811 : 1, p);
    else if (p.tty === 'pts/0' && bash) add(2048, p);
    else add(1, p);
  }
  if (bash) add(2048, { pid: ctx.sh.nextPid, cmd: 'pstree' });
  const draw = p => {
    const me = label(p);
    const ch = (kids.get(p.pid) ?? []).sort((a, b) => label(a).localeCompare(label(b)));
    if (!ch.length) return [me];
    const sp = ' '.repeat([...me].length);
    if (ch.length === 1) {
      const sub = draw(ch[0]);
      return [me + '───' + sub[0], ...sub.slice(1).map(l => sp + '   ' + l)];
    }
    const out = [];
    ch.forEach((c, i) => {
      const sub = draw(c);
      const last = i === ch.length - 1;
      out.push((i === 0 ? me + '─┬─' : sp + (last ? ' └─' : ' ├─')) + sub[0]);
      for (const l of sub.slice(1)) out.push(sp + (last ? '   ' : ' │ ') + l);
    });
    return out;
  };
  const init = procs.find(p => p.pid === 1) ?? { pid: 1, cmd: 'init' };
  ctx.out(draw(init).join('\n') + '\n');
};

// ====================================================================================
// network (fully simulated, nothing leaves the browser)
// ====================================================================================

export const PORTS = {
  '127.0.0.1': [[22, 'ssh', 'OpenSSH 9.6p1 Ubuntu 3ubuntu13'], [80, 'http', 'nginx 1.24.0']],
  '192.168.1.1': [[53, 'domain', 'dnsmasq 2.90'], [80, 'http', 'lighttpd 1.4.76']],
  '192.168.1.10': [[22, 'ssh', 'OpenSSH 9.6p1 Ubuntu 3ubuntu13'], [80, 'http', 'nginx 1.24.0']],
  '192.168.1.23': [[22, 'ssh', 'OpenSSH 9.6p1'], [631, 'ipp', 'CUPS 2.4']],
  '10.0.0.66': [[22, 'ssh', 'OpenSSH 7.4 (protocol 2.0)'], [3333, 'dec-notes', 'XMRig stratum pool'], [8080, 'http-proxy', 'darknode panel']],
  '93.184.215.14': [[80, 'http', 'ECAcc'], [443, 'https', 'ECAcc']],
  '142.250.185.78': [[80, 'http', 'gws'], [443, 'https', 'gws']],
  '8.8.8.8': [[53, 'domain', 'Google Public DNS'], [443, 'https', 'Google DNS-over-HTTPS']],
  '1.1.1.1': [[53, 'domain', 'Cloudflare DNS'], [80, 'http', 'cloudflare'], [443, 'https', 'cloudflare']],
  '139.178.84.217': [[22, 'ssh', 'OpenSSH 8.7'], [80, 'http', 'nginx'], [443, 'https', 'nginx']],
};
PORTS['127.0.1.1'] = PORTS['127.0.0.1'];
const SERVICE_NAMES = {
  21: 'ftp', 22: 'ssh', 23: 'telnet', 25: 'smtp', 53: 'domain', 80: 'http', 110: 'pop3', 143: 'imap', 443: 'https',
  445: 'microsoft-ds', 631: 'ipp', 3306: 'mysql', 3333: 'dec-notes', 5432: 'postgresql', 6379: 'redis', 8080: 'http-proxy',
};
const REVERSE = {
  '127.0.0.1': 'localhost', '127.0.1.1': 'box', '192.168.1.1': '_gateway', '192.168.1.10': 'box',
  '192.168.1.23': 'operator-laptop.lan', '10.0.0.66': 'darknode.local', '93.184.215.14': 'example.com',
  '142.250.185.78': 'fra16s48-in-f14.1e100.net', '8.8.8.8': 'dns.google', '1.1.1.1': 'one.one.one.one',
  '139.178.84.217': 'dfw.source.kernel.org',
};
// User input indexes these tables; see the matching note in world.js.
for (const table of [PORTS, SERVICE_NAMES, REVERSE, SERVICES, MEMBER]) Object.setPrototypeOf(table, null);

const isIp = s => /^\d{1,3}(\.\d{1,3}){3}$/.test(s);
// Resolve a host name or IP; null means "Name or service not known".
function resolve(host) {
  if (!host) return null;
  const h = host.replace(/\.$/, '').toLowerCase();
  if (HOSTS[h]) return HOSTS[h];
  if (isIp(h)) return h;
  return null;
}
const isPublic = ip => !/^(127\.|10\.|192\.168\.)/.test(ip);
const latency = ip => (ip.startsWith('127.') ? 0.00004 : ip.startsWith('192.168.') ? 0.0012 : ip.startsWith('10.') ? 0.0006 : 0.014);
const stamp = () => {
  const d = new Date();
  return { d, tz: tzAbbr(d) };
};

function parsePorts(spec) {
  if (spec === '-') return { all: true, list: null };
  const list = [];
  for (const part of spec.split(',')) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part);
    if (!m) return null;
    const a = +m[1], b = m[2] ? +m[2] : a;
    if (a < 1 || b > 65535 || a > b) return null;
    for (let p = a; p <= b && list.length <= 70000; p++) list.push(p);
  }
  return { all: false, list };
}

const ipNum = s => s.split('.').reduce((acc, x) => acc * 256 + +x, 0);
function ipInCidr(ip, cidr) {
  const [base, bits] = cidr.split('/');
  const size = 2 ** (32 - Math.min(32, +bits));
  return Math.floor(ipNum(ip) / size) === Math.floor(ipNum(base) / size);
}

commands.nmap = ctx => {
  const { o, rest } = opts(ctx, 'sVnFPvAOT0123456789', 'p', {});
  // Collapse common combined flags like -sV, -sn, -Pn, -T4 that the parser treats as letters.
  const raw = ctx.args.join(' ');
  const sn = /(^|\s)-sn\b/.test(raw), sV = /(^|\s)-s\w*V|(^|\s)-A\b/.test(raw);
  if (!rest.length) {
    ctx.out('Nmap 7.94SVN ( https://nmap.org )\nUsage: nmap [Scan Type(s)] [Options] {target specification}\nBeispiele: nmap localhost   nmap -sV -p 22,80 darknode.local   nmap -sn 192.168.1.0/24\n');
    return;
  }
  const { d, tz } = stamp();
  ctx.out(`Starting Nmap 7.94SVN ( https://nmap.org ) at ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())} ${tz}\n`);
  const ports = o.p ? parsePorts(o.p) : null;
  if (o.p && !ports) { ctx.err(`Error #487: Your port specifications are illegal.  Example of proper form: "-100,200-1024,T:3000-4000,U:60000-"\nQUITTING!\n`); return 1; }
  const known = [...new Set([...Object.keys(PORTS), ...Object.values(HOSTS)])];
  let targets = [], total = 0;
  for (const t of rest) {
    if (/^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/.test(t)) {
      const bits = +t.split('/')[1];
      total += 2 ** (32 - bits);
      targets.push(...known.filter(ip => ipInCidr(ip, t)).sort((a, b) => ipNum(a) - ipNum(b)).map(ip => ({ name: null, ip })));
      continue;
    }
    total++;
    const ip = resolve(t);
    if (!ip) { ctx.err(`Failed to resolve "${t}".\n`); total--; continue; }
    targets.push({ name: isIp(t) ? null : t, ip, single: true });
  }
  let up = 0;
  for (const t of targets) {
    const open = PORTS[t.ip];
    if (!open) { if (t.single) ctx.out(`Note: Host seems down. If it is really up, but blocking our ping probes, try -Pn\n`); continue; }
    up++;
    const name = t.name ?? REVERSE[t.ip];
    ctx.out(`Nmap scan report for ${name ? `${name} (${t.ip})` : t.ip}\nHost is up (${latency(t.ip).toFixed(t.ip.startsWith('127.') ? 5 : 4)}s latency).\n`);
    if (sn) continue;
    let rows;
    if (ports && !ports.all && ports.list.length <= 25) {
      rows = ports.list.map(p => open.find(x => x[0] === p) ?? [p, SERVICE_NAMES[p] ?? 'unknown', '', 'closed']);
    } else {
      const inRange = p => !ports || ports.all || ports.list.includes(p);
      const scanned = !ports ? 1000 : ports.all ? 65535 : ports.list.length;
      rows = open.filter(x => inRange(x[0]));
      ctx.out(`Not shown: ${scanned - rows.length} closed tcp ports (conn-refused)\n`);
    }
    if (!rows.length) continue;
    const w = Math.max(9, ...rows.map(r => `${r[0]}/tcp`.length + 1));
    ctx.out(`${'PORT'.padEnd(w)}STATE  SERVICE${sV ? '    VERSION' : ''}\n`);
    for (const r of rows) {
      const state = r[3] ?? 'open';
      ctx.out(`${`${r[0]}/tcp`.padEnd(w)}${state.padEnd(7)}${sV && state === 'open' ? r[1].padEnd(11) + r[2] : r[1]}\n`);
    }
    ctx.out('\n');
  }
  const secs = (0.04 + targets.length * 0.11 + (sn ? 0 : 0.3)).toFixed(2);
  ctx.out(`Nmap done: ${total} IP address${total === 1 ? '' : 'es'} (${up} host${up === 1 ? '' : 's'} up) scanned in ${secs} seconds\n`);
};

// "OpenSSH 9.6p1 Ubuntu 3ubuntu13" -> "SSH-2.0-OpenSSH_9.6p1 Ubuntu-3ubuntu13"
const sshBanner = version => `SSH-2.0-${version.replace(/ \(.*\)$/, '').replace(' ', '_').replace('Ubuntu ', 'Ubuntu-')}\r\n`;
commands.nc = commands.netcat = ctx => {
  const { o, rest } = opts(ctx, 'zvlnuw46', 'pw');
  if (o.l) { ctx.err('nc: Lauschen (-l) ist in der Simulation nicht moeglich - es gibt keine eingehenden Verbindungen.\n'); return 1; }
  const [host, portSpec] = rest;
  if (!host || !portSpec) { ctx.err('usage: nc [-46lnuvz] [-w timeout] [destination] [port]\n'); return 1; }
  const ip = resolve(host);
  if (!ip) { ctx.err(`nc: getaddrinfo for host "${host}" port ${portSpec}: Name or service not known\n`); return 1; }
  const range = parsePorts(portSpec);
  if (!range || range.all || range.list.length > 1024) { ctx.err(`nc: port range not valid: ${portSpec}\n`); return 1; }
  const open = PORTS[ip] ?? [];
  let ok = false;
  for (const port of range.list) {
    const svc = open.find(x => x[0] === port);
    const label = `${host}${isIp(host) ? '' : ` (${ip})`}`;
    if (!svc) {
      if (o.v || range.list.length === 1) ctx.err(`nc: connect to ${label} port ${port} (tcp) failed: Connection refused\n`);
      continue;
    }
    ok = true;
    if (o.v || o.z) ctx.err(`Connection to ${label} ${port} port [tcp/${svc[1] === 'dec-notes' ? '*' : svc[1]}] succeeded!\n`);
    if (o.z) continue;
    if (svc[1] === 'ssh') ctx.out(sshBanner(svc[2]));
    else if (svc[1] === 'http' && ctx.stdin) {
      const site = SITES[host] ?? SITES[REVERSE[ip]];
      const req = /^(GET|HEAD) (\S+)/.exec(ctx.stdin);
      if (!req) ctx.out('HTTP/1.1 400 Bad Request\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
      else if (site && req[2] === '/') ctx.out(`HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: ${bytesOf(site).length}\r\nConnection: close\r\n\r\n${req[1] === 'GET' ? site : ''}`);
      else ctx.out('HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
    } else if (svc[1] === 'dec-notes') ctx.out('{"id":null,"jsonrpc":"2.0","error":{"code":-1,"message":"Unauthenticated"}}\n');
  }
  return ok ? 0 : 1;
};

commands.host = ctx => {
  const name = ctx.args.find(a => a[0] !== '-');
  if (!name) { ctx.err('Usage: host [-t type] name [server]\n'); return 1; }
  if (isIp(name)) {
    const r = REVERSE[name];
    const arpa = name.split('.').reverse().join('.') + '.in-addr.arpa';
    if (!r) { ctx.out(`Host ${arpa} not found: 3(NXDOMAIN)\n`); return 1; }
    ctx.out(`${arpa} domain name pointer ${r}.\n`);
    return;
  }
  const ip = resolve(name);
  if (!ip) { ctx.out(`Host ${name} not found: 3(NXDOMAIN)\n`); return 1; }
  ctx.out(`${name} has address ${ip}\n`);
};

commands.nslookup = ctx => {
  const name = ctx.args.find(a => a[0] !== '-');
  if (!name) { ctx.err('nslookup: interaktiver Modus wird nicht unterstuetzt - nutze "nslookup NAME"\n'); return 1; }
  ctx.out('Server:\t\t127.0.0.53\nAddress:\t127.0.0.53#53\n\n');
  if (isIp(name)) {
    const r = REVERSE[name];
    const arpa = name.split('.').reverse().join('.') + '.in-addr.arpa';
    if (!r) { ctx.out(`** server can't find ${arpa}: NXDOMAIN\n\n`); return 1; }
    ctx.out(`${isPublic(name) ? 'Non-authoritative answer:\n' : ''}${arpa}\tname = ${r}.\n\n`);
    return;
  }
  const ip = resolve(name);
  if (!ip) { ctx.out(`** server can't find ${name}: NXDOMAIN\n\n`); return 1; }
  ctx.out(`${isPublic(ip) ? 'Non-authoritative answer:\n' : ''}Name:\t${name}\nAddress: ${ip}\n\n`);
};

commands.dig = ctx => {
  const args = ctx.args.filter(a => !a.startsWith('@'));
  const short = args.includes('+short');
  const xi = args.indexOf('-x');
  const rev = xi >= 0 ? args[xi + 1] : null;
  const plain = args.filter((a, i) => !a.startsWith('+') && a !== '-x' && !(xi >= 0 && i === xi + 1));
  const name = rev ?? plain.find(a => !/^(A|AAAA|MX|NS|TXT|CNAME|SOA|PTR|ANY)$/i.test(a)) ?? '.';
  const type = rev ? 'PTR' : (plain.find(a => /^(A|AAAA|MX|NS|TXT|CNAME|SOA|PTR|ANY)$/i.test(a)) ?? 'A').toUpperCase();
  let qname = name.endsWith('.') ? name : name + '.';
  let answer = null, status = 'NOERROR';
  if (rev) {
    if (!isIp(rev)) { ctx.err(`Invalid IP address ${rev}\n`); return 1; }
    qname = rev.split('.').reverse().join('.') + '.in-addr.arpa.';
    answer = REVERSE[rev] ? REVERSE[rev] + '.' : null;
    if (!answer) status = 'NXDOMAIN';
  } else {
    const ip = resolve(name);
    if (!ip || isIp(name)) status = isIp(name) ? 'NOERROR' : 'NXDOMAIN';
    else if (type === 'A') answer = ip;
  }
  if (short) { if (answer) ctx.out(answer + '\n'); return; }
  const { d, tz } = stamp();
  const when = `${DAY[d.getDay()]} ${MON[d.getMonth()]} ${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${tz} ${d.getFullYear()}`;
  ctx.out(`\n; <<>> DiG 9.18.28 <<>> ${ctx.args.join(' ')}\n;; global options: +cmd\n;; Got answer:\n`);
  ctx.out(`;; ->>HEADER<<- opcode: QUERY, status: ${status}, id: ${4096 + Math.floor(Math.random() * 60000)}\n`);
  ctx.out(`;; flags: qr rd ra; QUERY: 1, ANSWER: ${answer ? 1 : 0}, AUTHORITY: 0, ADDITIONAL: 1\n\n`);
  ctx.out(`;; QUESTION SECTION:\n;${qname}\t\t\tIN\t${type}\n\n`);
  if (answer) ctx.out(`;; ANSWER SECTION:\n${qname}\t\t300\tIN\t${type}\t${answer}\n\n`);
  ctx.out(`;; Query time: ${isPublic(answer ?? '') ? 12 : 0} msec\n;; SERVER: 127.0.0.53#53(127.0.0.53) (UDP)\n;; WHEN: ${when}\n;; MSG SIZE  rcvd: ${answer ? 56 : 40}\n\n`);
};

commands.traceroute = commands.tracepath = ctx => {
  const { o, rest } = opts(ctx, 'nI46', 'mq');
  const host = rest[0];
  if (!host) { ctx.err('Usage: traceroute [ -nI46 ] [ -m max_ttl ] host\n'); return 1; }
  const ip = resolve(host);
  if (!ip) { ctx.err(`${host}: Name or service not known\nCannot handle "host" cmdline arg \`${host}' on position 1 (argc 1)\n`); return 2; }
  const hops = ip.startsWith('127.') || ip === '192.168.1.10' ? [[ip, REVERSE[ip] ?? ip]]
    : ip.startsWith('192.168.1.') ? [[ip, REVERSE[ip] ?? ip]]
      : ip.startsWith('10.') ? [['192.168.1.1', '_gateway'], [ip, REVERSE[ip] ?? ip]]
        : [['192.168.1.1', '_gateway'], ['100.64.0.1', '100.64.0.1'], null, ['198.51.100.17', 'core1.fra.example.net'], ['203.0.113.9', 'edge2.fra.example.net'], [ip, REVERSE[ip] ?? ip]];
  const max = Math.min(parseInt(o.m ?? '30') || 30, 30);
  ctx.out(`traceroute to ${host} (${ip}), ${max} hops max, 60 byte packets\n`);
  hops.slice(0, max).forEach((h, i) => {
    const n = String(i + 1).padStart(2);
    if (!h) { ctx.out(`${n}  * * *\n`); return; }
    const base = (latency(h[0]) * 1000) * (i + 1) * 0.6 + 0.3;
    const t = () => (base + Math.random() * base * 0.2).toFixed(3) + ' ms';
    ctx.out(`${n}  ${o.n ? h[0] : `${h[1]} (${h[0]})`}  ${t()}  ${t()}  ${t()}\n`);
  });
};

// Socket table derived from the live process list, so killing a process closes its sockets.
function sockets(sh) {
  const alive = pid => sh.procs.some(p => p.pid === pid);
  const all = [
    { proto: 'udp', local: '127.0.0.53', lport: 53, remote: '0.0.0.0', rport: '*', state: 'UNCONN', pid: 388, prog: 'systemd-resolve', user: 'systemd-resolve', always: true },
    { proto: 'tcp', local: '0.0.0.0', lport: 22, remote: '0.0.0.0', rport: '*', state: 'LISTEN', pid: 811, prog: 'sshd', user: 'root' },
    { proto: 'tcp', local: '0.0.0.0', lport: 80, remote: '0.0.0.0', rport: '*', state: 'LISTEN', pid: 902, prog: 'nginx', user: 'www-data' },
    { proto: 'tcp', local: '192.168.1.10', lport: 22, remote: '192.168.1.23', rport: 50911, state: 'ESTABLISHED', pid: 811, prog: 'sshd', user: 'root' },
    { proto: 'tcp', local: '192.168.1.10', lport: 48812, remote: '10.0.0.66', rport: 3333, state: 'ESTABLISHED', pid: 1337, prog: 'xmrig', user: 'hacker' },
  ];
  return all.filter(s => s.always || alive(s.pid));
}
const portName = (p, numeric) => (numeric || typeof p !== 'number' ? String(p) : SERVICE_NAMES[p] ?? String(p));
const hostName = (ip, numeric) => (numeric || ip === '0.0.0.0' ? ip : REVERSE[ip] ?? ip);

commands.netstat = ctx => {
  const { o } = opts(ctx, 'tulpnae', '');
  const listen = o.l, all = o.a;
  let rows = sockets(ctx.sh).filter(s => (all ? true : listen ? ['LISTEN', 'UNCONN'].includes(s.state) : s.state === 'ESTABLISHED'));
  if (o.t || o.u) rows = rows.filter(s => (o.t && s.proto === 'tcp') || (o.u && s.proto === 'udp'));
  const root = ctx.fs.user === 'root';
  if (o.p && !root) ctx.out('(Not all processes could be identified, non-owned process info\n will not be shown, you would have to be root to see it all.)\n');
  ctx.out(`Active Internet connections (${listen && !all ? 'only servers' : all ? 'servers and established' : 'w/o servers'})\n`);
  ctx.out(`Proto Recv-Q Send-Q Local Address           Foreign Address         State      ${o.p ? ' PID/Program name' : ''}\n`);
  for (const s of rows) {
    const loc = `${hostName(s.local, o.n)}:${portName(s.lport, o.n)}`;
    const rem = `${hostName(s.remote, o.n)}:${portName(s.rport, o.n)}`;
    const prog = o.p ? (root || s.user === ctx.fs.user ? ` ${s.pid}/${s.prog}` : ' -') : '';
    ctx.out(`${s.proto.padEnd(6)}${'0'.padStart(6)} ${'0'.padStart(6)} ${loc.padEnd(23)} ${rem.padEnd(23)} ${(s.proto === 'udp' ? '' : s.state).padEnd(11)}${prog}\n`);
  }
};

commands.ss = ctx => {
  const { o } = opts(ctx, 'tulpnaH', '');
  let rows = sockets(ctx.sh).filter(s => (o.a ? true : o.l ? ['LISTEN', 'UNCONN'].includes(s.state) : s.state === 'ESTABLISHED'));
  if (o.t || o.u) rows = rows.filter(s => (o.t && s.proto === 'tcp') || (o.u && s.proto === 'udp'));
  const root = ctx.fs.user === 'root';
  if (!o.H) ctx.out(`Netid State  Recv-Q Send-Q    Local Address:Port      Peer Address:Port Process\n`);
  for (const s of rows) {
    const loc = `${s.local === '127.0.0.53' ? '127.0.0.53%lo' : s.local}:${portName(s.lport, o.n)}`;
    const rem = `${s.remote}:${portName(s.rport, o.n)}`;
    const proc = o.p && (root || s.user === ctx.fs.user) ? `users:(("${s.prog}",pid=${s.pid},fd=${s.pid === 1337 ? 12 : 3}))` : '';
    ctx.out(`${s.proto.padEnd(5)} ${(s.state === 'ESTABLISHED' ? 'ESTAB' : s.state).padEnd(6)} 0      0      ${loc.padStart(20)} ${rem.padStart(20)} ${proc}\n`.replace(/ +\n$/, '\n'));
  }
};

commands.lsof = ctx => {
  const ii = ctx.args.findIndex(a => a.startsWith('-i'));
  if (ii < 0) { ctx.err('lsof: in der Simulation nur mit -i (Netzwerkverbindungen), z.B. lsof -i oder lsof -i :22\n'); return 1; }
  const filt = (ctx.args[ii].slice(2) || ctx.args[ii + 1] || '').replace(/^tcp|^udp/i, '');
  const m = /:(\d+)$/.exec(filt);
  const root = ctx.fs.user === 'root';
  const rows = sockets(ctx.sh).filter(s => (root || s.user === ctx.fs.user) && (!m || s.lport === +m[1] || s.rport === +m[1]));
  if (!rows.length) return 1;
  ctx.out('COMMAND     PID     USER   FD   TYPE DEVICE SIZE/OFF NODE NAME\n');
  for (const s of rows) {
    const name = s.state === 'ESTABLISHED'
      ? `${hostName(s.local)}:${s.lport}->${hostName(s.remote)}:${portName(s.rport)} (ESTABLISHED)`
      : `${s.local === '0.0.0.0' ? '*' : s.local}:${portName(s.lport)}${s.proto === 'tcp' ? ' (LISTEN)' : ''}`;
    ctx.out(`${s.prog.slice(0, 9).padEnd(9)} ${String(s.pid).padStart(5)} ${s.user.slice(0, 8).padStart(8)} ${(s.pid === 1337 ? '12u' : '3u').padStart(4)}  IPv4  ${String(30000 + s.lport).padStart(5)}      0t0  ${s.proto.toUpperCase()} ${name}\n`);
  }
};

// ====================================================================================
// manual pages: name -> [synopsis, description, examples[], category]
// ====================================================================================

Object.assign(MAN, {
  paste: ['paste [-s] [-d LISTE] DATEI...', 'Fuegt Dateien zeilenweise nebeneinander zusammen (Trenner: Tab). -d anderer Trenner, -s alle Zeilen einer Datei in eine Zeile.', ['paste namen.txt punkte.txt', 'seq 5 | paste -sd+ | bc'], 'Text'],
  comm: ['comm [-123] DATEI1 DATEI2', 'Vergleicht zwei SORTIERTE Dateien: Spalte 1 nur in Datei 1, Spalte 2 nur in Datei 2, Spalte 3 in beiden. -1/-2/-3 blendet Spalten aus.', ['comm -12 a.txt b.txt', 'comm -3 alt.txt neu.txt'], 'Text'],
  column: ['column [-t] [-s SEP] [-o SEP] [DATEI]', 'Formatiert Eingaben in Spalten. -t baut eine Tabelle, -s legt den Eingabe-Trenner fest.', ['column -t -s, documents/contacts.csv', 'mount | column -t'], 'Text'],
  fold: ['fold [-s] [-w N] [DATEI]', 'Bricht lange Zeilen nach N Zeichen um (Standard 80). -s bricht nur an Leerzeichen.', ['fold -w 20 -s readme.txt'], 'Text'],
  shuf: ['shuf [-n N] [-e ARG...] [-i LO-HI] [DATEI]', 'Mischt Zeilen zufaellig. -n nur N Zeilen, -e mischt die Argumente, -i eine Zahlenfolge.', ['shuf -n 1 documents/todo.txt', 'shuf -i 1-6 -n 1'], 'Text'],
  yes: ['yes [TEXT]', 'Gibt endlos "y" (oder TEXT) aus - praktisch, um Rueckfragen automatisch zu bestaetigen. Hier nach 10000 Zeilen gestoppt.', ['yes | head -n 3', 'yes nein | head -n 2'], 'Text'],
  expr: ['expr AUSDRUCK', 'Rechnet mit ganzen Zahlen und vergleicht Werte. Jeder Teil ist ein eigenes Argument, * muss maskiert werden. Auch: length, substr, index, STRING : REGEX.', ['expr 6 \\* 7', 'expr length "hallo"', 'expr 10 % 3'], 'Text'],
  factor: ['factor ZAHL...', 'Zerlegt Zahlen in Primfaktoren.', ['factor 1337', 'echo 360 | factor'], 'Text'],
  md5sum: ['md5sum [-c] [DATEI]...', 'Berechnet MD5-Pruefsummen. -c prueft eine Liste "summe  datei". MD5 ist fuer Sicherheit veraltet - nutze sha256sum.', ['md5sum readme.txt', 'md5sum *.txt > sums.md5; md5sum -c sums.md5'], 'Suchen'],
  sha1sum: ['sha1sum [-c] [DATEI]...', 'Berechnet SHA-1-Pruefsummen (wie git sie nutzt). -c prueft eine Liste.', ['sha1sum notes.txt'], 'Suchen'],
  sha256sum: ['sha256sum [-c] [DATEI]...', 'Berechnet SHA-256-Pruefsummen, z.B. um Downloads zu verifizieren. Aendert sich ein Byte, aendert sich die ganze Summe.', ['sha256sum readme.txt', 'echo -n abc | sha256sum', 'sha256sum -c SHA256SUMS'], 'Suchen'],
  xxd: ['xxd [-p] [-r] [-l N] [-c N] [DATEI]', 'Zeigt Dateien als Hexdump. -p nur Hex, -r wandelt einen Hexdump zurueck, -l nur N Bytes.', ['xxd readme.txt | head', 'echo hi | xxd -p', 'echo 6869 | xxd -r -p'], 'Dateien lesen'],
  hexdump: ['hexdump [-C] [-n N] [DATEI]', 'Hexdump einer Datei. -C zeigt Hex und ASCII nebeneinander (kanonisch).', ['hexdump -C downloads/payload.b64'], 'Dateien lesen'],
  gzip: ['gzip [-dckfvl] DATEI...', 'Komprimiert Dateien zu DATEI.gz (das Original verschwindet). -d entpacken, -k Original behalten, -c auf stdout, -l Infos.', ['gzip notes.txt', 'gzip -k logs/auth.log', 'gzip -d notes.txt.gz'], 'Dateien verwalten'],
  gunzip: ['gunzip [-k] DATEI.gz...', 'Entpackt .gz-Dateien (wie gzip -d).', ['gunzip notes.txt.gz'], 'Dateien verwalten'],
  zcat: ['zcat DATEI.gz...', 'Zeigt den Inhalt einer .gz-Datei, ohne sie zu entpacken.', ['zcat notes.txt.gz | grep TODO'], 'Dateien lesen'],
  chgrp: ['chgrp [-R] GRUPPE DATEI...', 'Aendert die Gruppe einer Datei. Normale Nutzer duerfen nur eigene Dateien in eigene Gruppen geben.', ['chgrp sudo notes.txt', 'ls -l notes.txt'], 'Rechte'],
  umask: ['umask [-S] [MASKE]', 'Zeigt oder setzt die Maske fuer neue Dateien. 022 -> Dateien 644, Ordner 755. 077 -> nur du hast Zugriff.', ['umask', 'umask -S', 'umask 077; touch privat.txt; ls -l privat.txt'], 'Rechte'],
  mktemp: ['mktemp [-d] [VORLAGE]', 'Legt eine temporaere Datei (oder mit -d einen Ordner) mit zufaelligem Namen in /tmp an und gibt den Pfad aus.', ['mktemp', 'tmp=$(mktemp -d); echo $tmp'], 'Dateien verwalten'],
  who: ['who [-b] [am i]', 'Zeigt, wer eingeloggt ist. -b letzter Systemstart.', ['who', 'who -b'], 'System'],
  w: ['w', 'Wer ist eingeloggt und was tut er? Mit Uptime und Last.', ['w'], 'System'],
  last: ['last [-n N]', 'Zeigt die letzten Logins und Neustarts.', ['last', 'last -n 2'], 'System'],
  lscpu: ['lscpu', 'Zeigt Infos ueber die CPU.', ['lscpu', 'lscpu | grep Model'], 'System'],
  lsblk: ['lsblk', 'Listet Festplatten und Partitionen als Baum.', ['lsblk'], 'System'],
  mount: ['mount [-t TYP]', 'Zeigt eingehaengte Dateisysteme (Einhaengen nur als root).', ['mount | column -t', 'mount -t ext4'], 'System'],
  dmesg: ['dmesg', 'Kernel-Meldungen (nur root). Verraet Hardware-Fehler - und manchmal mehr.', ['sudo dmesg | tail -n 3', 'sudo dmesg | grep -i cpu'], 'System'],
  systemctl: ['systemctl [status|start|stop|restart|list-units] [DIENST]', 'Steuert Systemdienste (systemd). Starten/Stoppen nur als root.', ['systemctl status ssh', 'sudo systemctl stop nginx', 'systemctl list-units'], 'Prozesse'],
  service: ['service DIENST BEFEHL', 'Aelterer Weg, Dienste zu steuern (ruft systemctl auf).', ['service ssh status'], 'Prozesse'],
  journalctl: ['journalctl [-u DIENST] [-n N] [-r]', 'Liest das Systemjournal (nur root). -u filtert nach Dienst, -n letzte N Zeilen, -r neueste zuerst.', ['sudo journalctl -u ssh', 'sudo journalctl -n 5 -r'], 'Prozesse'],
  crontab: ['crontab [-l | -e | -r | DATEI]', 'Zeitgesteuerte Aufgaben. -l zeigen, -e bearbeiten, -r loeschen. Format: Minute Stunde Tag Monat Wochentag Befehl.', ['crontab -l', 'echo "*/5 * * * * ~/tools/scan.sh" > job; crontab job', 'crontab -e'], 'Prozesse'],
  pstree: ['pstree [-p]', 'Zeigt Prozesse als Baum: wer hat wen gestartet. -p mit PIDs.', ['pstree', 'pstree -p'], 'Prozesse'],
  time: ['time BEFEHL', 'Misst, wie lange ein Befehl braucht (Ausgabe auf stderr).', ['time sleep 1', 'time find / -name "*.log" 2>/dev/null'], 'Shell'],
  nmap: ['nmap [-sV] [-sn] [-p PORTS] ZIEL...', 'Portscanner: findet offene Ports und Dienste. -sV Versionen, -sn nur Hosts finden, -p 22,80 oder 1-1000. Scanne echte Systeme nur mit Erlaubnis!', ['nmap localhost', 'nmap -sV darknode.local', 'nmap -sn 192.168.1.0/24'], 'Netzwerk'],
  nc: ['nc [-zv] HOST PORT', 'Netcat: oeffnet TCP-Verbindungen. -z nur pruefen, ob der Port offen ist, -v ausfuehrlich. Zeigt Banner von Diensten.', ['nc -zv localhost 22', 'nc darknode.local 22', 'printf "GET / HTTP/1.0\\r\\n\\r\\n" | nc example.com 80'], 'Netzwerk'],
  host: ['host NAME|IP', 'Einfache DNS-Abfrage: Name -> IP oder IP -> Name.', ['host example.com', 'host 10.0.0.66'], 'Netzwerk'],
  nslookup: ['nslookup NAME|IP', 'DNS-Abfrage mit Angabe des DNS-Servers.', ['nslookup google.com'], 'Netzwerk'],
  dig: ['dig [+short] [-x IP] NAME [TYP]', 'Ausfuehrliche DNS-Abfrage. +short nur die Antwort, -x Rueckwaertsaufloesung.', ['dig example.com', 'dig +short kernel.org', 'dig -x 8.8.8.8'], 'Netzwerk'],
  traceroute: ['traceroute [-n] HOST', 'Zeigt die Router (Hops) auf dem Weg zum Ziel. -n ohne Namensaufloesung.', ['traceroute darknode.local', 'traceroute -n example.com'], 'Netzwerk'],
  netstat: ['netstat [-tulpna]', 'Zeigt Netzwerkverbindungen. -t TCP, -u UDP, -l lauschende Ports, -p Programm, -n numerisch, -a alle.', ['netstat -tulpn', 'netstat -tnp'], 'Netzwerk'],
  ss: ['ss [-tulpna]', 'Moderner Nachfolger von netstat, gleiche Optionen.', ['ss -tulpn', 'ss -tp'], 'Netzwerk'],
  lsof: ['lsof -i [:PORT]', 'Zeigt Prozesse mit offenen Netzwerkverbindungen (als normaler Nutzer nur die eigenen).', ['lsof -i', 'sudo lsof -i :22'], 'Netzwerk'],
});
