// A small awk interpreter (tokenizer, recursive-descent parser, tree-walking evaluator).
// Also exposes calc() for shell arithmetic and bc. No dynamic code evaluation is used.

export class AwkError extends Error {}

function tokenize(src) {
  const toks = [];
  let i = 0;
  const isVal = () => {
    const t = toks[toks.length - 1];
    return !!t && (t.t === 'num' || t.t === 'str' || t.t === 'id' || t.v === ')' || t.v === ']');
  };
  const num = /(\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+)/y;
  const id = /[A-Za-z_]\w*/y;
  const op = /\*\*=|\*\*|\+\+|--|&&|\|\||[-+*/%^]=|==|!=|<=|>=|!~|[-+*/%^!<>=~?:,;(){}[\]$]/y;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\r') { i++; continue; }
    if (c === '\\' && src[i + 1] === '\n') { i += 2; continue; }
    if (c === '#') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '\n') { toks.push({ t: 'nl', v: '\n' }); i++; continue; }
    if (c === '"') {
      let j = i + 1, s = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\') { const n = src[++j]; s += n === 'n' ? '\n' : n === 't' ? '\t' : n ?? ''; } else s += src[j];
        j++;
      }
      if (j >= src.length) throw new AwkError('unterminated string');
      toks.push({ t: 'str', v: s });
      i = j + 1;
      continue;
    }
    if (c === '/' && !isVal()) {
      let j = i + 1, s = '';
      while (j < src.length && src[j] !== '/' && src[j] !== '\n') {
        if (src[j] === '\\' && src[j + 1] === '/') { s += '/'; j += 2; continue; }
        if (src[j] === '\\') { s += src[j] + (src[j + 1] ?? ''); j += 2; continue; }
        s += src[j++];
      }
      if (src[j] !== '/') throw new AwkError('unterminated regexp');
      toks.push({ t: 're', v: s });
      i = j + 1;
      continue;
    }
    let m;
    num.lastIndex = id.lastIndex = op.lastIndex = i;
    if ((m = num.exec(src))) { toks.push({ t: 'num', v: parseFloat(m[0]) }); i = num.lastIndex; continue; }
    if ((m = id.exec(src))) { toks.push({ t: 'id', v: m[0] }); i = id.lastIndex; continue; }
    if ((m = op.exec(src))) { toks.push({ t: 'op', v: m[0] }); i = op.lastIndex; continue; }
    throw new AwkError(`syntax error: unexpected character '${c}'`);
  }
  return toks;
}

const LVALUE = ['var', 'index', 'field'];
const KEYWORDS = new Set(['if', 'else', 'while', 'for', 'in', 'print', 'printf', 'next', 'exit', 'break', 'continue', 'delete', 'BEGIN', 'END', 'do']);

class Parser {
  constructor(toks) { this.t = toks; this.i = 0; this.noGt = false; }
  peek() { return this.t[this.i]; }
  isOp(v) { const t = this.t[this.i]; return !!t && t.t === 'op' && t.v === v; }
  isId(v) { const t = this.t[this.i]; return !!t && t.t === 'id' && t.v === v; }
  eat(v) { if (this.isOp(v)) { this.i++; return true; } return false; }
  expect(v) { if (!this.eat(v)) throw new AwkError(`syntax error: expected '${v}'${this.peek() ? ` near '${this.peek().v}'` : ''}`); }
  skipNl() { while (this.peek() && this.peek().t === 'nl') this.i++; }
  skipTerm() { while (this.peek() && (this.peek().t === 'nl' || this.isOp(';'))) this.i++; }
  atEnd() { const t = this.peek(); return !t || t.t === 'nl' || this.isOp(';') || this.isOp('}'); }

  program() {
    const rules = [];
    for (;;) {
      this.skipTerm();
      if (!this.peek()) break;
      const rule = { kind: 'main', pat: null, act: null };
      if (this.isId('BEGIN') || this.isId('END')) rule.kind = this.t[this.i++].v;
      else if (!this.isOp('{')) rule.pat = this.expr();
      if (this.isOp('{')) rule.act = this.block();
      else if (rule.kind !== 'main') throw new AwkError(`syntax error: ${rule.kind} needs an action`);
      rules.push(rule);
    }
    return rules;
  }

  block() {
    this.expect('{');
    const stmts = [];
    for (;;) {
      this.skipTerm();
      if (!this.peek()) throw new AwkError("syntax error: missing '}'");
      if (this.eat('}')) break;
      stmts.push(this.stmt());
    }
    return ['block', stmts];
  }

  simple() {
    if (this.isId('print') || this.isId('printf')) {
      const kind = this.t[this.i++].v;
      const args = [];
      if (!this.atEnd()) {
        const saved = this.noGt;
        this.noGt = true;
        do { this.skipNl(); args.push(this.expr()); } while (this.eat(','));
        this.noGt = saved;
      }
      return [kind, args];
    }
    if (this.isId('delete')) {
      this.i++;
      const name = this.t[this.i++];
      if (!name || name.t !== 'id') throw new AwkError('syntax error: delete needs an array');
      let key = null;
      if (this.eat('[')) { key = this.expr(); this.expect(']'); }
      return ['delete', name.v, key];
    }
    for (const k of ['next', 'exit', 'break', 'continue']) {
      if (this.isId(k)) { this.i++; if (k === 'exit' && !this.atEnd()) this.expr(); return [k]; }
    }
    return ['expr', this.expr()];
  }

  stmt() {
    if (this.isOp('{')) return this.block();
    if (this.isId('if')) {
      this.i++;
      this.expect('(');
      const cond = this.expr();
      this.expect(')');
      this.skipNl();
      const then = this.stmt();
      const save = this.i;
      this.skipTerm();
      if (this.isId('else')) { this.i++; this.skipNl(); return ['if', cond, then, this.stmt()]; }
      this.i = save;
      return ['if', cond, then, null];
    }
    if (this.isId('while')) {
      this.i++;
      this.expect('(');
      const cond = this.expr();
      this.expect(')');
      this.skipNl();
      return ['while', cond, this.stmt()];
    }
    if (this.isId('for')) {
      this.i++;
      this.expect('(');
      const a = this.t[this.i], b = this.t[this.i + 1], c = this.t[this.i + 2], d = this.t[this.i + 3];
      if (a && a.t === 'id' && b && b.t === 'id' && b.v === 'in' && c && c.t === 'id' && d && d.v === ')') {
        this.i += 4;
        this.skipNl();
        return ['forin', a.v, c.v, this.stmt()];
      }
      const init = this.isOp(';') ? null : this.simple();
      this.expect(';');
      const cond = this.isOp(';') ? null : this.expr();
      this.expect(';');
      const step = this.isOp(')') ? null : this.simple();
      this.expect(')');
      this.skipNl();
      return ['for', init, cond, step, this.stmt()];
    }
    return this.simple();
  }

  expr() { return this.assign(); }
  assign() {
    const left = this.ternary();
    const t = this.peek();
    if (t && t.t === 'op' && /^([-+*/%^]|\*\*)?=$/.test(t.v)) {
      if (!LVALUE.includes(left[0])) throw new AwkError('syntax error: invalid assignment target');
      this.i++;
      return ['assign', t.v.slice(0, -1), left, this.assign()];
    }
    return left;
  }
  ternary() {
    const c = this.or();
    if (this.eat('?')) { const a = this.assign(); this.expect(':'); return ['cond', c, a, this.assign()]; }
    return c;
  }
  or() { let l = this.and(); while (this.eat('||')) { this.skipNl(); l = ['or', l, this.and()]; } return l; }
  and() { let l = this.inOp(); while (this.eat('&&')) { this.skipNl(); l = ['and', l, this.inOp()]; } return l; }
  inOp() {
    let l = this.match();
    while (this.isId('in')) {
      this.i++;
      const name = this.t[this.i++];
      if (!name || name.t !== 'id') throw new AwkError("syntax error near 'in'");
      l = ['in', l, name.v];
    }
    return l;
  }
  match() {
    let l = this.cmp();
    while (this.isOp('~') || this.isOp('!~')) {
      const neg = this.t[this.i++].v === '!~';
      l = ['match', l, this.cmp(), neg];
    }
    return l;
  }
  cmp() {
    const l = this.concat();
    const t = this.peek();
    if (t && t.t === 'op' && ['<', '<=', '==', '!=', '>', '>='].includes(t.v) && !(t.v === '>' && this.noGt)) {
      this.i++;
      return ['cmp', t.v, l, this.concat()];
    }
    return l;
  }
  concat() {
    let l = this.add();
    for (;;) {
      const t = this.peek();
      if (!t) break;
      const starts = t.t === 'num' || t.t === 'str' || (t.t === 'id' && !KEYWORDS.has(t.v)) || (t.t === 'op' && (t.v === '$' || t.v === '('));
      if (!starts) break;
      l = ['concat', l, this.add()];
    }
    return l;
  }
  add() {
    let l = this.mul();
    while (this.isOp('+') || this.isOp('-')) { const o = this.t[this.i++].v; l = ['bin', o, l, this.mul()]; }
    return l;
  }
  mul() {
    let l = this.unary();
    while (this.isOp('*') || this.isOp('/') || this.isOp('%')) { const o = this.t[this.i++].v; l = ['bin', o, l, this.unary()]; }
    return l;
  }
  unary() {
    if (this.eat('!')) return ['not', this.unary()];
    if (this.eat('-')) return ['neg', this.unary()];
    if (this.eat('+')) return ['pos', this.unary()];
    return this.pow();
  }
  pow() {
    const b = this.postfix();
    if (this.eat('^') || this.eat('**')) return ['bin', '^', b, this.unary()];
    return b;
  }
  postfix() {
    if (this.isOp('++') || this.isOp('--')) {
      const o = this.t[this.i++].v;
      const target = this.postfix();
      if (!LVALUE.includes(target[0])) throw new AwkError(`syntax error near '${o}'`);
      return ['pre', o, target];
    }
    const p = this.primary();
    if ((this.isOp('++') || this.isOp('--')) && LVALUE.includes(p[0])) return ['post', this.t[this.i++].v, p];
    return p;
  }
  primary() {
    const t = this.t[this.i++];
    if (!t) throw new AwkError('syntax error: unexpected end of program');
    if (t.t === 'num') return ['num', t.v];
    if (t.t === 'str') return ['str', t.v];
    if (t.t === 're') return ['re', t.v];
    if (t.t === 'op' && t.v === '$') return ['field', this.primary()];
    if (t.t === 'op' && t.v === '(') {
      const saved = this.noGt;
      this.noGt = false;
      const e = this.expr();
      this.noGt = saved;
      this.expect(')');
      return ['group', e];
    }
    if (t.t === 'id' && !KEYWORDS.has(t.v)) {
      if (this.eat('(')) {
        const args = [];
        if (!this.eat(')')) {
          do { args.push(this.expr()); } while (this.eat(','));
          this.expect(')');
        }
        return ['call', t.v, args];
      }
      if (this.eat('[')) { const k = this.expr(); this.expect(']'); return ['index', t.v, k]; }
      return ['var', t.v];
    }
    throw new AwkError(`syntax error near '${t.v === '\n' ? 'newline' : t.v}'`);
  }
}

const NUM_RE = /^\s*[-+]?(\d+\.?\d*|\.\d+)([eE][-+]?\d+)?\s*$/;
const NUM_PREFIX = /^\s*[-+]?(\d+\.?\d*([eE][-+]?\d+)?|\.\d+)/;

class Interp {
  constructor({ out = () => {}, FS = ' ', vars = {}, int = false } = {}) {
    this.out = out;
    this.int = int;
    this.vars = Object.assign(Object.create(null), { NR: 0, NF: 0, FS, OFS: ' ', ORS: '\n' }, vars);
    this.line = '';
    this.fields = [];
    this.steps = 0;
    this.reCache = new Map();
  }
  tick() { if (++this.steps > 500000) throw new AwkError('step limit exceeded (endless loop?)'); }
  num(v) {
    if (typeof v === 'number') return v;
    if (v == null) return 0;
    const m = NUM_PREFIX.exec(v);
    return m ? parseFloat(m[0]) : 0;
  }
  str(v) {
    if (v == null) return '';
    if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(Number(v.toPrecision(6)));
    return v;
  }
  looksNum(v) { return v == null || typeof v === 'number' || NUM_RE.test(v); }
  truthy(v) {
    if (v == null) return false;
    if (typeof v === 'number') return v !== 0;
    return v !== '' && !(NUM_RE.test(v) && parseFloat(v) === 0);
  }
  regex(src) {
    let re = this.reCache.get(src);
    if (!re) {
      try { re = new RegExp(src); } catch { throw new AwkError(`invalid regular expression /${src}/`); }
      this.reCache.set(src, re);
    }
    return re;
  }
  toRe(node, val) { return this.regex(node[0] === 're' ? node[1] : this.str(val ?? this.ev(node))); }
  setLine(l) {
    this.line = l;
    const FS = this.str(this.vars.FS);
    if (FS === ' ') this.fields = l.trim() ? l.trim().split(/\s+/) : [];
    else if (l === '') this.fields = [];
    else this.fields = l.split(FS === '\\t' ? '\t' : FS.length > 1 ? this.regex(FS) : FS);
    this.vars.NF = this.fields.length;
  }
  getField(n) { return n === 0 ? this.line : this.fields[n - 1] ?? ''; }
  setField(n, v) {
    if (n === 0) { this.setLine(this.str(v)); return; }
    while (this.fields.length < n) this.fields.push('');
    this.fields[n - 1] = this.str(v);
    this.vars.NF = this.fields.length;
    this.line = this.fields.join(this.str(this.vars.OFS));
  }
  arr(name) {
    let a = this.vars[name];
    if (a == null) a = this.vars[name] = Object.create(null);
    if (typeof a !== 'object') throw new AwkError(`can't use scalar ${name} as array`);
    return a;
  }
  get(node) {
    if (node[0] === 'var') {
      const v = this.vars[node[1]];
      if (v !== null && typeof v === 'object') throw new AwkError(`attempt to use array ${node[1]} in a scalar context`);
      return v ?? null;
    }
    if (node[0] === 'index') return this.arr(node[1])[this.str(this.ev(node[2]))] ?? null;
    return this.getField(Math.trunc(this.num(this.ev(node[1]))));
  }
  set(node, v) {
    if (node[0] === 'var') {
      if (node[1] === 'NF') { this.fields.length = Math.max(0, Math.trunc(this.num(v))); this.line = this.fields.join(this.str(this.vars.OFS)); }
      this.vars[node[1]] = v;
    } else if (node[0] === 'index') this.arr(node[1])[this.str(this.ev(node[2]))] = v;
    else this.setField(Math.trunc(this.num(this.ev(node[1]))), v);
    return v;
  }
  arith(o, a, b) {
    a = this.num(a); b = this.num(b);
    switch (o) {
      case '+': return a + b;
      case '-': return a - b;
      case '*': return a * b;
      case '/':
        if (b === 0) throw new AwkError('division by zero');
        return this.int ? Math.trunc(a / b) : a / b;
      case '%':
        if (b === 0) throw new AwkError('division by zero');
        return a % b;
      default: return a ** b;
    }
  }
  ev(n) {
    this.tick();
    switch (n[0]) {
      case 'num': case 'str': return n[1];
      case 're': return this.regex(n[1]).test(this.line) ? 1 : 0;
      case 'group': return this.ev(n[1]);
      case 'var': case 'index': case 'field': return this.get(n);
      case 'assign': return this.set(n[2], n[1] ? this.arith(n[1] === '**' ? '^' : n[1], this.get(n[2]), this.ev(n[3])) : this.ev(n[3]));
      case 'cond': return this.truthy(this.ev(n[1])) ? this.ev(n[2]) : this.ev(n[3]);
      case 'or': return this.truthy(this.ev(n[1])) || this.truthy(this.ev(n[2])) ? 1 : 0;
      case 'and': return this.truthy(this.ev(n[1])) && this.truthy(this.ev(n[2])) ? 1 : 0;
      case 'not': return this.truthy(this.ev(n[1])) ? 0 : 1;
      case 'neg': return -this.num(this.ev(n[1]));
      case 'pos': return this.num(this.ev(n[1]));
      case 'in': return this.str(this.ev(n[1])) in this.arr(n[2]) ? 1 : 0;
      case 'match': {
        const hit = this.toRe(n[2]).test(this.str(this.ev(n[1])));
        return hit !== n[3] ? 1 : 0;
      }
      case 'cmp': {
        const a = this.ev(n[2]), b = this.ev(n[3]);
        let d;
        if (this.looksNum(a) && this.looksNum(b)) d = this.num(a) - this.num(b);
        else { const x = this.str(a), y = this.str(b); d = x < y ? -1 : x > y ? 1 : 0; }
        const r = { '<': d < 0, '<=': d <= 0, '==': d === 0, '!=': d !== 0, '>': d > 0, '>=': d >= 0 }[n[1]];
        return r ? 1 : 0;
      }
      case 'concat': return this.str(this.ev(n[1])) + this.str(this.ev(n[2]));
      case 'bin': return this.arith(n[1], this.ev(n[2]), this.ev(n[3]));
      case 'pre': return this.set(n[2], this.num(this.get(n[2])) + (n[1] === '++' ? 1 : -1));
      case 'post': {
        const old = this.num(this.get(n[2]));
        this.set(n[2], old + (n[1] === '++' ? 1 : -1));
        return old;
      }
      case 'call': return this.call(n[1], n[2]);
      default: throw new AwkError('internal: unknown node ' + n[0]);
    }
  }
  format(fmt, args) {
    let i = 0;
    return fmt.replace(/%(-?)(0?)(\d*)(?:\.(\d+))?([sdifxXcoeg%])/g, (m, left, zero, w, prec, t) => {
      if (t === '%') return '%';
      const v = args[i++];
      let s;
      if (t === 's') { s = this.str(v); if (prec) s = s.slice(0, +prec); }
      else if (t === 'c') s = typeof v === 'number' ? String.fromCharCode(v) : this.str(v)[0] ?? '';
      else if (t === 'd' || t === 'i') s = String(Math.trunc(this.num(v)));
      else if (t === 'x' || t === 'X') { s = Math.trunc(this.num(v)).toString(16); if (t === 'X') s = s.toUpperCase(); }
      else if (t === 'o') s = Math.trunc(this.num(v)).toString(8);
      else if (t === 'e') s = this.num(v).toExponential(prec ? +prec : 6);
      else if (t === 'g') s = String(Number(this.num(v).toPrecision(prec ? +prec : 6)));
      else s = this.num(v).toFixed(prec ? +prec : 6);
      const width = +w || 0;
      return left ? s.padEnd(width) : s.padStart(width, zero && t !== 's' ? '0' : ' ');
    });
  }
  call(name, a) {
    const s = k => this.str(this.ev(a[k]));
    const need = n => { if (a.length < n) throw new AwkError(`${name}: not enough arguments`); };
    switch (name) {
      case 'length': {
        if (!a.length) return this.line.length;
        if (a[0][0] === 'var' && this.vars[a[0][1]] !== null && typeof this.vars[a[0][1]] === 'object') return Object.keys(this.vars[a[0][1]]).length;
        return s(0).length;
      }
      case 'substr': {
        need(2);
        const str = s(0);
        let start = Math.round(this.num(this.ev(a[1])));
        let len = a[2] ? Math.round(this.num(this.ev(a[2]))) : Infinity;
        if (start < 1) { len += start - 1; start = 1; }
        return len <= 0 ? '' : str.substr(start - 1, len);
      }
      case 'index': need(2); return s(0).indexOf(s(1)) + 1;
      case 'toupper': need(1); return s(0).toUpperCase();
      case 'tolower': need(1); return s(0).toLowerCase();
      case 'int': need(1); return Math.trunc(this.num(this.ev(a[0])));
      case 'sqrt': need(1); return Math.sqrt(this.num(this.ev(a[0])));
      case 'rand': return Math.random();
      case 'sprintf': need(1); return this.format(s(0), a.slice(1).map(x => this.ev(x)));
      case 'split': {
        need(2);
        if (a[1][0] !== 'var') throw new AwkError('split: second argument must be an array');
        const str = s(0);
        const sep = a[2] ? (a[2][0] === 're' ? this.regex(a[2][1]) : s(2)) : this.str(this.vars.FS);
        const parts = str === '' ? [] : sep === ' ' ? str.trim().split(/\s+/) : str.split(sep);
        const arr = (this.vars[a[1][1]] = Object.create(null));
        parts.forEach((p, i) => { arr[i + 1] = p; });
        return parts.length;
      }
      case 'sub': case 'gsub': {
        need(2);
        const src = this.toRe(a[0]).source;
        const re = new RegExp(src, name === 'gsub' ? 'g' : '');
        const rep = s(1).replace(/\$/g, '$$$$').replace(/\\&|&/g, m => (m === '&' ? '$&' : '&'));
        const target = a[2] ?? ['field', ['num', 0]];
        if (!LVALUE.includes(target[0])) throw new AwkError(`${name}: third argument must be assignable`);
        const before = this.str(this.get(target));
        let count = 0;
        before.replace(re, m => { count++; return m; });
        if (count) this.set(target, before.replace(re, rep));
        return count;
      }
      case 'match': {
        need(2);
        const m = this.toRe(a[1]).exec(s(0));
        this.vars.RSTART = m ? m.index + 1 : 0;
        this.vars.RLENGTH = m ? m[0].length : -1;
        return this.vars.RSTART;
      }
      default: throw new AwkError(`function ${name} not defined`);
    }
  }
  // Statement execution; returns a control signal or undefined.
  exec(n) {
    this.tick();
    switch (n[0]) {
      case 'block':
        for (const s of n[1]) { const r = this.exec(s); if (r) return r; }
        return;
      case 'expr': this.ev(n[1]); return;
      case 'print':
        this.out((n[1].length ? n[1].map(e => this.str(this.ev(e))).join(this.str(this.vars.OFS)) : this.line) + this.str(this.vars.ORS));
        return;
      case 'printf':
        if (!n[1].length) throw new AwkError('printf: no format');
        this.out(this.format(this.str(this.ev(n[1][0])), n[1].slice(1).map(e => this.ev(e))));
        return;
      case 'if':
        if (this.truthy(this.ev(n[1]))) return this.exec(n[2]);
        return n[3] ? this.exec(n[3]) : undefined;
      case 'while':
        while (this.truthy(this.ev(n[1]))) {
          const r = this.exec(n[2]);
          if (r === 'break') break;
          if (r && r !== 'continue') return r;
        }
        return;
      case 'for':
        if (n[1]) this.exec(n[1]);
        while (!n[2] || this.truthy(this.ev(n[2]))) {
          const r = this.exec(n[4]);
          if (r === 'break') break;
          if (r && r !== 'continue') return r;
          if (n[3]) this.exec(n[3]);
        }
        return;
      case 'forin':
        for (const k of Object.keys(this.arr(n[2]))) {
          this.vars[n[1]] = k;
          const r = this.exec(n[3]);
          if (r === 'break') break;
          if (r && r !== 'continue') return r;
        }
        return;
      case 'delete':
        if (n[2]) delete this.arr(n[1])[this.str(this.ev(n[2]))]; else this.vars[n[1]] = Object.create(null);
        return;
      default: return n[0]; // next | exit | break | continue
    }
  }
}

// Run an awk program over an array of input lines.
export function awkRun(program, lines, options) {
  const rules = new Parser(tokenize(program)).program();
  const it = new Interp(options);
  let exited = false;
  const runKind = kind => {
    for (const r of rules) {
      if (r.kind !== kind) continue;
      if (it.exec(r.act) === 'exit') { exited = true; return; }
    }
  };
  runKind('BEGIN');
  if (!exited && rules.some(r => r.kind !== 'BEGIN')) {
    for (const l of lines()) {
      it.vars.NR = it.num(it.vars.NR) + 1;
      it.setLine(l);
      for (const r of rules) {
        if (r.kind !== 'main') continue;
        if (r.pat && !it.truthy(it.ev(r.pat))) continue;
        const sig = r.act ? it.exec(r.act) : (it.out(it.line + it.str(it.vars.ORS)), undefined);
        if (sig === 'next') break;
        if (sig === 'exit') { exited = true; break; }
      }
      if (exited) break;
    }
  }
  runKind('END');
}

// Evaluate a single arithmetic expression (shell $((...)) and bc).
export function calc(src, { vars = {}, int = false } = {}) {
  const p = new Parser(tokenize(src).filter(t => t.t !== 'nl'));
  const ast = p.expr();
  if (p.peek()) throw new AwkError(`syntax error near '${p.peek().v}'`);
  const it = new Interp({ vars, int });
  const v = it.num(it.ev(ast));
  return { value: v, vars: it.vars };
}
