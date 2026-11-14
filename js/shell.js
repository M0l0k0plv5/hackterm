// Shell interpreter: lexer, parser, expansion and execution on top of the VFS.
import { VFS, normalize, parentPath, baseName } from './vfs.js';
import { commands, Usage, BUILTINS, opts } from './commands.js';
import './more.js'; // registers the additional commands
import { FsError } from './vfs.js';
import { buildWorld, initialProcs, MAN } from './world.js';
import { calc } from './awk.js';

class SyntaxErr extends Error {}
// Input that is valid so far but unfinished (open quote, missing `done`, trailing `|` ...).
class Incomplete extends SyntaxErr {}
class ExpandErr extends Error {}
// Control flow signals. They are not Errors, so generic catch blocks can tell them apart.
export class Signal { constructor(n = 1) { this.n = n; } }
class BreakSig extends Signal {}
class ContinueSig extends Signal {}
class ReturnSig extends Signal {}
// soft: only the loop limit; a pipe may hand on the output produced before it hit.
class LimitSig extends Signal { constructor(msg, soft = false) { super(); this.msg = msg; this.soft = soft; } }

// Limit for brace expansion so a typo like {1..100000000} cannot freeze the tab.
const MAX_WORDS = 10000;
// Everything runs synchronously in the UI thread, so runaway loops must be cut off.
export const LIMITS = { steps: 50000, loops: 10000, ms: 3000, funcDepth: 100 };

// Unquoted special characters are replaced by private-use placeholders during
// expansion so that quoted ones stay literal.
const P = { '*': '\uE000', '?': '\uE001', '[': '\uE002', '{': '\uE003', '}': '\uE004', ',': '\uE005' };
const UNP = Object.fromEntries(Object.entries(P).map(([k, v]) => [v, k]));
const restore = s => s.replace(/[\uE000-\uE005]/g, c => UNP[c]);
const HAS_GLOB = /[\uE000-\uE002]/;
const ELF = '\x7fELF';

function matchParen(src, i) {
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (c === '\\') { j++; continue; }
    if (c === "'") { const k = src.indexOf("'", j + 1); if (k < 0) return -1; j = k; continue; }
    if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return j;
  }
  return -1;
}

const OPS = /^(2>&1|2>>|2>|&>|&&|\|\||;;|<<<|<<-|<<|>>|>|<|\||;|&|\(|\))/;

// Split source text into raw words (quotes kept), operators, newlines, `((..))`,
// `[[..]]` and here-documents (attached to their `<<` operator).
export function lex(src) {
  const toks = [];
  const pendingDocs = [];
  let w = '', has = false, i = 0;
  const push = () => { if (has) { toks.push({ t: 'w', v: w }); w = ''; has = false; } };
  const eof = q => new Incomplete(`unexpected EOF while looking for matching \`${q}'`);
  // Read the bodies of all here-documents opened on the line that just ended.
  const readDocs = () => {
    for (const hd of pendingDocs) {
      let body = '', done = false;
      while (i < src.length) {
        let nl = src.indexOf('\n', i);
        if (nl < 0) nl = src.length;
        let line = src.slice(i, nl);
        i = nl + 1;
        if (hd.strip) line = line.replace(/^\t+/, '');
        if (line === hd.delim) { done = true; break; }
        body += line + '\n';
      }
      if (!done) throw new Incomplete(`here-document delimited by end-of-file (wanted \`${hd.delim}')`);
      hd.body = body;
    }
    pendingDocs.length = 0;
  };
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') {
      if (src[i + 1] === '\n') { i += 2; continue; } // line continuation
      if (i + 1 >= src.length) throw new Incomplete('unexpected end of file after backslash');
      w += src.slice(i, i + 2); has = true; i += 2; continue;
    }
    if (c === "'") {
      const j = src.indexOf("'", i + 1);
      if (j < 0) throw eof("'");
      w += src.slice(i, j + 1); has = true; i = j + 1; continue;
    }
    if (c === '"') {
      let j = i + 1;
      while (j < src.length && src[j] !== '"') { if (src[j] === '\\') j++; j++; }
      if (j >= src.length) throw eof('"');
      w += src.slice(i, j + 1); has = true; i = j + 1; continue;
    }
    if (c === '$' && src[i + 1] === '(') {
      const j = matchParen(src, i + 1);
      if (j < 0) throw eof(')');
      w += src.slice(i, j + 1); has = true; i = j + 1; continue;
    }
    if (c === '$' && src[i + 1] === '{') {
      const j = src.indexOf('}', i + 2);
      if (j < 0) throw eof('}');
      w += src.slice(i, j + 1); has = true; i = j + 1; continue;
    }
    if (c === '`') {
      const j = src.indexOf('`', i + 1);
      if (j < 0) throw eof('`');
      w += src.slice(i, j + 1); has = true; i = j + 1; continue;
    }
    if (c === '\n') { push(); toks.push({ t: 'o', v: '\n' }); i++; if (pendingDocs.length) readDocs(); continue; }
    if (c === ' ' || c === '\t' || c === '\r') { push(); i++; continue; }
    if (c === '#' && !has) { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (!has && src.startsWith('((', i)) {
      const j = matchParen(src, i);
      if (j < 0) throw eof('))');
      if (src[j - 1] === ')' && j - 1 > i + 1) { toks.push({ t: 'arith', v: src.slice(i + 2, j - 1) }); i = j + 1; continue; }
    }
    if (!has && src.startsWith('[[', i) && /\s/.test(src[i + 2] ?? '\n')) {
      let j = i + 2, q = null;
      for (; j < src.length; j++) {
        const d = src[j];
        if (q) { if (d === '\\' && q === '"') j++; else if (d === q) q = null; continue; }
        if (d === '\\') { j++; continue; }
        if (d === "'" || d === '"') { q = d; continue; }
        if (/\s/.test(d) && src.startsWith(']]', j + 1) && !/[^\s;&|)]/.test(src[j + 3] ?? ' ')) break;
      }
      if (j >= src.length) throw eof(']]');
      toks.push({ t: 'dbr', v: src.slice(i + 2, j) });
      i = j + 3;
      continue;
    }
    const m = OPS.exec(src.slice(i));
    if (m && !(m[1][0] === '2' && has)) {
      push();
      const tok = { t: 'o', v: m[1] };
      toks.push(tok);
      i += m[1].length;
      if (tok.v === '<<' || tok.v === '<<-') {
        while (src[i] === ' ' || src[i] === '\t') i++;
        let j = i;
        while (j < src.length && !/[\s;&|<>()]/.test(src[j])) j++;
        const raw = src.slice(i, j);
        if (!raw) throw new SyntaxErr("syntax error near unexpected token `newline'");
        tok.hd = { delim: raw.replace(/['"\\]/g, ''), quoted: /['"\\]/.test(raw), strip: tok.v === '<<-', body: null };
        pendingDocs.push(tok.hd);
        i = j;
      }
      continue;
    }
    w += c; has = true; i++;
  }
  push();
  if (pendingDocs.length) throw new Incomplete(`here-document delimited by end-of-file (wanted \`${pendingDocs[0].delim}')`);
  return toks;
}

const REDIR_OPS = new Set(['>', '>>', '<', '2>', '2>>', '&>', '<<<']);
const CLOSERS = new Set(['then', 'elif', 'else', 'fi', 'do', 'done', 'esac', '}']);

// Recursive-descent parser producing an AST:
// list -> andor -> pipe -> simple | if | for | cfor | while | case | group | subshell | arith | dbr | funcdef
export function parse(toks) {
  let i = 0;
  const peek = () => toks[i];
  const isW = (t, v) => !!t && t.t === 'w' && t.v === v;
  const isO = (t, v) => !!t && t.t === 'o' && t.v === v;
  const unexpected = t => (t
    ? new SyntaxErr(`syntax error near unexpected token \`${t.v === '\n' ? 'newline' : t.t === 'arith' ? '((' : t.t === 'dbr' ? '[[' : t.v}'`)
    : new Incomplete('syntax error: unexpected end of file'));
  const skipNl = () => { while (isO(peek(), '\n')) i++; };
  const expectW = v => { skipNl(); if (!isW(peek(), v)) throw unexpected(peek()); i++; };
  const need = l => { if (!l.items.length) throw unexpected(peek()); return l; };
  const atEnd = (t, terms) => !t || isO(t, ')') || isO(t, ';;') || (t.t === 'w' && terms.includes(t.v));

  function list(terms = []) {
    const items = [];
    for (;;) {
      skipNl();
      if (atEnd(peek(), terms)) break;
      const node = andOr();
      const s = peek();
      if (s && s.t === 'o' && (s.v === ';' || s.v === '\n' || s.v === '&')) { i++; items.push({ node, bg: s.v === '&' }); continue; }
      items.push({ node, bg: false });
      if (atEnd(s, terms)) break;
      throw unexpected(s);
    }
    return { type: 'list', items };
  }
  function andOr() {
    const first = pipeline();
    const rest = [];
    while (isO(peek(), '&&') || isO(peek(), '||')) {
      const op = toks[i++].v;
      skipNl();
      rest.push({ op, pipe: pipeline() });
    }
    return { type: 'andor', first, rest };
  }
  function pipeline() {
    let bang = false;
    if (isW(peek(), '!')) { bang = true; i++; }
    const cmds = [command()];
    while (isO(peek(), '|')) { i++; skipNl(); cmds.push(command()); }
    return { type: 'pipe', cmds, bang };
  }
  function redirs(node) {
    for (;;) {
      const t = peek();
      if (!t || t.t !== 'o') break;
      if (t.v === '2>&1') { node.redirs.push({ op: '2>&1' }); i++; continue; }
      if (t.hd) { node.redirs.push({ op: '<<', hd: t.hd }); i++; continue; }
      if (!REDIR_OPS.has(t.v)) break;
      const n = toks[++i];
      if (!n || n.t !== 'w') throw unexpected(n);
      node.redirs.push({ op: t.v, target: n.v });
      i++;
    }
    return node;
  }
  function command() {
    const t = peek();
    if (!t) throw unexpected(t);
    if (t.t === 'arith') { i++; return redirs({ type: 'arith', expr: t.v, redirs: [] }); }
    if (t.t === 'dbr') { i++; return redirs({ type: 'dbr', expr: t.v, redirs: [] }); }
    if (isO(t, '(')) {
      i++;
      const body = need(list());
      if (!isO(peek(), ')')) throw unexpected(peek());
      i++;
      return redirs({ type: 'subshell', body, redirs: [] });
    }
    if (t.t === 'w') {
      if (CLOSERS.has(t.v)) throw unexpected(t);
      if (t.v === 'if') return redirs(ifCmd());
      if (t.v === 'for') return redirs(forCmd());
      if (t.v === 'while' || t.v === 'until') return redirs(whileCmd());
      if (t.v === 'case') return redirs(caseCmd());
      if (t.v === '{') { i++; const body = need(list(['}'])); expectW('}'); return redirs({ type: 'group', body, redirs: [] }); }
      if (t.v === 'function') {
        i++;
        const n = peek();
        if (!n || n.t !== 'w') throw unexpected(n);
        i++;
        if (isO(peek(), '(')) { i++; if (!isO(peek(), ')')) throw unexpected(peek()); i++; }
        return funcBody(n.v);
      }
      if (isO(toks[i + 1], '(') && isO(toks[i + 2], ')')) { i += 3; return funcBody(t.v); }
    }
    return simple();
  }
  function funcBody(name) {
    if (!/^[^\s'"\\$`/=]+$/.test(name) || /^\d+$/.test(name)) throw new SyntaxErr(`\`${name}': not a valid identifier`);
    skipNl();
    const body = command();
    if (body.type === 'simple') throw new SyntaxErr(`syntax error near unexpected token \`${body.words[0] ?? 'newline'}'`);
    return { type: 'funcdef', name, body };
  }
  function simple() {
    const node = { type: 'simple', words: [], redirs: [] };
    for (;;) {
      const t = peek();
      if (!t) break;
      if (t.t === 'w') { node.words.push(t.v); i++; continue; }
      if (t.t === 'o' && (REDIR_OPS.has(t.v) || t.v === '2>&1' || t.hd)) { redirs(node); continue; }
      break;
    }
    if (!node.words.length && !node.redirs.length) throw unexpected(peek());
    return node;
  }
  function ifCmd() {
    i++;
    const clauses = [];
    let elseBody = null;
    for (;;) {
      const cond = need(list(['then']));
      expectW('then');
      const body = need(list(['elif', 'else', 'fi']));
      clauses.push({ cond, body });
      if (isW(peek(), 'elif')) { i++; continue; }
      if (isW(peek(), 'else')) { i++; elseBody = need(list(['fi'])); }
      expectW('fi');
      return { type: 'if', clauses, else: elseBody, redirs: [] };
    }
  }
  function forCmd() {
    i++;
    const t = peek();
    if (t && t.t === 'arith') {
      i++;
      const parts = t.v.split(';');
      if (parts.length !== 3) throw new SyntaxErr('syntax error: arithmetic expression required');
      if (isO(peek(), ';') || isO(peek(), '\n')) i++;
      expectW('do');
      const body = need(list(['done']));
      expectW('done');
      return { type: 'cfor', init: parts[0], cond: parts[1], step: parts[2], body, redirs: [] };
    }
    if (!t || t.t !== 'w') throw unexpected(t);
    if (!/^[A-Za-z_]\w*$/.test(t.v)) throw new SyntaxErr(`\`${t.v}': not a valid identifier`);
    i++;
    let words = null;
    skipNl();
    if (isW(peek(), 'in')) { i++; words = []; while (peek() && peek().t === 'w') words.push(toks[i++].v); }
    if (isO(peek(), ';') || isO(peek(), '\n')) i++;
    expectW('do');
    const body = need(list(['done']));
    expectW('done');
    return { type: 'for', name: t.v, words, body, redirs: [] };
  }
  function whileCmd() {
    const until = toks[i++].v === 'until';
    const cond = need(list(['do']));
    expectW('do');
    const body = need(list(['done']));
    expectW('done');
    return { type: 'while', until, cond, body, redirs: [] };
  }
  function caseCmd() {
    i++;
    const w = peek();
    if (!w || w.t !== 'w') throw unexpected(w);
    i++;
    expectW('in');
    const items = [];
    for (;;) {
      skipNl();
      const t = peek();
      if (!t) throw unexpected(t);
      if (isW(t, 'esac')) { i++; break; }
      if (isO(t, '(')) i++;
      const pats = [];
      for (;;) {
        const p = peek();
        if (!p || p.t !== 'w') throw unexpected(p);
        pats.push(p.v);
        i++;
        if (isO(peek(), '|')) { i++; continue; }
        break;
      }
      if (!isO(peek(), ')')) throw unexpected(peek());
      i++;
      const body = list(['esac']);
      items.push({ pats, body });
      if (isO(peek(), ';;')) { i++; continue; }
      skipNl();
      if (isW(peek(), 'esac')) { i++; break; }
      throw unexpected(peek());
    }
    return { type: 'case', word: w.v, items, redirs: [] };
  }

  const root = list();
  if (i < toks.length) throw unexpected(toks[i]);
  return root;
}

function braceExpand(s) {
  const open = s.indexOf(P['{']);
  if (open < 0) return [s];
  let depth = 0, close = -1;
  const commas = [];
  for (let i = open; i < s.length; i++) {
    if (s[i] === P['{']) depth++;
    else if (s[i] === P['}']) { if (--depth === 0) { close = i; break; } }
    else if (s[i] === P[','] && depth === 1) commas.push(i);
  }
  const literal = () => {
    // Not a valid brace expression: keep this brace literal and continue behind it.
    const rest = braceExpand(s.slice(open + 1));
    return rest.map(r => s.slice(0, open) + '{' + r);
  };
  if (close < 0) return literal();
  const pre = s.slice(0, open), post = s.slice(close + 1), inner = s.slice(open + 1, close);
  let parts;
  if (commas.length) {
    parts = [];
    let last = open + 1;
    for (const c of [...commas, close]) { parts.push(s.slice(last, c)); last = c + 1; }
  } else {
    let m = /^(-?\d+)\.\.(-?\d+)$/.exec(inner);
    if (m) {
      const a = +m[1], b = +m[2], step = a <= b ? 1 : -1;
      parts = [];
      if (Math.abs(b - a) >= MAX_WORDS) throw new ExpandErr(`brace expansion: too many words (max ${MAX_WORDS})`);
      for (let n = a; step > 0 ? n <= b : n >= b; n += step) parts.push(String(n));
    } else if ((m = /^([a-zA-Z])\.\.([a-zA-Z])$/.exec(inner))) {
      const a = m[1].charCodeAt(0), b = m[2].charCodeAt(0), step = a <= b ? 1 : -1;
      parts = [];
      for (let n = a; step > 0 ? n <= b : n >= b; n += step) parts.push(String.fromCharCode(n));
    } else return literal();
  }
  return parts.flatMap(p => braceExpand(pre + p + post));
}

function segRe(seg) {
  let re = '^';
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i];
    if (c === P['*']) re += '.*';
    else if (c === P['?']) re += '.';
    else if (c === P['[']) {
      const j = seg.indexOf(']', i + 2);
      if (j < 0) re += '\\[';
      else {
        let body = restore(seg.slice(i + 1, j));
        if (body[0] === '!') body = '^' + body.slice(1);
        re += '[' + body.replace(/\\/g, '\\\\') + ']';
        i = j;
      }
    } else re += restore(c).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(re + '$');
}

export class Shell {
  constructor(saved) {
    const s = saved || {};
    this.fs = new VFS(s.root || buildWorld());
    if (Number.isInteger(s.umask)) this.fs.umask = s.umask & 0o777;
    this.cwd = s.cwd || '/home/hacker';
    // Null-prototype maps: variable and alias names come from the user.
    const dict = o => Object.assign(Object.create(null), o);
    this.env = dict(s.env || {
      USER: 'hacker', HOME: '/home/hacker', SHELL: '/bin/bash', HOSTNAME: 'box',
      PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'en_US.UTF-8', TERM: 'xterm-256color',
      EDITOR: 'nano', PWD: '/home/hacker',
    });
    this.exported = new Set(s.exported || Object.keys(this.env));
    this.aliases = dict(s.aliases || { ll: 'ls -la', la: 'ls -A' });
    this.history = s.history || [];
    this.procs = s.procs || initialProcs();
    this.nextPid = s.nextPid || 2100;
    this.flags = dict(s.flags || {});
    this.funcs = dict(s.funcs || {});
    this.pending = null; // unfinished multi-line input
    this.loopDepth = 0;
    this.funcDepth = 0;
    this.frames = []; // saved variables for `local`, one map per function call
    this.budget = { steps: 0, loops: 0, t0: Date.now() };
    this.lastCode = 0;
    this.argv = ['bash'];
    this.cols = 80;
    this.depth = 0;
    this.request = null; // UI side effects: { type: 'editor'|'matrix'|'theme'|'reboot'|'reset', ... }
    this.cmdLog = [];
    this.screen = []; // default sink when no UI is attached
    this.write = (text, kind) => this.screen.push({ text, kind });
    if (!this.fs.tryLookup(this.cwd)) this.cwd = '/';
    this.installBinaries();
  }

  // Populate /usr/bin with stubs so that ls /bin, which and file behave sensibly.
  installBinaries() {
    const bin = this.fs.root.c.usr.c.bin;
    for (const name of Object.keys(commands)) {
      if (BUILTINS.has(name) || bin.c[name]) continue;
      bin.c[name] = { t: 'f', d: ELF, m: 0o755, o: 'root', g: 'root', mt: bin.mt };
    }
  }

  serialize() {
    return {
      root: this.fs.root, cwd: this.cwd, env: this.env, exported: [...this.exported],
      aliases: this.aliases, history: this.history.slice(-500), procs: this.procs,
      nextPid: this.nextPid, flags: this.flags, umask: this.fs.umask, funcs: this.funcs,
    };
  }

  prompt() {
    if (this.pending !== null) return '> ';
    const home = this.env.HOME || '';
    let p = this.cwd;
    if (home && (p === home || p.startsWith(home + '/'))) p = '~' + p.slice(home.length);
    return `\x1b[1;32m${this.fs.user}@box\x1b[0m:\x1b[1;34m${p}\x1b[0m$ `;
  }

  getVar(k) {
    if (k === '?') return String(this.lastCode);
    if (k === '$') return '2048';
    if (k === '#') return String(this.argv.length - 1);
    if (k === '@' || k === '*') return this.argv.slice(1).join(' ');
    if (/^\d$/.test(k)) return this.argv[+k] ?? '';
    if (k === 'PWD') return this.cwd;
    if (k === 'RANDOM') return String(Math.floor(Math.random() * 32768));
    return this.env[k] ?? '';
  }

  arith(expr) {
    // Command substitutions and nested $((..)) inside the expression come first.
    let pre = '';
    for (let i = 0; i < expr.length;) {
      if (expr[i] === '$' && expr[i + 1] === '(') { const [t, n] = this.dollar(expr, i); pre += t; i = n; }
      else if (expr[i] === '`') {
        const j = expr.indexOf('`', i + 1);
        if (j < 0) { pre += expr.slice(i); break; }
        pre += this.capture(expr.slice(i + 1, j)); i = j + 1;
      } else pre += expr[i++];
    }
    expr = pre;
    const src = expr.replace(/\$\{?([A-Za-z_]\w*|[?#$0-9])\}?/g, (m, k) => this.getVar(k) || '0');
    try {
      const vars = {};
      for (const k in this.env) vars[k] = this.env[k];
      const res = calc(src, { vars, int: true });
      for (const k in res.vars) {
        const v = res.vars[k];
        if (typeof v === 'number' && String(v) !== this.env[k] && !['NR', 'NF'].includes(k)) this.env[k] = String(Math.trunc(v));
      }
      return String(Math.trunc(res.value));
    } catch (e) {
      this.write(`bash: ${expr}: syntax error in expression\n`, 'err');
      return '0';
    }
  }

  // Run a command line and return its stdout (for $(...) and backticks).
  capture(src) {
    let out = '';
    this.runLine(src, { stdin: null, tty: false, out: s => { out += s; }, err: s => this.write(s, 'err') });
    return out.replace(/\n+$/, '');
  }

  dollar(raw, i) {
    const n = raw[i + 1];
    if (n === '(') {
      const j = matchParen(raw, i + 1);
      if (j < 0) return ['$', i + 1];
      const inner = raw.slice(i + 2, j);
      if (inner.startsWith('(') && inner.endsWith(')')) return [this.arith(inner.slice(1, -1)), j + 1];
      return [this.capture(inner), j + 1];
    }
    if (n === '{') {
      const j = raw.indexOf('}', i + 2);
      if (j < 0) return ['$', i + 1];
      const body = raw.slice(i + 2, j);
      let m;
      if ((m = /^#(\w+)$/.exec(body))) return [String(this.getVar(m[1]).length), j + 1];
      if ((m = /^(\w+):-(.*)$/.exec(body))) return [this.getVar(m[1]) || m[2], j + 1];
      return [this.getVar(body), j + 1];
    }
    const m = /^([A-Za-z_]\w*|[?$#@*0-9])/.exec(raw.slice(i + 1));
    if (!m) return ['$', i + 1];
    return [this.getVar(m[1]), i + 1 + m[1].length];
  }

  // Expand one raw word into zero or more fields.
  // keepGlob returns the unsplit word with glob placeholders intact (for patterns).
  expand(raw, split = true, keepGlob = false) {
    // "$@" with no positional parameters expands to no word at all.
    if (split && (raw === '"$@"' || raw === '"${@}"') && this.argv.length <= 1) return [];
    const fields = [];
    let cur = '', has = false;
    const unquoted = txt => {
      if (!split) { cur += txt; has = true; return; }
      txt.split(/\s+/).forEach((p, idx) => {
        if (idx > 0) { if (has) fields.push(cur); cur = ''; has = false; }
        if (p) { cur += p; has = true; }
      });
    };
    let i = 0;
    while (i < raw.length) {
      const c = raw[i];
      if (c === '\\') { cur += raw[i + 1] ?? ''; has = true; i += 2; continue; }
      if (c === "'") {
        const j = raw.indexOf("'", i + 1);
        cur += raw.slice(i + 1, j); has = true; i = j + 1; continue;
      }
      if (c === '"') {
        i++;
        while (i < raw.length && raw[i] !== '"') {
          const q = raw[i];
          if (q === '\\' && '"\\$`'.includes(raw[i + 1])) { cur += raw[i + 1]; i += 2; }
          else if (split && q === '$' && (raw.startsWith('$@', i) || raw.startsWith('${@}', i))) {
            // "$@" keeps every positional parameter as its own word.
            this.argv.slice(1).forEach((a, k) => { if (k > 0) { fields.push(cur); cur = ''; } cur += a; });
            i += raw.startsWith('$@', i) ? 2 : 4;
          }
          else if (q === '$') { const [t, n] = this.dollar(raw, i); cur += t; i = n; }
          else if (q === '`') { const j = raw.indexOf('`', i + 1); cur += this.capture(raw.slice(i + 1, j)); i = j + 1; }
          else { cur += q; i++; }
        }
        has = true; i++; continue;
      }
      if (c === '$') { const [t, n] = this.dollar(raw, i); unquoted(t); i = n; continue; }
      if (c === '`') { const j = raw.indexOf('`', i + 1); unquoted(this.capture(raw.slice(i + 1, j))); i = j + 1; continue; }
      if (c === '~' && i === 0 && (raw.length === 1 || raw[1] === '/')) { cur += this.env.HOME || '/'; has = true; i++; continue; }
      cur += P[c] || c; has = true; i++;
    }
    if (has) fields.push(cur);
    if (!split) { const s = fields.join(' '); return [keepGlob ? s : restore(s)]; }
    const braced = fields.flatMap(f => braceExpand(f));
    if (braced.length > MAX_WORDS) throw new ExpandErr(`brace expansion: too many words (max ${MAX_WORDS})`);
    return braced.flatMap(f => (HAS_GLOB.test(f) ? this.glob(f) : [restore(f)]));
  }

  glob(word) {
    const abs = word.startsWith('/');
    const segs = word.split('/').filter(s => s !== '');
    const trailing = word.endsWith('/') && segs.length;
    const join = (dd, n) => (dd === '' ? n : dd.endsWith('/') ? dd + n : dd + '/' + n);
    let cur = [{ disp: abs ? '/' : '', path: abs ? '/' : this.cwd }];
    for (const seg of segs) {
      const next = [];
      for (const c of cur) {
        if (!HAS_GLOB.test(seg)) {
          const name = restore(seg);
          const p = normalize(name, c.path);
          if (this.fs.tryLookup(p)) next.push({ disp: join(c.disp, name), path: p });
          continue;
        }
        let names;
        try { names = this.fs.readdir(c.path); } catch { continue; }
        const re = segRe(seg);
        const dot = seg[0] === '.';
        for (const n of names) {
          if ((dot || n[0] !== '.') && re.test(n)) next.push({ disp: join(c.disp, n), path: normalize(n, c.path) });
        }
      }
      cur = next;
      if (!cur.length) break;
    }
    return cur.length ? cur.map(c => c.disp + (trailing ? '/' : '')) : [restore(word)];
  }

  pushHistory(src) {
    if (src.trim() && this.history[this.history.length - 1] !== src) this.history.push(src);
  }

  // Entry point for interactive input. Unfinished input (e.g. `for x in a b; do`) is kept
  // in this.pending and the prompt switches to "> " until the construct is complete.
  run(line) {
    this.cmdLog = [];
    this.request = null;
    let stdout = '';
    const io = {
      in: null, tty: true,
      out: s => { stdout += s; this.write(s, 'out'); },
      err: s => this.write(s, 'err'),
    };
    if (this.pending === null && /(^|[\s;&|])!!/.test(line) && this.history.length) {
      line = line.replace(/!!/g, this.history[this.history.length - 1]);
      this.write(line + '\n', 'out');
    }
    const src = this.pending !== null ? this.pending + '\n' + line : line;
    let tree;
    try { tree = parse(lex(src)); } catch (e) {
      if (!(e instanceof SyntaxErr)) throw e;
      if (e instanceof Incomplete && src.trim()) {
        this.pending = src;
        return { line, code: this.lastCode, cmds: [], stdout: '', incomplete: true };
      }
      this.pending = null;
      this.pushHistory(src);
      io.err(`bash: ${e.message}\n`);
      this.lastCode = 2;
      return { line: src, code: 2, cmds: [], stdout: '' };
    }
    this.pending = null;
    this.pushHistory(src);
    this.budget = { steps: 0, loops: 0, t0: Date.now() };
    let code;
    try { code = this.exec(tree, io); } catch (sig) {
      if (sig instanceof LimitSig) { io.err(`bash: ${sig.msg}\n`); code = 130; }
      else if (sig instanceof ReturnSig) code = sig.n;
      else if (sig instanceof Signal) code = 0;
      else throw sig;
    } finally {
      this.loopDepth = 0;
      this.funcDepth = 0;
      this.frames = [];
    }
    this.exiting = false;
    this.lastCode = code;
    return { line: src, code, cmds: this.cmdLog, stdout: stdout.replace(/\x1b\[[\d;]*m/g, '') };
  }

  // Parse and run source text (used by $(...)); syntax errors are reported, not thrown.
  runLine(src, io) {
    let tree;
    try { tree = parse(lex(src)); } catch (e) {
      if (!(e instanceof SyntaxErr)) throw e;
      io.err(`bash: ${e.message}\n`);
      return (this.lastCode = 2);
    }
    return this.exec(tree, this.normIo(io));
  }

  // Older callers pass { stdin: string }; the interpreter reads through a shared cursor.
  normIo(io) {
    if (io.in !== undefined) return io;
    return { ...io, in: typeof io.stdin === 'string' ? { text: io.stdin, pos: 0 } : null };
  }

  tick(loop = false) {
    const b = this.budget;
    if (++b.steps > LIMITS.steps) throw new LimitSig(`Abbruch: mehr als ${LIMITS.steps} Befehle in einer Eingabe (Endlosschleife?)`);
    if (loop && ++b.loops > LIMITS.loops) throw new LimitSig(`Abbruch: mehr als ${LIMITS.loops} Schleifendurchlaeufe (Endlosschleife?)`, true);
    if ((b.steps & 63) === 0 && Date.now() - b.t0 > LIMITS.ms) throw new LimitSig(`Abbruch: Eingabe lief laenger als ${LIMITS.ms / 1000} Sekunden`);
  }

  exec(node, io) {
    if (node.type === 'list') {
      let code = 0;
      for (const it of node.items) {
        code = this.exec(it.node, io);
        if (this.exiting) break;
      }
      return code;
    }
    if (node.type === 'andor') {
      let code = (this.lastCode = this.runPipe(node.first, io));
      for (const r of node.rest) {
        if (this.exiting) break;
        if ((r.op === '&&') === (code === 0)) code = this.lastCode = this.runPipe(r.pipe, io);
      }
      return code;
    }
    return this.runCommand(node, io);
  }

  runPipe(p, io) {
    let input = io.in, code = 0;
    p.cmds.forEach((cmd, idx) => {
      const last = idx === p.cmds.length - 1;
      let buf = '';
      const sub = { in: input, out: last ? io.out : s => { buf += s; }, err: io.err, tty: last && io.tty };
      try { code = this.runCommand(cmd, sub); } catch (sig) {
        // A runaway loop feeding a pipe (while true; do echo y; done | head) is stopped and
        // its output so far is handed on, roughly like SIGPIPE in a real shell.
        if (last || !(sig instanceof LimitSig) || !sig.soft) throw sig;
        io.err(`bash: Hinweis: ${sig.msg.replace(/^Abbruch: /, '')} - Ausgabe bis hierhin wird weitergereicht\n`);
        // Only the loop counter restarts; steps and time keep counting, so nested
        // pipelines cannot renew the budget forever.
        this.budget.loops = 0;
        code = 141;
      }
      input = { text: buf, pos: 0 };
    });
    return p.bang ? (code ? 0 : 1) : code;
  }

  runCommand(node, io) {
    this.tick();
    if (node.type === 'simple') return this.runSimple(node, io);
    if (node.type === 'funcdef') {
      this.funcs[node.name] = node.body;
      this.cmdLog.push({ name: 'function', args: [node.name], code: 0 });
      return 0;
    }
    const code = this.withRedirs(node.redirs, io, io2 => this.runCompound(node, io2));
    const kw = { if: 'if', for: 'for', cfor: 'for', while: node.until ? 'until' : 'while', case: 'case', dbr: '[[', arith: '((' }[node.type];
    if (kw) this.cmdLog.push({ name: kw, args: [], code });
    return code;
  }

  // Run `body` as a loop body; returns 'break', 'continue' or nothing.
  loopStep(body, io) {
    try { this.lastCode = this.exec(body, io); } catch (sig) {
      if (!(sig instanceof BreakSig || sig instanceof ContinueSig)) throw sig;
      if (sig.n > 1) { sig.n--; throw sig; }
      return sig instanceof BreakSig ? 'break' : 'continue';
    }
    return this.exiting ? 'break' : null;
  }

  loop(fn) {
    this.loopDepth++;
    try { return fn(); } finally { this.loopDepth--; }
  }

  runCompound(node, io) {
    switch (node.type) {
      case 'group': return this.exec(node.body, io);
      case 'subshell': {
        const saved = { cwd: this.cwd, env: this.env, exported: this.exported, funcs: this.funcs, aliases: this.aliases, umask: this.fs.umask };
        this.env = Object.assign(Object.create(null), this.env);
        this.exported = new Set(this.exported);
        this.funcs = Object.assign(Object.create(null), this.funcs);
        this.aliases = Object.assign(Object.create(null), this.aliases);
        this.depth++;
        try { return this.exec(node.body, io); } finally {
          Object.assign(this, { cwd: saved.cwd, env: saved.env, exported: saved.exported, funcs: saved.funcs, aliases: saved.aliases });
          this.fs.umask = saved.umask;
          this.depth--;
          this.exiting = false;
        }
      }
      case 'if': {
        for (const cl of node.clauses) {
          const c = this.exec(cl.cond, io);
          if (this.exiting) return c;
          if (c === 0) return this.exec(cl.body, io);
        }
        return node.else ? this.exec(node.else, io) : 0;
      }
      case 'for': return this.loop(() => {
        const words = node.words === null ? this.argv.slice(1) : node.words.flatMap(w => this.expand(w));
        this.lastCode = 0;
        for (const v of words) {
          this.tick(true);
          this.env[node.name] = v;
          if (this.loopStep(node.body, io) === 'break') break;
        }
        return this.lastCode;
      });
      case 'cfor': return this.loop(() => {
        if (node.init.trim()) this.arith(node.init);
        this.lastCode = 0;
        for (;;) {
          this.tick(true);
          if (node.cond.trim() && this.arith(node.cond) === '0') break;
          if (this.loopStep(node.body, io) === 'break') break;
          if (node.step.trim()) this.arith(node.step);
        }
        return this.lastCode;
      });
      case 'while': return this.loop(() => {
        let code = 0;
        for (;;) {
          this.tick(true);
          const c = this.exec(node.cond, io);
          if (this.exiting || (c === 0) === node.until) break;
          const r = this.loopStep(node.body, io);
          code = this.lastCode;
          if (r === 'break') break;
        }
        return code;
      });
      case 'case': {
        let w;
        try { w = this.expand(node.word, false)[0]; } catch (e) { if (e instanceof ExpandErr) { io.err(`bash: ${e.message}\n`); return 1; } throw e; }
        for (const it of node.items) {
          if (it.pats.some(pt => this.patternRe(pt).test(w))) return this.exec(it.body, io);
        }
        return 0;
      }
      case 'arith': return this.arith(node.expr) === '0' ? 1 : 0;
      case 'dbr': return this.evalDbr(node.expr, io);
      default: throw new Error(`unknown node ${node.type}`);
    }
  }

  // Glob pattern (case, [[ == ]]) as an anchored regex; quoted parts match literally.
  patternRe(raw) {
    const s = this.expand(raw, false, true)[0];
    return segRe(s);
  }

  // [[ ... ]]: no word splitting or globbing; == and != match patterns, =~ a regex.
  evalDbr(src, io) {
    let toks;
    try { toks = lex(src).filter(t => !(t.t === 'o' && t.v === '\n')); } catch {
      io.err('bash: syntax error in conditional expression\n'); return 2;
    }
    let i = 0;
    const val = t => this.expand(t.v, false)[0];
    const pv = () => toks[i] && toks[i].v;
    const BIN = /^(==|=|!=|=~|-eq|-ne|-lt|-le|-gt|-ge|-nt|-ot)$/;
    const prim = () => {
      const t = toks[i];
      if (!t) throw new SyntaxErr('unexpected end of expression');
      if (t.t === 'o' && t.v === '(') {
        i++;
        const v = or();
        if (pv() !== ')') throw new SyntaxErr("expected `)'");
        i++;
        return v;
      }
      const a = toks[i + 1];
      if (t.t === 'w' && a && ((a.t === 'w' && BIN.test(a.v)) || (a.t === 'o' && (a.v === '<' || a.v === '>')))) {
        const r = toks[i + 2];
        if (!r || r.t !== 'w') throw new SyntaxErr(`unexpected argument to \`${a.v}'`);
        i += 3;
        const l = val(t), op = a.v;
        if (op === '==' || op === '=' || op === '!=') { const m = this.patternRe(r.v).test(l); return op === '!=' ? !m : m; }
        if (op === '=~') {
          let re;
          try { re = new RegExp(val(r)); } catch { throw new SyntaxErr('invalid regular expression'); }
          const m = re.exec(l);
          this.env.BASH_REMATCH = m ? m[0] : '';
          return !!m;
        }
        if (op === '<') return l < val(r);
        if (op === '>') return l > val(r);
        return this.testQuiet([l, op, val(r)]);
      }
      if (t.t === 'w' && /^-[a-zA-Z]$/.test(t.v) && a && a.t === 'w') { i += 2; return this.testQuiet([t.v, val(a)]); }
      if (t.t === 'w') { i++; return val(t) !== ''; }
      throw new SyntaxErr(`unexpected token \`${t.v}'`);
    };
    const not = () => { if (toks[i] && toks[i].t === 'w' && toks[i].v === '!') { i++; return !not(); } return prim(); };
    const and = () => { let v = not(); while (pv() === '&&') { i++; const r = not(); v = v && r; } return v; };
    const or = () => { let v = and(); while (pv() === '||') { i++; const r = and(); v = v || r; } return v; };
    try {
      const v = or();
      if (i < toks.length) throw new SyntaxErr(`unexpected token \`${toks[i].v}'`);
      return v ? 0 : 1;
    } catch (e) {
      if (e instanceof SyntaxErr || e instanceof ExpandErr) { io.err(`bash: conditional expression: ${e.message}\n`); return 2; }
      throw e;
    }
  }

  testQuiet(args) {
    const ctx = { name: 'test', args, stdin: null, out: () => {}, err: () => {}, tty: false, io: {}, sh: this, fs: this.fs, p: x => normalize(x, this.cwd), fail: 0 };
    return commands.test(ctx) === 0;
  }

  // Here-document body: parameter, command and arithmetic expansion only.
  expandHeredoc(body) {
    let out = '', i = 0;
    while (i < body.length) {
      const q = body[i];
      if (q === '\\' && '$`\\'.includes(body[i + 1])) { out += body[i + 1]; i += 2; }
      else if (q === '$') { const [t, n] = this.dollar(body, i); out += t; i = n; }
      else if (q === '`') {
        const j = body.indexOf('`', i + 1);
        if (j < 0) { out += q; i++; } else { out += this.capture(body.slice(i + 1, j)); i = j + 1; }
      } else { out += q; i++; }
    }
    return out;
  }

  // Apply redirections, then call fn with the adjusted io.
  withRedirs(redirs, io, fn) {
    let { in: input, out, err, tty } = io;
    try {
      for (const r of redirs) {
        if (r.op === '2>&1') { err = out; continue; }
        if (r.op === '<<') { input = { text: r.hd.quoted ? r.hd.body : this.expandHeredoc(r.hd.body), pos: 0 }; continue; }
        const target = this.expand(r.target, false)[0];
        if (r.op === '<<<') { input = { text: target + '\n', pos: 0 }; continue; }
        const path = normalize(target, this.cwd);
        if (r.op === '<') { input = { text: this.fs.readFile(path), pos: 0 }; continue; }
        this.fs.writeFile(path, '', r.op.endsWith('>>'));
        const sink = s => { try { this.fs.writeFile(path, s, true); } catch { /* target vanished */ } };
        if (r.op[0] === '2') err = sink;
        else if (r.op === '&>') { out = sink; err = sink; tty = false; }
        else { out = sink; tty = false; }
      }
    } catch (e) {
      if (e instanceof ExpandErr) { io.err(`bash: ${e.message}\n`); return 1; }
      if (!(e instanceof FsError)) throw e;
      const r = redirs.find(x => x.target);
      io.err(`bash: ${r ? restore(r.target) : ''}: ${e.message}\n`);
      return 1;
    }
    return fn({ in: input, out, err, tty });
  }

  runSimple(cmd, io) {
    let words = [...cmd.words];
    if (words.length && Object.hasOwn(this.aliases, words[0])) {
      const al = lex(this.aliases[words[0]]).filter(t => t.t === 'w').map(t => t.v);
      words = [...al, ...words.slice(1)];
    }
    const assigns = [];
    while (words.length && /^[A-Za-z_]\w*\+?=/.test(words[0])) assigns.push(words.shift());
    let argv;
    try { argv = words.flatMap(w => this.expand(w)); } catch (e) {
      if (e instanceof ExpandErr) { io.err(`bash: ${e.message}\n`); return 1; }
      throw e;
    }
    return this.withRedirs(cmd.redirs, io, io2 => {
      const saved = Object.create(null);
      for (const a of assigns) {
        const eq = a.indexOf('=');
        const append = a[eq - 1] === '+';
        const k = a.slice(0, append ? eq - 1 : eq);
        if (argv.length) saved[k] = this.env[k];
        const v = this.expand(a.slice(eq + 1), false)[0] ?? '';
        this.env[k] = append ? (this.env[k] ?? '') + v : v;
      }
      if (!argv.length) return 0;
      try {
        return this.execArgv(argv, io2);
      } finally {
        for (const k in saved) { if (saved[k] === undefined) delete this.env[k]; else this.env[k] = saved[k]; }
      }
    });
  }

  // Execute an already expanded argument vector.
  execArgv(argv, io) {
    const name = argv[0];
    if (name.includes('/')) return this.execFile(name, argv, io);
    if (Object.hasOwn(this.funcs, name)) return this.callFunc(name, argv, io);
    const fn = commands[name];
    if (!fn) {
      io.err(`bash: ${name}: command not found\n`);
      this.cmdLog.push({ name, args: argv.slice(1), code: 127 });
      return 127;
    }
    // stdin is read lazily: only commands that actually read it consume the shared input
    // (so `while read l; do echo "$l"; done < f` sees every line).
    let stdinVal, stdinRead = false;
    const ctx = {
      name, args: argv.slice(1), out: io.out, err: io.err, tty: io.tty, io,
      sh: this, fs: this.fs, p: x => normalize(x, this.cwd), fail: 0,
      get stdin() {
        if (!stdinRead) {
          stdinRead = true;
          if (io.stdin !== undefined) stdinVal = io.stdin;
          else if (!io.in) stdinVal = null;
          else { stdinVal = io.in.text.slice(io.in.pos); io.in.pos = io.in.text.length; }
        }
        return stdinVal;
      },
    };
    let code;
    try { code = fn(ctx); } catch (e) {
      if (e instanceof Signal) throw e;
      if (e instanceof Usage) { io.err(`${name}: ${e.message}\nTry 'man ${name}' for more information.\n`); code = 2; }
      else if (e instanceof FsError) { io.err(`${name}: ${e.message}\n`); code = 1; }
      else { io.err(`${name}: internal error: ${e.message}\n`); code = 70; }
    }
    code = code ?? (ctx.fail ? 1 : 0);
    this.cmdLog.push({ name, args: ctx.args, code });
    return code;
  }

  callFunc(name, argv, io) {
    // Abort the whole input instead of returning: a fork bomb like :(){ :|:& };: would
    // otherwise print thousands of errors before the step limit stops it.
    if (this.funcDepth >= LIMITS.funcDepth) throw new LimitSig(`${name}: maximum function nesting level exceeded (${LIMITS.funcDepth})`);
    const savedArgv = this.argv;
    this.argv = [savedArgv[0], ...argv.slice(1)];
    this.funcDepth++;
    this.frames.push(Object.create(null));
    let code;
    try { code = this.runCommand(this.funcs[name], this.normIo(io)); } catch (sig) {
      if (sig instanceof ReturnSig) code = sig.n; else throw sig;
    } finally {
      const frame = this.frames.pop();
      for (const k of Object.keys(frame)) { if (frame[k] === undefined) delete this.env[k]; else this.env[k] = frame[k]; }
      this.funcDepth--;
      this.argv = savedArgv;
    }
    this.cmdLog.push({ name, args: argv.slice(1), code, func: true });
    return code;
  }

  execFile(name, argv, io) {
    const path = normalize(name, this.cwd);
    let node;
    try { node = this.fs.lookup(path); } catch (e) {
      io.err(`bash: ${name}: ${e.message}\n`);
      return e.code === 'EACCES' ? 126 : 127;
    }
    if (node.t === 'd') { io.err(`bash: ${name}: Is a directory\n`); return 126; }
    if (!(node.m & 0o111) || !this.fs.can(node, 'x')) { io.err(`bash: ${name}: Permission denied\n`); return 126; }
    if (node.d.startsWith(ELF)) {
      const base = baseName(path);
      if (commands[base]) return this.execArgv([base, ...argv.slice(1)], io);
      io.err(`bash: ${name}: cannot execute binary file: Exec format error\n`);
      return 126;
    }
    const code = this.runScript(node.d, argv, io);
    this.cmdLog.push({ name, args: argv.slice(1), code, script: true });
    return code;
  }

  // Run a whole script (multi-line constructs allowed) with its own positional parameters.
  runScript(text, argv, io) {
    if (this.depth >= 8) { io.err('bash: maximum script nesting level exceeded\n'); return 1; }
    let tree;
    try { tree = parse(lex(text)); } catch (e) {
      if (!(e instanceof SyntaxErr)) throw e;
      io.err(`bash: ${argv[0]}: ${e.message}\n`);
      return 2;
    }
    const saved = { argv: this.argv, loopDepth: this.loopDepth };
    this.argv = argv;
    this.loopDepth = 0;
    this.depth++;
    let code = 0;
    try { code = this.exec(tree, this.normIo(io)); } catch (sig) {
      if (sig instanceof ReturnSig) code = sig.n;
      else if (sig instanceof BreakSig || sig instanceof ContinueSig) code = 0;
      else throw sig;
    } finally {
      this.depth--;
      this.argv = saved.argv;
      this.loopDepth = saved.loopDepth;
      this.exiting = false; // `exit` only leaves the innermost script
    }
    return code;
  }

  // Tab completion. Returns { line, options }.
  complete(line) {
    const m = /(?:^|\s)(\S*)$/.exec(line);
    const word = m ? m[1] : '';
    const head = line.slice(0, line.length - word.length);
    const first = !/\S/.test(head) || /[|;&]\s*$/.test(head);
    let options;
    let prefix = '';
    let base = word;
    if (first && !word.includes('/')) {
      options = [...new Set([...Object.keys(commands), ...Object.keys(this.aliases)])]
        .filter(n => n.startsWith(word) && n !== '[' && n !== '.').sort().map(n => ({ n, suffix: ' ' }));
    } else {
      const slash = word.lastIndexOf('/');
      prefix = word.slice(0, slash + 1);
      base = word.slice(slash + 1);
      let dir = prefix || '.';
      if (dir.startsWith('~')) dir = (this.env.HOME || '/') + dir.slice(1);
      const abs = normalize(dir, this.cwd);
      let names = [];
      try { names = this.fs.readdir(abs); } catch { /* unreadable */ }
      options = names.filter(n => n.startsWith(base) && (base.startsWith('.') || n[0] !== '.')).map(n => {
        const node = this.fs.tryLookup(normalize(n, abs));
        return { n, suffix: node && node.t === 'd' ? '/' : ' ' };
      });
    }
    if (!options.length) return { line, options: [] };
    const esc = s => s.replace(/([ '"\\$*?()&|;<>])/g, '\\$1');
    if (options.length === 1) return { line: head + prefix + esc(options[0].n) + options[0].suffix, options: [] };
    let common = options[0].n;
    for (const o of options) while (!o.n.startsWith(common)) common = common.slice(0, -1);
    return {
      line: head + prefix + esc(common.length > base.length ? common : base),
      options: options.map(o => o.n + (o.suffix === '/' ? '/' : '')),
    };
  }
}

// ---------- builtins that need the interpreter's control-flow signals ----------

for (const b of ['break', 'continue', 'return', 'local', 'read', 'shift', 'let', ':']) BUILTINS.add(b);

const loopCount = (ctx, name) => {
  const a = ctx.args[0];
  const n = a === undefined ? 1 : Number(a);
  if (!Number.isInteger(n) || n < 1) { ctx.err(`bash: ${name}: ${a}: loop count out of range\n`); return null; }
  return n;
};
commands.break = ctx => {
  const n = loopCount(ctx, 'break');
  if (n === null) return 1;
  if (!ctx.sh.loopDepth) { ctx.err("bash: break: only meaningful in a `for', `while', or `until' loop\n"); return 0; }
  throw new BreakSig(Math.min(n, ctx.sh.loopDepth));
};
commands.continue = ctx => {
  const n = loopCount(ctx, 'continue');
  if (n === null) return 1;
  if (!ctx.sh.loopDepth) { ctx.err("bash: continue: only meaningful in a `for', `while', or `until' loop\n"); return 0; }
  throw new ContinueSig(Math.min(n, ctx.sh.loopDepth));
};
commands.return = ctx => {
  const sh = ctx.sh;
  if (!sh.funcDepth && !sh.depth) { ctx.err("bash: return: can only `return' from a function or sourced script\n"); return 1; }
  const a = ctx.args[0];
  if (a !== undefined && !/^-?\d+$/.test(a)) { ctx.err(`bash: return: ${a}: numeric argument required\n`); throw new ReturnSig(2); }
  throw new ReturnSig(a === undefined ? sh.lastCode : ((+a % 256) + 256) % 256);
};
commands.local = ctx => {
  const sh = ctx.sh;
  if (!sh.funcDepth) { ctx.err('bash: local: can only be used in a function\n'); return 1; }
  const frame = sh.frames[sh.frames.length - 1];
  for (const a of ctx.args) {
    const eq = a.indexOf('=');
    const k = eq < 0 ? a : a.slice(0, eq);
    if (!/^[A-Za-z_]\w*$/.test(k)) { ctx.err(`bash: local: \`${a}': not a valid identifier\n`); ctx.fail = 1; continue; }
    if (!Object.hasOwn(frame, k)) frame[k] = Object.hasOwn(sh.env, k) ? sh.env[k] : undefined;
    sh.env[k] = eq < 0 ? '' : a.slice(eq + 1);
  }
};
commands.shift = ctx => {
  const sh = ctx.sh;
  const n = ctx.args[0] === undefined ? 1 : Number(ctx.args[0]);
  if (!Number.isInteger(n) || n < 0) { ctx.err(`bash: shift: ${ctx.args[0]}: numeric argument required\n`); return 1; }
  if (n > sh.argv.length - 1) return 1;
  sh.argv = [sh.argv[0], ...sh.argv.slice(1 + n)];
};
commands.let = ctx => {
  if (!ctx.args.length) { ctx.err('bash: let: expression expected\n'); return 1; }
  let v = '0';
  for (const e of ctx.args) v = ctx.sh.arith(e);
  return v === '0' ? 1 : 0;
};
commands[':'] = () => 0;

// read [-r] [-p PROMPT] [NAME...]: reads one line from the shared input cursor.
commands.read = ctx => {
  const { o, rest } = opts(ctx, 'rs', 'pd');
  const r = ctx.io.in;
  if (!r) {
    ctx.err('bash: read: HackTerm kann nicht auf Tastatureingaben warten - leite Daten hinein, z.B.:\n' +
      '  echo "Neo 42" | { read name punkte; echo $name; }   oder   while read l; do ...; done < datei\n');
    return 1;
  }
  if (o.p) ctx.err(o.p);
  if (r.pos >= r.text.length) return 1;
  const delim = o.d === undefined ? '\n' : (o.d[0] ?? '\n');
  let end = r.text.indexOf(delim, r.pos);
  const eof = end < 0;
  if (eof) end = r.text.length;
  let line = r.text.slice(r.pos, end);
  r.pos = eof ? r.text.length : end + 1;
  if (!o.r) line = line.replace(/\\(.)/g, '$1');
  const names = rest.length ? rest : ['REPLY'];
  const bad = names.find(n => !/^[A-Za-z_]\w*$/.test(n));
  if (bad) { ctx.err(`bash: read: \`${bad}': not a valid identifier\n`); return 1; }
  const env = ctx.sh.env;
  if (!rest.length) { env.REPLY = line; return eof ? 1 : 0; }
  const ifs = Object.hasOwn(env, 'IFS') ? env.IFS : ' \t\n';
  const ws = [...ifs].filter(c => ' \t\n'.includes(c)).join('');
  const other = [...ifs].filter(c => !' \t\n'.includes(c)).join('');
  const esc = x => x.replace(/[\]\\^-]/g, '\\$&');
  let s = ws ? line.replace(new RegExp(`^[${esc(ws)}]+|[${esc(ws)}]+$`, 'g'), '') : line;
  const sep = new RegExp(`[${esc(ws)}]*${other ? `[${esc(other)}]` : `[${esc(ws)}]`}[${esc(ws)}]*|[${esc(ws)}]+`);
  names.forEach((n, k) => {
    if (k === names.length - 1 || !ifs) { env[n] = s; s = ''; return; }
    const m = sep.exec(s);
    if (!m) { env[n] = s; s = ''; return; }
    env[n] = s.slice(0, m.index);
    s = s.slice(m.index + m[0].length);
  });
  return eof ? 1 : 0;
};

// unset also removes functions (unset -f NAME, or a name that is not a variable).
const unsetVar = commands.unset;
commands.unset = ctx => {
  const sh = ctx.sh;
  if (ctx.args[0] === '-f') { for (const k of ctx.args.slice(1)) delete sh.funcs[k]; return; }
  const names = ctx.args.filter(a => a !== '-v');
  for (const k of names) if (!Object.hasOwn(sh.env, k) && Object.hasOwn(sh.funcs, k) && ctx.args[0] !== '-v') delete sh.funcs[k];
  return unsetVar({ ...ctx, args: names });
};

Object.assign(MAN, {
  if: ['if BEDINGUNG; then ...; [elif ...; then ...;] [else ...;] fi', 'Fuehrt Befehle nur aus, wenn die Bedingung (ein Befehl!) Exit-Code 0 liefert. Meist mit [ ... ] oder [[ ... ]].', ['if [ -f notes.txt ]; then echo da; else echo weg; fi', 'if grep -q Failed logs/auth.log; then echo Angriff; fi'], 'Skripte'],
  for: ['for NAME in WOERTER; do ...; done', 'Wiederholt Befehle fuer jedes Wort. Auch: for ((i=0; i<5; i++)); do ...; done', ['for f in *.txt; do wc -l $f; done', 'for i in {1..3}; do echo Runde $i; done', 'for ((i=1; i<=3; i++)); do echo $i; done'], 'Skripte'],
  while: ['while BEDINGUNG; do ...; done', 'Wiederholt, solange die Bedingung wahr ist (until: solange sie falsch ist). Mit read ideal, um Dateien zeilenweise zu lesen.', ['i=0; while [ $i -lt 3 ]; do echo $i; i=$((i+1)); done', 'while read -r zeile; do echo ">> $zeile"; done < notes.txt'], 'Skripte'],
  until: ['until BEDINGUNG; do ...; done', 'Wie while, laeuft aber, bis die Bedingung wahr wird.', ['n=0; until [ $n -ge 3 ]; do n=$((n+1)); done; echo $n'], 'Skripte'],
  case: ['case WORT in MUSTER) ...;; esac', 'Vergleicht ein Wort mit Mustern (*, ?, [..], a|b).', ['case $USER in root) echo Chef;; hack*) echo Operator;; *) echo Gast;; esac'], 'Skripte'],
  function: ['NAME() { ...; }   oder   function NAME { ...; }', 'Definiert eine eigene Funktion. Argumente: $1, $2, $@, $#. Mit local bleiben Variablen in der Funktion, return setzt den Exit-Code.', ['gruss() { echo "Hallo $1"; }; gruss Neo', 'zaehle() { local n=$(wc -l < $1); echo "$1: $n"; }'], 'Skripte'],
  read: ['read [-r] [-p TEXT] NAME...', 'Liest eine Zeile von stdin in Variablen (das letzte Wort bekommt den Rest). In HackTerm nur mit Pipe oder Umleitung.', ['echo "Neo 42" | { read name punkte; echo $punkte; }', 'while IFS=, read -r name alias stadt; do echo $name; done < documents/contacts.csv'], 'Skripte'],
  local: ['local NAME[=WERT]', 'Macht eine Variable lokal zur aktuellen Funktion.', ['f() { local x=1; echo $x; }; f; echo "[$x]"'], 'Skripte'],
  return: ['return [N]', 'Beendet eine Funktion mit Exit-Code N.', ['ist_root() { [ $(whoami) = root ]; return; }'], 'Skripte'],
  break: ['break [N]', 'Verlaesst die innerste (oder N-te) Schleife.', ['for i in 1 2 3 4; do [ $i = 3 ] && break; echo $i; done'], 'Skripte'],
  continue: ['continue [N]', 'Springt zum naechsten Schleifendurchlauf.', ['for i in 1 2 3; do [ $i = 2 ] && continue; echo $i; done'], 'Skripte'],
  shift: ['shift [N]', 'Verschiebt die Argumente: $2 wird $1 usw.', ['f() { shift; echo "$@"; }; f a b c'], 'Skripte'],
  let: ['let AUSDRUCK...', 'Rechnet mit Variablen, wie (( ... )).', ['let i=5*2; echo $i', 'x=1; ((x++)); echo $x'], 'Skripte'],
});

export { parentPath };
