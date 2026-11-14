// Shell interpreter: lexer, parser, expansion and execution on top of the VFS.
import { VFS, normalize, parentPath, baseName } from './vfs.js';
import { commands, Usage, BUILTINS, opts, RAW } from './commands.js';
import './more.js'; // registers the additional commands
import { FsError } from './vfs.js';
import { buildWorld, initialProcs, MAN } from './world.js';
import { calc } from './awk.js';

class SyntaxErr extends Error {}
// Input that is valid so far but unfinished (open quote, missing `done`, trailing `|` ...).
class Incomplete extends SyntaxErr {}
class ExpandErr extends Error {}
// Expansion errors that abort the whole input line (or script), like ${x:?} and set -u in bash.
class FatalExpand extends ExpandErr {}
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

// Index of the `}` closing the `{` at i, honouring quotes and nested braces.
function matchBrace(src, i) {
  let depth = 0;
  for (let j = i; j < src.length; j++) {
    const c = src[j];
    if (c === '\\') { j++; continue; }
    if (c === "'") { const k = src.indexOf("'", j + 1); if (k < 0) return -1; j = k; continue; }
    if (c === '"') { let k = j + 1; while (k < src.length && src[k] !== '"') { if (src[k] === '\\') k++; k++; } j = k; continue; }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return j;
  }
  return -1;
}

const ASSIGN_HEAD = /^[A-Za-z_]\w*(\[[^\]]*\])?\+?=$/;

const OPS = /^(2>&1|2>>|2>|&>|&&|\|\||;;|<<<|<<-|<<|>>|>|<|\||;|&|\(|\))/;

// Split source text into raw words (quotes kept), operators, newlines, `((..))`,
// `[[..]]` and here-documents (attached to their `<<` operator).
export function lex(src) {
  const toks = [];
  const pendingDocs = [];
  // Tokens carry their source span (s, e) so function bodies and jobs can show their text.
  let w = '', has = false, i = 0, ws = 0;
  const push = () => { if (has) { toks.push({ t: 'w', v: w, s: ws, e: i }); w = ''; has = false; } };
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
    if (!has) ws = i;
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
      const j = matchBrace(src, i + 1);
      if (j < 0) throw eof('}');
      w += src.slice(i, j + 1); has = true; i = j + 1; continue;
    }
    if (c === '`') {
      const j = src.indexOf('`', i + 1);
      if (j < 0) throw eof('`');
      w += src.slice(i, j + 1); has = true; i = j + 1; continue;
    }
    if (c === '\n') { push(); toks.push({ t: 'o', v: '\n', s: i, e: i + 1 }); i++; if (pendingDocs.length) readDocs(); continue; }
    if (c === ' ' || c === '\t' || c === '\r') { push(); i++; continue; }
    if (c === '#' && !has) { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (!has && src.startsWith('((', i)) {
      const j = matchParen(src, i);
      if (j < 0) throw eof('))');
      if (src[j - 1] === ')' && j - 1 > i + 1) { toks.push({ t: 'arith', v: src.slice(i + 2, j - 1), s: i, e: j + 1 }); i = j + 1; continue; }
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
      toks.push({ t: 'dbr', v: src.slice(i + 2, j), s: i, e: j + 3 });
      i = j + 3;
      continue;
    }
    // Array assignment: name=( ... ) stays one word.
    if (c === '(' && has && ASSIGN_HEAD.test(w)) {
      const j = matchParen(src, i);
      if (j < 0) throw eof(')');
      w += src.slice(i, j + 1); i = j + 1; continue;
    }
    const m = OPS.exec(src.slice(i));
    if (m && !(m[1][0] === '2' && has)) {
      push();
      const tok = { t: 'o', v: m[1], s: i, e: i + m[1].length };
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
        tok.e = j;
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
export function parse(toks, src = '') {
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
  const span = (from, node) => { if (src && from) node.src = src.slice(from.s, toks[i - 1].e); return node; };
  function andOr() {
    const from = peek();
    const first = pipeline();
    const rest = [];
    while (isO(peek(), '&&') || isO(peek(), '||')) {
      const op = toks[i++].v;
      skipNl();
      rest.push({ op, pipe: pipeline() });
    }
    return span(from, { type: 'andor', first, rest });
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
        const from = t;
        i++;
        const n = peek();
        if (!n || n.t !== 'w') throw unexpected(n);
        i++;
        if (isO(peek(), '(')) { i++; if (!isO(peek(), ')')) throw unexpected(peek()); i++; }
        return funcBody(n.v, from);
      }
      if (isO(toks[i + 1], '(') && isO(toks[i + 2], ')')) { i += 3; return funcBody(t.v, t); }
    }
    return simple();
  }
  function funcBody(name, from) {
    if (!/^[^\s'"\\$`/=]+$/.test(name) || /^\d+$/.test(name)) throw new SyntaxErr(`\`${name}': not a valid identifier`);
    skipNl();
    const body = command();
    if (body.type === 'simple') throw new SyntaxErr(`syntax error near unexpected token \`${body.words[0] ?? 'newline'}'`);
    span(from, body);
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

// Regex source for a glob with expansion placeholders; quoted parts are already literal.
function globSource(seg, lazy = false) {
  let re = '';
  for (let i = 0; i < seg.length; i++) {
    const c = seg[i];
    if (c === P['*']) re += lazy ? '[\\s\\S]*?' : '[\\s\\S]*';
    else if (c === P['?']) re += '[\\s\\S]';
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
  return re;
}
function segRe(seg) { return new RegExp('^(?:' + globSource(seg) + ')$'); }

// ${x#p} ${x##p} ${x%p} ${x%%p}: remove the shortest/longest matching prefix/suffix.
function trimPattern(s, pat, op) {
  if (op === '#' || op === '##') {
    const m = new RegExp('^(?:' + globSource(pat, op === '#') + ')').exec(s);
    return m ? s.slice(m[0].length) : s;
  }
  const full = new RegExp('^(?:' + globSource(pat) + ')$');
  if (op === '%%') { const m = new RegExp('(?:' + globSource(pat) + ')$').exec(s); return m ? s.slice(0, m.index) : s; }
  for (let k = s.length; k >= 0; k--) if (full.test(s.slice(k))) return s.slice(0, k);
  return s;
}

// ${x/p/r} first match, ${x//p/r} all, ${x/#p/r} prefix, ${x/%p/r} suffix (longest matches).
function replacePattern(s, pat, rep, mode) {
  const src = globSource(pat);
  if (mode === '#') return s.replace(new RegExp('^(?:' + src + ')'), () => rep);
  if (mode === '%') return s.replace(new RegExp('(?:' + src + ')$'), () => rep);
  if (!pat) return s;
  return s.replace(new RegExp(src, mode === '/' ? 'g' : ''), m => (m ? rep : ''));
}

const SHELL_DEFAULTS = Object.assign(Object.create(null), {
  BASH: '/bin/bash', BASH_VERSION: '5.2.21(1)-release', OSTYPE: 'linux-gnu', PPID: '2047',
  SHLVL: '1', IFS: ' \t\n', HISTSIZE: '500', OPTIND: '1',
});
const ASSIGN = /^([A-Za-z_]\w*)(?:\[([^\]]*)\])?(\+?)=([\s\S]*)$/;
// Builtins whose name=value arguments are assignments (no word splitting, arrays allowed).
const DECL = new Set(['declare', 'typeset', 'local', 'readonly', 'export']);

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
    this.arrays = dict(s.arrays || {}); // indexed arrays: name -> [values] (holes are null)
    this.readonly = new Set(s.attrs?.readonly || []);
    this.intVars = new Set(s.attrs?.int || []);
    this.opts = { errexit: false, nounset: false, xtrace: false, pipefail: false };
    this.traps = Object.create(null);
    this.dirStack = [];
    this.jobs = []; // finished background jobs not yet reported
    this.jobCodes = new Map();
    this.runId = 0;
    this.condDepth = 0; // >0 while evaluating a condition (no errexit / ERR trap)
    this.started = Date.now();
    this.getopt = { ind: 1, sub: 1 };
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
      arrays: this.arrays, attrs: { readonly: [...this.readonly], int: [...this.intVars] },
    };
  }

  prompt() {
    if (this.pending !== null) return '> ';
    const home = this.env.HOME || '';
    let p = this.cwd;
    if (home && (p === home || p.startsWith(home + '/'))) p = '~' + p.slice(home.length);
    return `\x1b[1;32m${this.fs.user}@box\x1b[0m:\x1b[1;34m${p}\x1b[0m$ `;
  }

  // Value of a parameter, or undefined if it is not set.
  param(k) {
    switch (k) {
      case '?': return String(this.lastCode);
      case '$': case 'BASHPID': return '2048';
      case '#': return String(this.argv.length - 1);
      case '@': case '*': return this.argv.slice(1).join(' ');
      case '!': return this.lastBg === undefined ? undefined : String(this.lastBg);
      case '-': return 'hB' + (this.opts.errexit ? 'e' : '') + (this.opts.nounset ? 'u' : '') + (this.opts.xtrace ? 'x' : '');
      case 'PWD': return this.cwd;
      case 'RANDOM': return String(Math.floor(Math.random() * 32768));
      case 'SECONDS': return String(Math.floor((Date.now() - this.started) / 1000));
      case 'UID': case 'EUID': return this.fs.user === 'root' ? '0' : '1000';
    }
    if (/^\d+$/.test(k)) return this.argv[+k];
    if (Object.hasOwn(this.arrays, k)) return this.arrays[k][0] ?? undefined;
    if (Object.hasOwn(this.env, k)) return this.env[k];
    return SHELL_DEFAULTS[k];
  }

  getVar(k) {
    const v = this.param(k);
    if (v === undefined && this.opts.nounset && k !== '@' && k !== '*') throw new FatalExpand(`${k}: unbound variable`);
    return v ?? '';
  }

  arrayItems(name) {
    if (Object.hasOwn(this.arrays, name)) return this.arrays[name].filter(v => v !== undefined && v !== null);
    const v = this.param(name);
    return v === undefined ? [] : [v];
  }

  arrayIndex(name, raw) {
    const len = Object.hasOwn(this.arrays, name) ? this.arrays[name].length : 1;
    let k = parseInt(this.arith(raw || '0'), 10) || 0;
    if (k < 0) k += len;
    if (k < 0) throw new FatalExpand(`${name}[${raw}]: bad array subscript`);
    return k;
  }

  // name or name[idx]; idx @ or * joins all elements.
  paramAt(name, idx) {
    if (idx === undefined) return name === '@' || name === '*' ? (this.argv.length > 1 ? this.argv.slice(1).join(' ') : undefined) : this.param(name);
    if (!/^[A-Za-z_]\w*$/.test(name)) throw new FatalExpand(`${name}[${idx}]: bad substitution`);
    if (idx === '@' || idx === '*') { const it = this.arrayItems(name); return it.length ? it.join(' ') : undefined; }
    const k = this.arrayIndex(name, idx);
    if (Object.hasOwn(this.arrays, name)) return this.arrays[name][k] ?? undefined;
    return k === 0 ? this.param(name) : undefined;
  }

  listAt(name, idx) {
    if (name === '@' || name === '*') return this.argv.slice(1);
    return this.arrayItems(name);
  }

  // Everything inside ${...}.
  paramExpand(body) {
    let m;
    if (body === '#') return String(this.argv.length - 1);
    if ((m = /^#([A-Za-z_]\w*|\d+|[@*])(?:\[([^\]]*)\])?$/.exec(body))) {
      const [, n, idx] = m;
      if (n === '@' || n === '*') return String(this.argv.length - 1);
      if (idx === '@' || idx === '*') return String(this.arrayItems(n).length);
      const v = this.paramAt(n, idx);
      if (v === undefined && this.opts.nounset) throw new FatalExpand(`${n}: unbound variable`);
      return String([...(v ?? '')].length);
    }
    if ((m = /^!([A-Za-z_]\w*)\[[@*]\]$/.exec(body))) {
      const arr = Object.hasOwn(this.arrays, m[1]) ? this.arrays[m[1]] : this.arrayItems(m[1]);
      return arr.map((v, k) => (v === undefined || v === null ? null : k)).filter(k => k !== null).join(' ');
    }
    if ((m = /^!([A-Za-z_]\w*)[@*]$/.exec(body))) {
      // ${!prefix*}: names of all variables starting with prefix.
      return [...new Set([...Object.keys(this.env), ...Object.keys(this.arrays)])].filter(k => k.startsWith(m[1])).sort().join(' ');
    }
    if ((m = /^!([A-Za-z_]\w*|\d+)((?![\[])[\s\S]*)$/.exec(body))) {
      const ref = this.param(m[1]) ?? '';
      if (!/^([A-Za-z_]\w*(\[[^\]]*\])?|\d+|[@*#?])$/.test(ref)) throw new FatalExpand(`${ref}: invalid indirect expansion`);
      return this.paramExpand(ref + m[2]);
    }
    m = /^([A-Za-z_]\w*|\d+|[?$#@*!-])(?:\[([^\]]*)\])?([\s\S]*)$/.exec(body);
    if (!m) throw new FatalExpand(`\${${body}}: bad substitution`);
    const [, name, idx, op] = m;
    const many = idx === '@' || idx === '*' || name === '@' || name === '*';
    const val = this.paramAt(name, idx);
    const unbound = () => { if (val === undefined && this.opts.nounset && !many) throw new FatalExpand(`${name}: unbound variable`); };
    if (!op) { unbound(); return val ?? ''; }
    let r;
    if ((r = /^(:?)([-=?+])([\s\S]*)$/.exec(op))) {
      const [, colon, kind, wordRaw] = r;
      const empty = val === undefined || (colon && val === '');
      const word = () => this.expand(wordRaw, false)[0] ?? '';
      if (kind === '-') return empty ? word() : val;
      if (kind === '+') return empty ? '' : word();
      if (kind === '?') {
        if (empty) throw new FatalExpand(`${name}: ${wordRaw ? word() : 'parameter null or not set'}`);
        return val;
      }
      if (!empty) return val;
      if (!/^[A-Za-z_]\w*$/.test(name)) throw new FatalExpand(`$${name}: cannot assign in this way`);
      const w = word();
      this.assign(name, idx, false, w, true);
      return w;
    }
    unbound();
    const items = many ? this.listAt(name, idx) : [val ?? ''];
    const each = f => items.map(f).join(' ');
    if ((r = /^(##?|%%?)([\s\S]*)$/.exec(op))) {
      const pat = this.expand(r[2], false, true)[0] ?? '';
      return each(x => trimPattern(x, pat, r[1]));
    }
    if ((r = /^\/([/#%]?)((?:\\.|[^/])*)(?:\/([\s\S]*))?$/.exec(op))) {
      const pat = this.expand(r[2], false, true)[0] ?? '';
      const rep = r[3] === undefined ? '' : this.expand(r[3], false)[0] ?? '';
      return each(x => replacePattern(x, pat, rep, r[1]));
    }
    if ((r = /^(\^\^?|,,?)$/.exec(op))) {
      const up = r[1][0] === '^', whole = r[1].length === 2;
      return each(x => (whole ? (up ? x.toUpperCase() : x.toLowerCase())
        : x ? (up ? x[0].toUpperCase() : x[0].toLowerCase()) + x.slice(1) : x));
    }
    if ((r = /^:([^:]*)(?::([\s\S]*))?$/.exec(op))) {
      const off = parseInt(this.arith(r[1].trim() || '0'), 10) || 0;
      const len = r[2] === undefined ? undefined : parseInt(this.arith(r[2].trim() || '0'), 10) || 0;
      const list = many ? items : [...(val ?? '')];
      const a = off < 0 ? Math.max(0, list.length + off) : Math.min(off, list.length);
      let b = len === undefined ? list.length : len < 0 ? list.length + len : a + len;
      if (b < a) { if (len < 0) throw new FatalExpand(`${len}: substring expression < 0`); b = a; }
      return list.slice(a, b).join(many ? ' ' : '');
    }
    throw new FatalExpand(`\${${body}}: bad substitution`);
  }

  // Assign name[idx](+)=value. A raw value "(a b c)" assigns an array; preExpanded values are taken literally.
  assign(name, idx, append, value, preExpanded = false) {
    if (this.readonly.has(name)) throw new ExpandErr(`${name}: readonly variable`);
    if (idx === undefined && !preExpanded && /^\([\s\S]*\)$/.test(value)) {
      const items = lex(value.slice(1, -1)).filter(t => t.t === 'w').flatMap(t => this.expand(t.v));
      if (items.length > MAX_WORDS) throw new ExpandErr(`${name}: array too large (max ${MAX_WORDS})`);
      const all = append ? [...(Object.hasOwn(this.arrays, name) ? this.arrays[name] : this.arrayItems(name)), ...items] : items;
      if (all.length > MAX_WORDS) throw new ExpandErr(`${name}: array too large (max ${MAX_WORDS})`);
      this.arrays[name] = all;
      delete this.env[name];
      return;
    }
    let v = preExpanded ? value : (this.expand(value, false)[0] ?? '');
    const int = this.intVars.has(name);
    if (int) v = this.arith(append ? `(${this.paramAt(name, idx) || 0})+(${v || 0})` : v || '0');
    const join = old => (append && !int ? (old ?? '') + v : v);
    if (idx !== undefined) {
      if (!Object.hasOwn(this.arrays, name)) {
        this.arrays[name] = Object.hasOwn(this.env, name) ? [this.env[name]] : [];
        delete this.env[name];
      }
      const k = this.arrayIndex(name, idx);
      if (k >= MAX_WORDS) throw new ExpandErr(`${name}[${idx}]: index too large for this simulator (max ${MAX_WORDS - 1})`);
      this.arrays[name][k] = join(this.arrays[name][k]);
      return;
    }
    if (Object.hasOwn(this.arrays, name)) { this.arrays[name][0] = join(this.arrays[name][0]); return; }
    this.env[name] = join(this.env[name]);
  }

  expandError(e, io, prefix = '') {
    io.err(`bash: ${prefix}${e.message}\n`);
    if (e instanceof FatalExpand) { this.exiting = true; this.lastCode = 1; }
    return 1;
  }

  // Plain scalar assignment from builtins (read, for, getopts ...): honours readonly, arrays and -i.
  setVar(name, v) { this.assign(name, undefined, false, v, true); }

  // Remember a variable's state so the current function can restore it (local / declare).
  saveLocal(k) {
    const frame = this.frames[this.frames.length - 1];
    if (!frame || Object.hasOwn(frame, k)) return;
    frame[k] = {
      env: Object.hasOwn(this.env, k) ? this.env[k] : undefined,
      arr: Object.hasOwn(this.arrays, k) ? this.arrays[k] : undefined,
      int: this.intVars.has(k), ro: this.readonly.has(k),
    };
    delete this.arrays[k];
    this.readonly.delete(k);
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
      const j = matchBrace(raw, i + 1);
      if (j < 0) return ['$', i + 1];
      return [this.paramExpand(raw.slice(i + 2, j)), j + 1];
    }
    const m = /^([A-Za-z_]\w*|[?$#@*!0-9-])/.exec(raw.slice(i + 1));
    if (!m) return ['$', i + 1];
    return [this.getVar(m[1]), i + 1 + m[1].length];
  }

  // Expand one raw word into zero or more fields.
  // keepGlob returns the unsplit word with glob placeholders intact (for patterns).
  expand(raw, split = true, keepGlob = false) {
    // "$@" / "${arr[@]}" with no elements expands to no word at all.
    let mm;
    if (split && (mm = /^"\$(?:@|\{@\}|\{([A-Za-z_]\w*)\[@\]\})"$/.exec(raw)) && !this.listAt(mm[1] ?? '@').length) return [];
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
          else if (split && q === '$' && (mm = /^\$(?:@|\{@\}|\{([A-Za-z_]\w*)\[@\]\})/.exec(raw.slice(i)))) {
            // "$@" and "${arr[@]}" keep every element as its own word.
            this.listAt(mm[1] ?? '@').forEach((a, k) => { if (k > 0) { fields.push(cur); cur = ''; } cur += a; });
            i += mm[0].length;
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
    try { tree = parse(lex(src), src); } catch (e) {
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
    this.runId++;
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
    this.reportJobs(io, j => j.born < this.runId);
    return { line: src, code, cmds: this.cmdLog, stdout: stdout.replace(/\x1b\[[\d;]*m/g, '') };
  }

  // "[1]+  Done   cmd" lines for finished background jobs (the shell prints them before a prompt).
  reportJobs(io, which = () => true, withPid = false, write = io.err) {
    const due = this.jobs.filter(which);
    if (!due.length) return [];
    this.jobs = this.jobs.filter(j => !due.includes(j));
    due.forEach((j, k) => {
      const mark = k === due.length - 1 ? '+' : k === due.length - 2 ? '-' : ' ';
      const status = j.code ? `Exit ${j.code}` : 'Done';
      write(`[${j.n}]${mark}  ${withPid ? j.pid + ' ' : ''}${status.padEnd(24)}${j.cmd}\n`);
    });
    return due;
  }

  // Parse and run source text (used by $(...)); syntax errors are reported, not thrown.
  runLine(src, io) {
    let tree;
    try { tree = parse(lex(src), src); } catch (e) {
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
        code = it.bg ? this.runBackground(it.node, io) : this.exec(it.node, io);
        if (this.exiting) break;
      }
      return code;
    }
    if (node.type === 'andor') {
      // Only the last pipeline of an && / || chain can trigger set -e or the ERR trap.
      const n = node.rest.length;
      const cond = fn => { this.condDepth++; try { return fn(); } finally { this.condDepth--; } };
      let last = node.first;
      let code = (this.lastCode = n ? cond(() => this.runPipe(node.first, io)) : this.runPipe(node.first, io));
      let lastRan = n === 0;
      node.rest.forEach((r, k) => {
        if (this.exiting || (r.op === '&&') !== (code === 0)) return;
        const isLast = k === n - 1;
        last = r.pipe;
        code = this.lastCode = isLast ? this.runPipe(r.pipe, io) : cond(() => this.runPipe(r.pipe, io));
        lastRan = isLast;
      });
      if (code !== 0 && lastRan && !last.bang && !this.condDepth && !this.exiting) this.onError(code, io);
      return code;
    }
    return this.runCommand(node, io);
  }

  onError(code, io) {
    if (this.traps.ERR && !this.inTrap) {
      this.inTrap = true;
      try { this.runLine(this.traps.ERR, io); } finally { this.inTrap = false; }
      this.lastCode = code;
    }
    if (this.opts.errexit) { this.exiting = true; this.lastCode = code; }
  }

  // Background jobs finish immediately in the simulator; we keep their status for wait/jobs.
  runBackground(node, io) {
    const pid = this.nextPid++;
    const n = Math.max(0, ...this.jobs.map(j => j.n)) + 1;
    const top = this.depth === 0 && this.funcDepth === 0;
    if (top) io.err(`[${n}] ${pid}\n`);
    const code = this.exec(node, { ...io, in: null });
    this.lastBg = pid;
    this.jobCodes.set(pid, code);
    if (this.jobCodes.size > 100) this.jobCodes.delete(this.jobCodes.keys().next().value);
    if (top) this.jobs.push({ n, pid, cmd: node.src || '', code, born: this.runId });
    this.exiting = false;
    return (this.lastCode = 0);
  }

  runPipe(p, io) {
    if (p.bang) { this.condDepth++; try { return this.runPipe({ ...p, bang: false }, io) ? 0 : 1; } finally { this.condDepth--; } }
    let input = io.in, code = 0, failed = 0;
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
      if (code) failed = code;
      input = { text: buf, pos: 0 };
    });
    return this.opts.pipefail && failed ? (code || failed) : code;
  }

  runCommand(node, io) {
    this.tick();
    if (node.type === 'simple') return this.runSimple(node, io);
    if (node.type === 'funcdef') {
      this.funcs[node.name] = node.body;
      this.cmdLog.push({ name: 'function', args: [node.name], code: 0 });
      return 0;
    }
    let code;
    try { code = this.withRedirs(node.redirs, io, io2 => this.runCompound(node, io2)); } catch (e) {
      if (!(e instanceof ExpandErr)) throw e;
      code = this.expandError(e, io);
    }
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
        const saved = { cwd: this.cwd, env: this.env, exported: this.exported, funcs: this.funcs, aliases: this.aliases, umask: this.fs.umask, arrays: this.arrays, opts: this.opts, dirStack: this.dirStack };
        this.env = Object.assign(Object.create(null), this.env);
        this.arrays = Object.assign(Object.create(null), ...Object.keys(this.arrays).map(k => ({ [k]: [...this.arrays[k]] })));
        this.opts = { ...this.opts };
        this.dirStack = [...this.dirStack];
        this.exported = new Set(this.exported);
        this.funcs = Object.assign(Object.create(null), this.funcs);
        this.aliases = Object.assign(Object.create(null), this.aliases);
        this.depth++;
        try { return this.exec(node.body, io); } finally {
          Object.assign(this, { cwd: saved.cwd, env: saved.env, exported: saved.exported, funcs: saved.funcs, aliases: saved.aliases, arrays: saved.arrays, opts: saved.opts, dirStack: saved.dirStack });
          this.fs.umask = saved.umask;
          this.depth--;
          this.exiting = false;
        }
      }
      case 'if': {
        for (const cl of node.clauses) {
          this.condDepth++;
          let c;
          try { c = this.exec(cl.cond, io); } finally { this.condDepth--; }
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
          this.setVar(node.name, v);
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
          this.condDepth++;
          let c;
          try { c = this.exec(node.cond, io); } finally { this.condDepth--; }
          if (this.exiting || (c === 0) === node.until) break;
          const r = this.loopStep(node.body, io);
          code = this.lastCode;
          if (r === 'break') break;
        }
        return code;
      });
      case 'case': {
        let w;
        try { w = this.expand(node.word, false)[0]; } catch (e) { if (e instanceof ExpandErr) return this.expandError(e, io); throw e; }
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
      if (e instanceof FatalExpand) return this.expandError(e, io);
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
      if (e instanceof ExpandErr) return this.expandError(e, io);
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
    while (words.length && ASSIGN.test(words[0])) assigns.push(words.shift());
    const decl = words.length && DECL.has(words[0]);
    let argv;
    try {
      argv = words.flatMap((w, k) => {
        // declare/local/export x=$y: no word splitting; arrays are handed over unexpanded.
        if (k > 0 && decl && ASSIGN.test(w)) return [/^[^=]*=\(/.test(w) && w.endsWith(')') ? RAW + w : this.expand(w, false)[0]];
        return this.expand(w);
      });
    } catch (e) {
      if (e instanceof ExpandErr) return this.expandError(e, io);
      throw e;
    }
    return this.withRedirs(cmd.redirs, io, io2 => {
      const saved = Object.create(null);
      const traced = [];
      try {
        for (const a of assigns) {
          const [, name, idx, plus, value] = ASSIGN.exec(a);
          if (argv.length && idx === undefined) saved[name] = Object.hasOwn(this.env, name) ? this.env[name] : undefined;
          this.assign(name, idx, plus === '+', value);
          if (this.opts.xtrace) traced.push(`${name}${idx !== undefined ? `[${idx}]` : ''}${plus}=${this.paramAt(name, idx) ?? ''}`);
        }
      } catch (e) {
        if (e instanceof ExpandErr) return this.expandError(e, io);
        throw e;
      }
      if (this.opts.xtrace && (traced.length || argv.length)) {
        const q = x => (/^[\w@%+=:,./-]+$/.test(x) ? x : `'${x.replace(/'/g, "'\\''")}'`);
        io.err('+ ' + [...traced.map(q), ...argv.map(x => q(x.replace(RAW, '')))].join(' ') + '\n');
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
    };
    // Not enumerable: a copy like {...ctx} must not consume the input by reading it.
    Object.defineProperty(ctx, 'stdin', {
      enumerable: false,
      get() {
        if (!stdinRead) {
          stdinRead = true;
          if (io.stdin !== undefined) stdinVal = io.stdin;
          else if (!io.in) stdinVal = null;
          else { stdinVal = io.in.text.slice(io.in.pos); io.in.pos = io.in.text.length; }
        }
        return stdinVal;
      },
    });
    let code;
    try { code = fn(ctx); } catch (e) {
      if (e instanceof Signal) throw e;
      if (e instanceof Usage) { io.err(`${name}: ${e.message}\nTry 'man ${name}' for more information.\n`); code = 2; }
      else if (e instanceof FsError) { io.err(`${name}: ${e.message}\n`); code = 1; }
      else if (e instanceof ExpandErr) code = this.expandError(e, io);
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
      for (const k of Object.keys(frame)) {
        const f = frame[k];
        if (f.env === undefined) delete this.env[k]; else this.env[k] = f.env;
        if (f.arr === undefined) delete this.arrays[k]; else this.arrays[k] = f.arr;
        if (f.int) this.intVars.add(k); else this.intVars.delete(k);
        if (f.ro) this.readonly.add(k); else this.readonly.delete(k);
      }
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
    const code = this.runScript(node.d, argv, io, true);
    this.cmdLog.push({ name, args: argv.slice(1), code, script: true });
    return code;
  }

  // Run a whole script (multi-line constructs allowed) with its own positional parameters.
  // child: started as its own bash process (not `source`), so options and traps start fresh.
  runScript(text, argv, io, child = false) {
    if (this.depth >= 8) { io.err('bash: maximum script nesting level exceeded\n'); return 1; }
    let tree;
    try { tree = parse(lex(text), text); } catch (e) {
      if (!(e instanceof SyntaxErr)) throw e;
      io.err(`bash: ${argv[0]}: ${e.message}\n`);
      return 2;
    }
    const saved = { argv: this.argv, loopDepth: this.loopDepth, traps: this.traps, getopt: this.getopt, optind: this.env.OPTIND, opts: this.opts, dirStack: this.dirStack };
    this.argv = argv;
    this.loopDepth = 0;
    if (child) {
      this.traps = Object.create(null);
      this.opts = { errexit: false, nounset: false, xtrace: false, pipefail: false };
      this.dirStack = [];
    }
    this.getopt = { ind: 1, sub: 1 };
    this.env.OPTIND = '1';
    this.depth++;
    const sio = this.normIo(io);
    let code = 0;
    try {
      try { code = this.exec(tree, sio); } catch (sig) {
        if (sig instanceof ReturnSig) code = sig.n;
        else if (sig instanceof BreakSig || sig instanceof ContinueSig) code = 0;
        else throw sig;
      }
      if (this.exiting) code = this.lastCode;
      if (child && this.traps.EXIT) {
        // The EXIT trap runs when the script ends, with $? set to its exit status.
        this.exiting = false;
        this.lastCode = code;
        const t = this.traps.EXIT;
        delete this.traps.EXIT;
        this.runLine(t, sio);
      }
    } finally {
      this.depth--;
      this.argv = saved.argv;
      this.loopDepth = saved.loopDepth;
      if (child) Object.assign(this, { traps: saved.traps, opts: saved.opts, dirStack: saved.dirStack });
      this.getopt = saved.getopt;
      if (saved.optind === undefined) delete this.env.OPTIND; else this.env.OPTIND = saved.optind;
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
    const dv = /^(.*?)(\$\{?)([A-Za-z_]\w*)?$/.exec(word);
    if (dv && !dv[1].includes('$')) {
      // $VAR / ${VAR completion
      prefix = dv[1] + dv[2];
      base = dv[3] || '';
      const close = dv[2] === '${' ? '}' : '';
      options = [...new Set([...Object.keys(this.env), ...Object.keys(this.arrays), 'RANDOM', 'SECONDS', 'UID', 'PWD'])]
        .filter(n => n.startsWith(base)).sort().map(n => ({ n, suffix: close || ' ', raw: true }));
    } else if (first && !word.includes('/')) {
      options = [...new Set([...Object.keys(commands), ...Object.keys(this.aliases), ...Object.keys(this.funcs)])]
        .filter(n => n.startsWith(word) && n !== '[' && n !== '.').sort().map(n => ({ n, suffix: ' ' }));
    } else {
      const slash = word.lastIndexOf('/');
      prefix = word.slice(0, slash + 1);
      base = word.slice(slash + 1);
      let dir = prefix || '.';
      if (dir.startsWith('~')) dir = (this.env.HOME || '/') + dir.slice(1);
      dir = dir.replace(/\$\{?([A-Za-z_]\w*)\}?/g, (m, k) => this.param(k) ?? '');
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

for (const b of ['break', 'continue', 'return', 'local', 'read', 'shift', 'let', ':', 'declare', 'typeset', 'readonly',
  'set', 'mapfile', 'readarray', 'getopts', 'trap', 'pushd', 'popd', 'dirs', 'jobs', 'wait', 'fg', 'bg']) BUILTINS.add(b);

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
  const { o, rest } = opts(ctx, 'rs', 'pda');
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
  const sh = ctx.sh, env = sh.env;
  if (o.a !== undefined && !/^[A-Za-z_]\w*$/.test(o.a)) { ctx.err(`bash: read: \`${o.a}': not a valid identifier\n`); return 1; }
  if (o.a === undefined && !rest.length) { sh.setVar('REPLY', line); return eof ? 1 : 0; }
  const ifs = Object.hasOwn(env, 'IFS') ? env.IFS : ' \t\n';
  const ws = [...ifs].filter(c => ' \t\n'.includes(c)).join('');
  const other = [...ifs].filter(c => !' \t\n'.includes(c)).join('');
  const esc = x => x.replace(/[\]\\^-]/g, '\\$&');
  let s = ws ? line.replace(new RegExp(`^[${esc(ws)}]+|[${esc(ws)}]+$`, 'g'), '') : line;
  const sep = new RegExp(`[${esc(ws)}]*${other ? `[${esc(other)}]` : `[${esc(ws)}]`}[${esc(ws)}]*|[${esc(ws)}]+`);
  if (o.a !== undefined) {
    // read -a NAME: every field becomes an array element.
    if (sh.readonly.has(o.a)) { ctx.err(`bash: ${o.a}: readonly variable\n`); return 1; }
    const items = [];
    while (s) {
      const m = sep.exec(s);
      if (!m) { items.push(s); break; }
      items.push(s.slice(0, m.index));
      s = s.slice(m.index + m[0].length);
    }
    sh.arrays[o.a] = items.slice(0, 10000);
    delete env[o.a];
    return eof ? 1 : 0;
  }
  names.forEach((n, k) => {
    if (k === names.length - 1 || !ifs) { sh.setVar(n, s); s = ''; return; }
    const m = sep.exec(s);
    if (!m) { sh.setVar(n, s); s = ''; return; }
    sh.setVar(n, s.slice(0, m.index));
    s = s.slice(m.index + m[0].length);
  });
  return eof ? 1 : 0;
};

// ---------- variables: declare / typeset / local / readonly / unset ----------

const dq = v => `"${String(v).replace(/(["\\$`])/g, '\\$1')}"`;
const funcText = (name, f) => {
  let src = (f.src || '{ ... }').trim();
  if (!/^[({]/.test(src)) src = src.replace(/^(?:function\s+)?[^\s(]+\s*(?:\(\s*\))?\s*/, '');
  return `${name} () ${src}\n`;
};

// One line of `declare -p` output.
function describeVar(sh, k) {
  const isArr = Object.hasOwn(sh.arrays, k);
  if (!isArr && !Object.hasOwn(sh.env, k)) return null;
  let fl = (isArr ? 'a' : '') + (sh.intVars.has(k) ? 'i' : '') + (sh.readonly.has(k) ? 'r' : '') + (sh.exported.has(k) && !isArr ? 'x' : '');
  fl = fl ? '-' + fl : '--';
  if (!isArr) return `declare ${fl} ${k}=${dq(sh.env[k])}\n`;
  const items = sh.arrays[k].map((v, i) => (v === undefined || v === null ? null : `[${i}]=${dq(v)}`)).filter(Boolean);
  return `declare ${fl} ${k}=(${items.join(' ')})\n`;
}

function declare(ctx, mode) {
  const sh = ctx.sh, args = ctx.args;
  const on = new Set(), off = new Set();
  let i = 0;
  for (; i < args.length; i++) {
    const a = args[i];
    if (a === '--') { i++; break; }
    if (!/^[-+][A-Za-z]+$/.test(a)) break;
    for (const c of a.slice(1)) {
      if (c === 'A') { ctx.err(`bash: ${mode}: -A: assoziative Arrays kennt HackTerm (noch) nicht - nimm ein normales Array: a=(x y z)\n`); return 2; }
      if (!'aifFgprx'.includes(c)) { ctx.err(`bash: ${mode}: -${c}: invalid option\nusage: ${mode} [-aifFgprx] [name[=value] ...]\n`); return 2; }
      (a[0] === '-' ? on : off).add(c);
    }
  }
  const names = args.slice(i);
  if (mode === 'readonly') on.add('r');
  if (mode === 'local' && !sh.funcDepth) { ctx.err('bash: local: can only be used in a function\n'); return 1; }
  const scoped = (mode === 'local' || ((mode === 'declare' || mode === 'typeset') && !on.has('g'))) && sh.funcDepth > 0;

  // Functions: declare -f [NAME] prints the source, -F only the names.
  if (on.has('f') || on.has('F')) {
    const list = names.length ? names : Object.keys(sh.funcs).sort();
    for (const n of list) {
      if (!Object.hasOwn(sh.funcs, n)) { ctx.fail = 1; continue; }
      ctx.out(on.has('F') ? `declare -f ${n}\n` : funcText(n, sh.funcs[n]));
    }
    return;
  }
  // Listing: no names (or -p).
  if (!names.length || (on.has('p') && names.every(n => /^[A-Za-z_]\w*$/.test(n)))) {
    const keys = names.length ? names : [...new Set([...Object.keys(sh.env), ...Object.keys(sh.arrays)])].sort();
    for (const k of keys) {
      const want = !names.length && (on.size || off.size) && !(on.size === 1 && on.has('p'));
      if (want && ((on.has('a') && !Object.hasOwn(sh.arrays, k)) || (on.has('r') && !sh.readonly.has(k))
        || (on.has('i') && !sh.intVars.has(k)) || (on.has('x') && !sh.exported.has(k)))) continue;
      const line = describeVar(sh, k);
      if (line) ctx.out(on.has('p') || mode !== 'declare' || want ? line : line.replace(/^declare \S+ /, ''));
      else if (names.length) { ctx.err(`bash: ${mode}: ${k}: not found\n`); ctx.fail = 1; }
    }
    return;
  }
  for (let a of names) {
    const raw = a.startsWith(RAW);
    if (raw) a = a.slice(1);
    const m = /^([A-Za-z_]\w*)(?:\[([^\]]*)\])?(?:(\+?)=([\s\S]*))?$/.exec(a);
    if (!m) { ctx.err(`bash: ${mode}: \`${a}': not a valid identifier\n`); ctx.fail = 1; continue; }
    const [, k, idx, plus, value] = m;
    const assigning = value !== undefined;
    if (sh.readonly.has(k) && (assigning || off.has('r') || on.has('a') || on.has('i'))) {
      ctx.err(`bash: ${mode}: ${k}: readonly variable\n`); ctx.fail = 1; continue;
    }
    if (scoped) {
      const fresh = !Object.hasOwn(sh.frames[sh.frames.length - 1], k);
      sh.saveLocal(k);
      // A new local starts empty unless it is assigned right away.
      if (fresh) { delete sh.env[k]; delete sh.arrays[k]; sh.intVars.delete(k); if (!assigning && !on.has('a')) sh.env[k] = ''; }
    }
    if (on.has('a') && !Object.hasOwn(sh.arrays, k)) {
      sh.arrays[k] = Object.hasOwn(sh.env, k) && sh.env[k] !== '' ? [sh.env[k]] : [];
      delete sh.env[k];
    }
    if (on.has('i')) sh.intVars.add(k);
    if (off.has('i')) sh.intVars.delete(k);
    try {
      if (assigning) sh.assign(k, idx, plus === '+', value, !raw);
      else if (!Object.hasOwn(sh.env, k) && !Object.hasOwn(sh.arrays, k) && (on.has('r') || on.has('x'))) sh.env[k] = '';
    } catch (e) {
      ctx.err(`bash: ${mode}: ${e.message}\n`); ctx.fail = 1; continue;
    }
    if (on.has('x')) sh.exported.add(k);
    if (off.has('x')) sh.exported.delete(k);
    if (on.has('r')) sh.readonly.add(k);
  }
}
commands.declare = ctx => declare(ctx, 'declare');
commands.typeset = ctx => declare(ctx, 'typeset');
commands.local = ctx => declare(ctx, 'local');
commands.readonly = ctx => declare(ctx, 'readonly');

commands.unset = ctx => {
  const sh = ctx.sh;
  let mode = '';
  const names = ctx.args.filter(a => {
    if (/^-[fvn]+$/.test(a)) { mode = a.includes('f') ? 'f' : 'v'; return false; }
    return true;
  });
  for (const a of names) {
    const m = /^([A-Za-z_]\w*)(?:\[([^\]]*)\])?$/.exec(a);
    if (!m) { ctx.err(`bash: unset: \`${a}': not a valid identifier\n`); ctx.fail = 1; continue; }
    const [, k, idx] = m;
    if (mode === 'f') { delete sh.funcs[k]; continue; }
    const isVar = Object.hasOwn(sh.env, k) || Object.hasOwn(sh.arrays, k);
    if (!isVar && !mode && idx === undefined && Object.hasOwn(sh.funcs, k)) { delete sh.funcs[k]; continue; }
    if (!isVar) continue;
    if (sh.readonly.has(k)) { ctx.err(`bash: unset: ${k}: cannot unset: readonly variable\n`); ctx.fail = 1; continue; }
    if (idx !== undefined && idx !== '@' && idx !== '*') {
      if (!Object.hasOwn(sh.arrays, k)) { if (sh.arrayIndex(k, idx) === 0) delete sh.env[k]; continue; }
      const n = sh.arrayIndex(k, idx);
      if (n < sh.arrays[k].length) sh.arrays[k][n] = null;
      continue;
    }
    delete sh.env[k];
    delete sh.arrays[k];
    sh.exported.delete(k);
    sh.intVars.delete(k);
  }
};

// printf -v VAR FORMAT ...: store the result instead of printing it.
const printfOut = commands.printf;
commands.printf = ctx => {
  if (ctx.args[0] !== '-v') return printfOut(ctx);
  const target = ctx.args[1];
  const m = /^([A-Za-z_]\w*)(?:\[([^\]]*)\])?$/.exec(target ?? '');
  if (!m) { ctx.err(`bash: printf: \`${target ?? ''}': not a valid identifier\n`); return 2; }
  let buf = '';
  const sub = { ...ctx, args: ctx.args.slice(2), out: t => { buf += t; }, fail: 0 };
  const code = printfOut(sub) ?? (sub.fail ? 1 : 0);
  ctx.sh.assign(m[1], m[2], false, buf, true);
  return code;
};

// ---------- set ----------

const SET_LONG = { errexit: 'e', nounset: 'u', xtrace: 'x', pipefail: null };
commands.set = ctx => {
  const sh = ctx.sh, args = ctx.args;
  if (!args.length) {
    const keys = [...new Set([...Object.keys(sh.env), ...Object.keys(sh.arrays)])].sort();
    for (const k of keys) {
      if (Object.hasOwn(sh.arrays, k)) ctx.out(describeVar(sh, k).replace(/^declare \S+ /, ''));
      else ctx.out(`${k}='${sh.env[k].replace(/'/g, "'\\''")}'\n`);
    }
    return;
  }
  const short = { e: 'errexit', u: 'nounset', x: 'xtrace' };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--' || a === '-') { sh.argv = [sh.argv[0], ...args.slice(i + 1)]; return; }
    if (a === '-o' || a === '+o') {
      const name = args[i + 1];
      if (name === undefined) {
        for (const k of Object.keys(SET_LONG)) ctx.out(a === '-o' ? `${k.padEnd(15)}\t${sh.opts[k] ? 'on' : 'off'}\n` : `set ${sh.opts[k] ? '-' : '+'}o ${k}\n`);
        return;
      }
      if (!Object.hasOwn(SET_LONG, name)) { ctx.err(`bash: set: ${name}: invalid option name\n`); return 2; }
      sh.opts[name] = a === '-o';
      i++;
      continue;
    }
    if (/^[-+][A-Za-z]+$/.test(a)) {
      for (const c of a.slice(1)) {
        if (!short[c]) { ctx.err(`bash: set: ${a[0]}${c}: invalid option\nset: usage: set [-eux] [-o errexit|nounset|xtrace|pipefail] [--] [arg ...]\n`); return 2; }
        sh.opts[short[c]] = a[0] === '-';
      }
      continue;
    }
    // Anything else replaces the positional parameters.
    sh.argv = [sh.argv[0], ...args.slice(i)];
    return;
  }
};

// ---------- mapfile / readarray ----------

commands.mapfile = commands.readarray = ctx => {
  const { o, rest } = opts(ctx, 't', 'nsdu');
  const sh = ctx.sh, name = rest[0] ?? 'MAPFILE';
  if (!/^[A-Za-z_]\w*$/.test(name)) { ctx.err(`bash: ${ctx.name}: \`${name}': not a valid identifier\n`); return 1; }
  if (sh.readonly.has(name)) { ctx.err(`bash: ${ctx.name}: ${name}: readonly variable\n`); return 1; }
  const text = ctx.stdin;
  if (text === null) { ctx.err(`bash: ${ctx.name}: HackTerm kann nicht auf Tastatureingaben warten - nutze: mapfile -t zeilen < datei\n`); return 1; }
  const d = o.d === undefined ? '\n' : (o.d[0] ?? '\0');
  const items = [];
  let pos = 0;
  while (pos < text.length && items.length < 10000) {
    const j = text.indexOf(d, pos);
    const end = j < 0 ? text.length : j + 1;
    const item = text.slice(pos, end);
    items.push(o.t && j >= 0 ? item.slice(0, -1) : item);
    pos = end;
  }
  const skip = parseInt(o.s ?? '0', 10) || 0, max = parseInt(o.n ?? '0', 10) || 0;
  sh.arrays[name] = items.slice(skip, max ? skip + max : undefined);
  delete sh.env[name];
};

// ---------- getopts ----------

commands.getopts = ctx => {
  const sh = ctx.sh;
  const [spec, name, ...given] = ctx.args;
  if (spec === undefined || name === undefined) { ctx.err('bash: getopts: usage: getopts optstring name [arg ...]\n'); return 2; }
  if (!/^[A-Za-z_]\w*$/.test(name)) { ctx.err(`bash: getopts: \`${name}': not a valid identifier\n`); return 1; }
  const args = given.length ? given : sh.argv.slice(1);
  const g = sh.getopt;
  // OPTIND=1 by the user restarts the scan.
  if (String(g.ind) !== String(sh.env.OPTIND ?? '1')) { g.ind = Math.max(1, parseInt(sh.env.OPTIND, 10) || 1); g.sub = 1; }
  const silent = spec.startsWith(':');
  const done = () => { sh.setVar(name, '?'); sh.env.OPTIND = String(g.ind); return 1; };
  const word = args[g.ind - 1];
  if (word === undefined) return done();
  if (g.sub === 1) {
    if (word === '--') { g.ind++; return done(); }
    if (!word.startsWith('-') || word === '-') return done();
  }
  const c = word[g.sub];
  g.sub++;
  const restOfWord = word.slice(g.sub);
  if (g.sub >= word.length) { g.ind++; g.sub = 1; }
  const at = c === ':' ? -1 : spec.indexOf(c);
  delete sh.env.OPTARG;
  if (at < 0) {
    if (silent) sh.env.OPTARG = c;
    else ctx.err(`${sh.argv[0]}: illegal option -- ${c}\n`);
    sh.setVar(name, '?');
  } else if (spec[at + 1] === ':') {
    if (restOfWord) { sh.env.OPTARG = restOfWord; g.ind++; g.sub = 1; sh.setVar(name, c); }
    else if (args[g.ind - 1] !== undefined) { sh.env.OPTARG = args[g.ind - 1]; g.ind++; sh.setVar(name, c); }
    else if (silent) { sh.env.OPTARG = c; sh.setVar(name, ':'); }
    else { ctx.err(`${sh.argv[0]}: option requires an argument -- ${c}\n`); sh.setVar(name, '?'); }
  } else sh.setVar(name, c);
  sh.env.OPTIND = String(g.ind);
  return 0;
};

// ---------- trap ----------

const SIGNALS = ['EXIT', 'HUP', 'INT', 'QUIT', 'ILL', 'TRAP', 'ABRT', 'BUS', 'FPE', 'KILL', 'USR1', 'SEGV', 'USR2', 'PIPE', 'ALRM', 'TERM'];
const sigName = x => {
  if (/^\d+$/.test(x)) return SIGNALS[+x];
  const n = x.toUpperCase().replace(/^SIG/, '');
  return SIGNALS.includes(n) || n === 'ERR' || n === 'DEBUG' || n === 'RETURN' ? n : undefined;
};
commands.trap = ctx => {
  const sh = ctx.sh;
  let args = ctx.args;
  if (args[0] === '-l') { ctx.out(SIGNALS.slice(1).map((n, i) => `${String(i + 1).padStart(2)}) SIG${n}`).join('\n') + '\n'); return; }
  if (args[0] === '--') args = args.slice(1);
  if (!args.length || args[0] === '-p') {
    const want = args.slice(1).map(sigName);
    for (const k of Object.keys(sh.traps)) if (!want.length || want.includes(k)) ctx.out(`trap -- '${sh.traps[k].replace(/'/g, "'\\''")}' ${k}\n`);
    return;
  }
  // `trap SIG` alone resets it, like `trap - SIG`.
  let action = args[0], sigs = args.slice(1);
  if (!sigs.length) { sigs = [action]; action = '-'; }
  for (const x of sigs) {
    const n = sigName(x);
    if (!n) { ctx.err(`bash: trap: ${x}: invalid signal specification\n`); ctx.fail = 1; continue; }
    if (action === '-') delete sh.traps[n]; else sh.traps[n] = action;
  }
};
// exit at the prompt still runs the EXIT trap, even if there is no way out of HackTerm.
const exitCmd = commands.exit;
commands.exit = commands.logout = ctx => {
  const sh = ctx.sh;
  if (!sh.depth && sh.traps.EXIT) {
    const t = sh.traps.EXIT;
    delete sh.traps.EXIT;
    sh.runLine(t, ctx.io);
  }
  return exitCmd(ctx);
};

// ---------- directory stack ----------

const tilde = (sh, d) => (sh.env.HOME && (d === sh.env.HOME || d.startsWith(sh.env.HOME + '/')) ? '~' + d.slice(sh.env.HOME.length) : d);
function printDirs(ctx, flags = '') {
  const sh = ctx.sh, all = [sh.cwd, ...sh.dirStack];
  const show = d => (flags.includes('l') ? d : tilde(sh, d));
  if (flags.includes('v')) all.forEach((d, i) => ctx.out(`${String(i).padStart(2)}  ${show(d)}\n`));
  else if (flags.includes('p')) all.forEach(d => ctx.out(show(d) + '\n'));
  else ctx.out(all.map(show).join(' ') + '\n');
}
function changeDir(ctx, d, who) {
  const sub = { ...ctx, args: [d], fail: 0, out: () => {}, err: t => ctx.err(t.replace('bash: cd:', `bash: ${who}:`)) };
  const r = commands.cd(sub);
  return (r ?? (sub.fail ? 1 : 0)) === 0;
}
commands.dirs = ctx => {
  const sh = ctx.sh;
  const flags = ctx.args.filter(a => /^-[clpv]+$/.test(a)).join('');
  if (flags.includes('c')) { sh.dirStack = []; return; }
  printDirs(ctx, flags);
};
commands.pushd = ctx => {
  const sh = ctx.sh, a = ctx.args.filter(x => x !== '-n');
  const from = sh.cwd;
  if (!a.length) {
    if (!sh.dirStack.length) { ctx.err('bash: pushd: no other directory\n'); return 1; }
    const top = sh.dirStack[0];
    if (!changeDir(ctx, top, 'pushd')) return 1;
    sh.dirStack[0] = from;
  } else if (/^[+-]\d+$/.test(a[0])) {
    const all = [sh.cwd, ...sh.dirStack];
    const n = +a[0].slice(1), k = a[0][0] === '+' ? n : all.length - 1 - n;
    if (k < 0 || k >= all.length) { ctx.err(`bash: pushd: ${a[0]}: directory stack index out of range\n`); return 1; }
    const rot = [...all.slice(k), ...all.slice(0, k)];
    if (!changeDir(ctx, rot[0], 'pushd')) return 1;
    sh.dirStack = rot.slice(1);
  } else {
    if (!changeDir(ctx, a[0], 'pushd')) return 1;
    sh.dirStack.unshift(from);
    if (sh.dirStack.length > 100) sh.dirStack.length = 100;
  }
  printDirs(ctx);
};
commands.popd = ctx => {
  const sh = ctx.sh, a = ctx.args.filter(x => x !== '-n');
  if (!sh.dirStack.length) { ctx.err('bash: popd: directory stack empty\n'); return 1; }
  if (/^[+-]\d+$/.test(a[0] ?? '')) {
    const all = [sh.cwd, ...sh.dirStack];
    const n = +a[0].slice(1), k = a[0][0] === '+' ? n : all.length - 1 - n;
    if (k < 0 || k >= all.length) { ctx.err(`bash: popd: ${a[0]}: directory stack index out of range\n`); return 1; }
    if (k === 0) { if (!changeDir(ctx, sh.dirStack[0], 'popd')) return 1; sh.dirStack.shift(); }
    else sh.dirStack.splice(k - 1, 1);
  } else {
    if (!changeDir(ctx, sh.dirStack[0], 'popd')) return 1;
    sh.dirStack.shift();
  }
  printDirs(ctx);
};

// ---------- jobs (background jobs finish at once in HackTerm) ----------

const findJob = (sh, spec) => {
  if (spec === undefined || spec === '%' || spec === '%%' || spec === '%+') return sh.jobs[sh.jobs.length - 1];
  if (/^%\d+$/.test(spec)) return sh.jobs.find(j => j.n === +spec.slice(1));
  if (spec.startsWith('%')) return sh.jobs.find(j => j.cmd.startsWith(spec.slice(1)));
  return undefined;
};
commands.jobs = ctx => {
  const sh = ctx.sh, f = ctx.args.join('');
  if (f.includes('p')) { for (const j of sh.jobs) ctx.out(j.pid + '\n'); return; }
  sh.reportJobs(ctx.io, () => true, f.includes('l'), ctx.out);
};
commands.wait = ctx => {
  const sh = ctx.sh;
  let code = 0;
  for (const a of ctx.args.filter(x => x !== '-n')) {
    if (a.startsWith('%')) {
      const j = findJob(sh, a);
      if (!j) { ctx.err(`bash: wait: ${a}: no such job\n`); code = 127; continue; }
      code = j.code;
    } else if (/^\d+$/.test(a)) {
      if (!sh.jobCodes.has(+a)) { ctx.err(`bash: wait: pid ${a} is not a child of this shell\n`); code = 127; continue; }
      code = sh.jobCodes.get(+a);
    } else { ctx.err(`bash: wait: \`${a}': not a pid or valid job spec\n`); code = 2; }
  }
  return code;
};
commands.fg = commands.bg = ctx => {
  const j = findJob(ctx.sh, ctx.args[0]);
  if (!j) { ctx.err(`bash: ${ctx.name}: ${ctx.args[0] ?? 'current'}: no such job\n`); return 1; }
  ctx.err(`bash: ${ctx.name}: job has terminated\n`);
  ctx.sh.jobs = ctx.sh.jobs.filter(x => x !== j);
  ctx.err(`[${j.n}]+  ${(j.code ? `Exit ${j.code}` : 'Done').padEnd(24)}${j.cmd}\n`);
  return 1;
};

// type shows a function's source.
const typeCmd = commands.type;
commands.type = ctx => {
  const sh = ctx.sh;
  for (const n of ctx.args) {
    if (!Object.hasOwn(sh.aliases, n) && Object.hasOwn(sh.funcs, n)) ctx.out(`${n} is a function\n${funcText(n, sh.funcs[n])}`);
    else {
      const sub = { ...ctx, args: [n], fail: 0 };
      typeCmd(sub);
      if (sub.fail) ctx.fail = 1;
    }
  }
};

Object.assign(MAN, {
  declare: ['declare [-aifFgprx] [NAME[=WERT]...]', 'Setzt Variablen mit Eigenschaften: -a Array, -i Ganzzahl (Zuweisungen werden gerechnet), -r schreibgeschuetzt, -x exportiert. -p zeigt Variablen, -f/-F zeigt Funktionen. In Funktionen sind die Variablen lokal. typeset ist dasselbe.', ['declare -i n=5*4; echo $n', 'declare -a ziele=(web01 db01); declare -p ziele', 'declare -F'], 'Skripte'],
  readonly: ['readonly NAME[=WERT]...', 'Macht Variablen schreibgeschuetzt - Aendern und unset schlagen fehl.', ['readonly KEY=geheim; KEY=neu'], 'Skripte'],
  set: ['set [-eux] [-o pipefail] [-- ARG...]', 'Shell-Optionen: -e bricht beim ersten Fehler ab, -u meckert ueber leere Variablen, -x zeigt jeden Befehl (+ ...), -o pipefail laesst Pipes scheitern, wenn ein Teil scheitert. set -- a b c setzt $1 $2 $3. +e usw. schaltet aus.', ['set -x; echo $HOME; set +x', 'set -- rot gruen; echo $2', 'set -o pipefail; false | true; echo $?'], 'Skripte'],
  mapfile: ['mapfile [-t] [-n N] [-s N] [ARRAY]', 'Liest alle Zeilen von stdin in ein Array (Standard: MAPFILE). -t entfernt den Zeilenumbruch. readarray ist dasselbe.', ['mapfile -t zeilen < notes.txt; echo ${#zeilen[@]} Zeilen', 'ls | readarray -t dateien'], 'Skripte'],
  getopts: ['getopts OPTSTRING NAME [ARG...]', 'Wertet Optionen wie -v -f datei aus, meist in einer while-Schleife. Ein : nach dem Buchstaben heisst "braucht ein Argument" ($OPTARG).', ['f() { while getopts "vf:" o; do echo "$o $OPTARG"; done; }; f -v -f log'], 'Skripte'],
  trap: ['trap BEFEHL SIGNAL...', 'Fuehrt BEFEHL aus, wenn ein Signal kommt. EXIT laeuft am Ende eines Skripts, ERR nach jedem fehlgeschlagenen Befehl. trap - SIG entfernt, trap -p zeigt, trap -l listet Signale.', ["trap 'echo Aufraeumen' EXIT", "trap 'echo Fehler: $?' ERR; false"], 'Skripte'],
  pushd: ['pushd [VERZ]   popd   dirs [-v]', 'Verzeichnis-Stapel: pushd wechselt und merkt sich das alte Verzeichnis, popd springt zurueck, dirs zeigt den Stapel.', ['pushd /var/log; pushd /etc; dirs -v; popd; popd'], 'Skripte'],
  jobs: ['BEFEHL &   jobs   wait [PID]', 'Startet einen Befehl im Hintergrund ($! ist seine PID). In HackTerm sind Hintergrund-Jobs sofort fertig; jobs zeigt sie, wait liefert ihren Exit-Code.', ['sleep 1 & echo PID $!; wait $!', 'false & wait $!; echo $?'], 'Skripte'],
  unset: ['unset [-fv] NAME...', 'Loescht Variablen, Array-Elemente (unset arr[1]) oder Funktionen (-f).', ['x=1; unset x; echo "[$x]"', 'a=(1 2 3); unset a[1]; echo ${a[@]}'], 'Shell'],
});
for (const k of ['typeset']) MAN[k] = MAN.declare;
for (const k of ['readarray']) MAN[k] = MAN.mapfile;
for (const k of ['popd', 'dirs']) MAN[k] = MAN.pushd;
for (const k of ['wait', 'fg', 'bg']) MAN[k] = MAN.jobs;

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
