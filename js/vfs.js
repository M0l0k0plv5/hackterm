// In-memory virtual filesystem with Unix-like permissions and symlinks.
// Node shape: { t: 'd'|'f'|'l', m: mode, o: owner, g: group, mt: mtime,
//               c: children (dir) | d: data (file) | to: target (link) }

const MSG = {
  ENOENT: 'No such file or directory',
  ENOTDIR: 'Not a directory',
  EISDIR: 'Is a directory',
  EACCES: 'Permission denied',
  EEXIST: 'File exists',
  ENOTEMPTY: 'Directory not empty',
  ELOOP: 'Too many levels of symbolic links',
  EINVAL: 'Invalid argument',
  EPERM: 'Operation not permitted',
};

export class FsError extends Error {
  constructor(code) {
    super(MSG[code] || code);
    this.code = code;
  }
}
const fail = code => { throw new FsError(code); };

export const now = () => Math.floor(Date.now() / 1000);

// Resolve `path` against `cwd` into a clean absolute path.
export function normalize(path, cwd = '/') {
  if (!path.startsWith('/')) path = cwd + '/' + path;
  const out = [];
  for (const p of path.split('/')) {
    if (!p || p === '.') continue;
    if (p === '..') out.pop();
    else out.push(p);
  }
  return '/' + out.join('/');
}

// Helpers for absolute, normalized paths.
export const parentPath = p => { const i = p.lastIndexOf('/'); return i <= 0 ? '/' : p.slice(0, i); };
export const baseName = p => p.slice(p.lastIndexOf('/') + 1);

const enc = new TextEncoder();

// Directory children are keyed by user-chosen names, so names like "__proto__" or
// "constructor" must never hit Object.prototype: read only own keys, define on write.
export const child = (dir, name) => (Object.hasOwn(dir.c, name) ? dir.c[name] : undefined);
export const setChild = (dir, name, node) =>
  Object.defineProperty(dir.c, name, { value: node, writable: true, enumerable: true, configurable: true });
const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

export class VFS {
  constructor(root) {
    this.root = root;
    this.user = 'hacker';
    this.umask = 0o022;
  }

  // Permission check for the current user: what is 'r', 'w' or 'x'.
  can(node, what) {
    if (this.user === 'root') return true;
    const bit = { r: 4, w: 2, x: 1 }[what];
    const shift = node.o === this.user ? 6 : node.g === this.user ? 3 : 0;
    return !!((node.m >> shift) & bit);
  }

  lookup(path, follow = true, depth = 0) {
    if (depth > 16) fail('ELOOP');
    const parts = path.split('/').filter(Boolean);
    let node = this.root;
    let cur = '';
    for (let i = 0; i < parts.length; i++) {
      if (node.t !== 'd') fail('ENOTDIR');
      if (!this.can(node, 'x')) fail('EACCES');
      const next = child(node, parts[i]);
      if (!next) fail('ENOENT');
      const last = i === parts.length - 1;
      if (next.t === 'l' && (!last || follow)) {
        const target = normalize(next.to, cur || '/');
        const rest = parts.slice(i + 1).join('/');
        return this.lookup(rest ? normalize(target + '/' + rest) : target, follow, depth + 1);
      }
      node = next;
      cur += '/' + parts[i];
    }
    return node;
  }

  tryLookup(path, follow = true) {
    try { return this.lookup(path, follow); } catch { return null; }
  }

  // Resolve the containing directory of `path`.
  parent(path) {
    if (path === '/') fail('EINVAL');
    const dir = this.lookup(parentPath(path));
    if (dir.t !== 'd') fail('ENOTDIR');
    if (!this.can(dir, 'x')) fail('EACCES');
    return { dir, name: baseName(path) };
  }

  node(t, extra, mode) {
    return { t, m: mode, o: this.user, g: this.user, mt: now(), ...extra };
  }

  readFile(path) {
    const n = this.lookup(path);
    if (n.t === 'd') fail('EISDIR');
    if (!this.can(n, 'r')) fail('EACCES');
    return n.d;
  }

  writeFile(path, data, append = false) {
    if (path === '/dev/null') return;
    const { dir, name } = this.parent(path);
    let n = child(dir, name);
    if (n && n.t === 'l') n = this.lookup(path);
    if (n) {
      if (n.t === 'd') fail('EISDIR');
      if (!this.can(n, 'w')) fail('EACCES');
      n.d = append ? n.d + data : data;
      n.mt = now();
    } else {
      if (!this.can(dir, 'w')) fail('EACCES');
      setChild(dir, name, this.node('f', { d: data }, 0o666 & ~this.umask));
      dir.mt = now();
    }
  }

  mkdir(path) {
    const { dir, name } = this.parent(path);
    if (child(dir, name)) fail('EEXIST');
    if (!this.can(dir, 'w')) fail('EACCES');
    setChild(dir, name, this.node('d', { c: {} }, 0o777 & ~this.umask));
    dir.mt = now();
  }

  readdir(path) {
    const n = this.lookup(path);
    if (n.t !== 'd') fail('ENOTDIR');
    if (!this.can(n, 'r')) fail('EACCES');
    return Object.keys(n.c).sort(cmp);
  }

  // Unlink any node; callers decide about emptiness / recursion.
  remove(path) {
    const { dir, name } = this.parent(path);
    if (!child(dir, name)) fail('ENOENT');
    if (!this.can(dir, 'w')) fail('EACCES');
    delete dir.c[name];
    dir.mt = now();
  }

  put(path, node) {
    const { dir, name } = this.parent(path);
    if (!this.can(dir, 'w')) fail('EACCES');
    setChild(dir, name, node);
    dir.mt = now();
  }

  size(n) {
    if (n.t === 'd') return 4096;
    if (n.t === 'l') return n.to.length;
    return enc.encode(n.d).length;
  }

  // Total bytes of all regular files (used by df).
  usage(n = this.root) {
    if (n.t !== 'd') return this.size(n);
    let sum = 4096;
    for (const k in n.c) sum += this.usage(n.c[k]);
    return sum;
  }
}
