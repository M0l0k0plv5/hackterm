// Shell interpreter: lexer, parser, expansion and execution on top of the VFS.
import { VFS, normalize, parentPath, baseName } from './vfs.js';
import { commands, Usage, BUILTINS } from './commands.js';
import { FsError } from './vfs.js';
import { buildWorld, initialProcs } from './world.js';
import { calc } from './awk.js';

class SyntaxErr extends Error {}
class ExpandErr extends Error {}
// Limit for brace expansion so a typo like {1..100000000} cannot freeze the tab.
const MAX_WORDS = 10000;

// Unquoted special characters are replaced by private-use placeholders during
// expansion so that quoted ones stay literal.
const P = { '*': '\uE000', '?': '\uE001', '[': '\uE002', '{': '\uE003', '}': '\uE004', ',': '\uE005' };
const UNP = Object.fromEntries(Object.entries(P).map(([k, v]) => [v, k]));
const restore = s => s.replace(/[\uE000-\uE005]/g, c => UNP[c]);
const HAS_GLOB = /[\uE000-\uE002]/;
const ELF = '\x7fELF';
const KEYWORDS = new Set(['if', 'then', 'else', 'fi', 'for', 'while', 'do', 'done', 'case', 'esac', 'function', 'until']);

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

// Split a command line into raw words (quotes kept) and operators.
function lex(src) {
  const toks = [];
  let w = '', has = false, i = 0;
  const push = () => { if (has) { toks.push({ t: 'w', v: w }); w = ''; has = false; } };
  const eof = q => new SyntaxErr(`unexpected EOF while looking for matching \`${q}'`);
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') { w += src.slice(i, i + 2); has = true; i += 2; continue; }
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
    if (c === '`') {
      const j = src.indexOf('`', i + 1);
      if (j < 0) throw eof('`');
      w += src.slice(i, j + 1); has = true; i = j + 1; continue;
    }
    if (c === ' ' || c === '\t' || c === '\n') { push(); i++; continue; }
    if (c === '#' && !has) break;
    const m = /^(2>&1|2>>|2>|&>|&&|\|\||>>|>|<|\||;|&)/.exec(src.slice(i));
    if (m && !(m[1][0] === '2' && has)) { push(); toks.push({ t: 'o', v: m[1] }); i += m[1].length; continue; }
    if (c === '(' || c === ')') throw new SyntaxErr(`syntax error near unexpected token \`${c}'`);
    w += c; has = true; i++;
  }
  push();
  return toks;
}

// Build a list of pipelines joined by ; && ||.
function parse(toks) {
  const list = [];
  let pipe = [];
  let cmd = { words: [], redirs: [] };
  const empty = () => !cmd.words.length && !cmd.redirs.length;
  const unexpected = v => new SyntaxErr(`syntax error near unexpected token \`${v}'`);
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.t === 'w') { cmd.words.push(t.v); continue; }
    if (['>', '>>', '<', '2>', '2>>', '&>'].includes(t.v)) {
      const n = toks[++i];
      if (!n || n.t !== 'w') throw unexpected(n ? n.v : 'newline');
      cmd.redirs.push({ op: t.v, target: n.v });
      continue;
    }
    if (t.v === '2>&1') { cmd.redirs.push({ op: t.v }); continue; }
    if (empty()) throw unexpected(t.v);
    pipe.push(cmd);
    cmd = { words: [], redirs: [] };
    if (t.v === '|') continue;
    list.push({ pipe, op: t.v });
    pipe = [];
  }
  if (!empty()) pipe.push(cmd);
  else if (pipe.length) throw new SyntaxErr('syntax error: unexpected end of file');
  if (pipe.length) list.push({ pipe, op: ';' });
  return list;
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
    this.cwd = s.cwd || '/home/hacker';
    this.env = s.env || {
      USER: 'hacker', HOME: '/home/hacker', SHELL: '/bin/bash', HOSTNAME: 'box',
      PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'en_US.UTF-8', TERM: 'xterm-256color',
      EDITOR: 'nano', PWD: '/home/hacker',
    };
    this.exported = new Set(s.exported || Object.keys(this.env));
    this.aliases = s.aliases || { ll: 'ls -la', la: 'ls -A' };
    this.history = s.history || [];
    this.procs = s.procs || initialProcs();
    this.nextPid = s.nextPid || 2100;
    this.flags = s.flags || {};
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
      nextPid: this.nextPid, flags: this.flags,
    };
  }

  prompt() {
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
  expand(raw, split = true) {
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
    if (!split) return [restore(fields.join(' '))];
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

  // Entry point for interactive input.
  run(line) {
    this.cmdLog = [];
    this.request = null;
    let stdout = '';
    const io = {
      stdin: null, tty: true,
      out: s => { stdout += s; this.write(s, 'out'); },
      err: s => this.write(s, 'err'),
    };
    if (/(^|[\s;&|])!!/.test(line) && this.history.length) {
      line = line.replace(/!!/g, this.history[this.history.length - 1]);
      this.write(line + '\n', 'out');
    }
    if (line.trim() && this.history[this.history.length - 1] !== line) this.history.push(line);
    const code = this.runLine(line, io);
    return { line, code, cmds: this.cmdLog, stdout: stdout.replace(/\x1b\[[\d;]*m/g, '') };
  }

  runLine(src, io) {
    let list;
    try { list = parse(lex(src)); } catch (e) {
      if (!(e instanceof SyntaxErr)) throw e;
      io.err(`bash: ${e.message}\n`);
      return (this.lastCode = 2);
    }
    let prev = ';';
    for (const item of list) {
      const skip = (prev === '&&' && this.lastCode !== 0) || (prev === '||' && this.lastCode === 0);
      prev = item.op;
      if (skip) continue;
      this.lastCode = this.runPipe(item.pipe, io);
      if (this.exiting) break;
    }
    return this.lastCode;
  }

  runPipe(pipe, io) {
    let stdin = io.stdin, code = 0;
    pipe.forEach((cmd, idx) => {
      const last = idx === pipe.length - 1;
      let buf = '';
      code = this.runSimple(cmd, {
        stdin,
        out: last ? io.out : s => { buf += s; },
        err: io.err,
        tty: last && io.tty,
      });
      stdin = buf;
    });
    return code;
  }

  runSimple(cmd, io) {
    let words = [...cmd.words];
    if (words.length && Object.hasOwn(this.aliases, words[0])) {
      const al = lex(this.aliases[words[0]]).filter(t => t.t === 'w').map(t => t.v);
      words = [...al, ...words.slice(1)];
    }
    const assigns = [];
    while (words.length && /^[A-Za-z_]\w*=/.test(words[0])) assigns.push(words.shift());

    let argv;
    let { stdin, out, err, tty } = io;
    try {
      argv = words.flatMap(w => this.expand(w));
      for (const r of cmd.redirs) {
        if (r.op === '2>&1') { err = out; continue; }
        const target = this.expand(r.target, false)[0];
        const path = normalize(target, this.cwd);
        if (r.op === '<') { stdin = this.fs.readFile(path); continue; }
        this.fs.writeFile(path, '', r.op.endsWith('>>'));
        const sink = s => { try { this.fs.writeFile(path, s, true); } catch { /* target vanished */ } };
        if (r.op[0] === '2') err = sink;
        else if (r.op === '&>') { out = sink; err = sink; tty = false; }
        else { out = sink; tty = false; }
      }
    } catch (e) {
      if (e instanceof ExpandErr) { io.err(`bash: ${e.message}\n`); return 1; }
      if (!(e instanceof FsError)) throw e;
      const r = cmd.redirs.find(x => x.target);
      io.err(`bash: ${r ? restore(r.target) : ''}: ${e.message}\n`);
      return 1;
    }

    const saved = {};
    for (const a of assigns) {
      const eq = a.indexOf('=');
      const k = a.slice(0, eq);
      if (argv.length) saved[k] = this.env[k];
      this.env[k] = this.expand(a.slice(eq + 1), false)[0] ?? '';
    }
    if (!argv.length) return 0;
    try {
      return this.execArgv(argv, { stdin, out, err, tty });
    } finally {
      for (const k in saved) { if (saved[k] === undefined) delete this.env[k]; else this.env[k] = saved[k]; }
    }
  }

  // Execute an already expanded argument vector.
  execArgv(argv, io) {
    const name = argv[0];
    if (name.includes('/')) return this.execFile(name, argv, io);
    if (KEYWORDS.has(name)) {
      io.err(`bash: ${name}: control structures are not supported in this simulator\n`);
      return 2;
    }
    const fn = commands[name];
    if (!fn) {
      io.err(`bash: ${name}: command not found\n`);
      this.cmdLog.push({ name, args: argv.slice(1), code: 127 });
      return 127;
    }
    const ctx = {
      name, args: argv.slice(1), stdin: io.stdin, out: io.out, err: io.err, tty: io.tty, io,
      sh: this, fs: this.fs, p: x => normalize(x, this.cwd), fail: 0,
    };
    let code;
    try { code = fn(ctx); } catch (e) {
      if (e instanceof Usage) { io.err(`${name}: ${e.message}\nTry 'man ${name}' for more information.\n`); code = 2; }
      else if (e instanceof FsError) { io.err(`${name}: ${e.message}\n`); code = 1; }
      else { io.err(`${name}: internal error: ${e.message}\n`); code = 70; }
    }
    code = code ?? (ctx.fail ? 1 : 0);
    this.cmdLog.push({ name, args: ctx.args, code });
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

  runScript(text, argv, io) {
    if (this.depth >= 8) { io.err('bash: maximum script nesting level exceeded\n'); return 1; }
    const savedArgv = this.argv;
    this.argv = argv;
    this.depth++;
    let code = 0;
    try {
      for (const line of text.split('\n')) {
        if (!line.trim() || line.startsWith('#!')) continue;
        code = this.runLine(line, io);
        if (this.exiting) break;
      }
    } finally {
      this.depth--;
      this.argv = savedArgv;
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

export { parentPath };
