// Learning mode: turns common beginner mistakes into a short, concrete tip. DOM-free.
import { commands } from './commands.js';
import { normalize } from './vfs.js';

// Windows / DOS habits and their Linux counterpart.
const WINDOWS = {
  dir: 'ls -l', cls: 'clear', copy: 'cp', move: 'mv', del: 'rm', erase: 'rm', ren: 'mv', rename: 'mv',
  md: 'mkdir', rd: 'rmdir', ipconfig: 'ip a', tasklist: 'ps aux', taskkill: 'kill PID', findstr: 'grep',
  more: 'less', tracert: 'traceroute', where: 'which', systeminfo: 'uname -a', ver: 'uname -r', attrib: 'chmod',
  notepad: 'nano', edit: 'nano', shutdown: 'reboot',
};

// Edit distance with adjacent swaps (grpe -> grep counts as one typo). Names are short, so a full table is fine.
function dist(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

// Closest candidate within a typo budget that depends on the word length.
function closest(word, candidates) {
  const budget = word.length <= 3 ? 1 : 2;
  let best = null, bestD = budget + 1;
  for (const c of candidates) {
    if (c === word) continue;
    if (Math.abs(c.length - word.length) > budget) continue;
    const d = dist(word.toLowerCase(), c.toLowerCase());
    if (d < bestD || (d === bestD && best && c.length < best.length)) { best = c; bestD = d; }
  }
  return bestD <= budget ? best : null;
}

const names = sh => [...new Set([...Object.keys(commands), ...Object.keys(sh.aliases), ...Object.keys(sh.funcs)])]
  .filter(n => /^[a-z][\w.-]*$/i.test(n));

function notFound(sh, run, x) {
  const all = names(sh);
  const call = run.cmds.find(c => c.name === x && c.code === 127);
  if (x.startsWith('[')) return { id: 'bracket', text: '[ ist selbst ein Befehl und braucht Leerzeichen drumherum: [ -f datei ]  (auch vor dem schliessenden ])' };
  if (call && (call.args[0] === '=' || call.args[0]?.startsWith('='))) {
    return { id: 'assign', text: `Bei Zuweisungen kein Leerzeichen um das =: ${x}=${(call.args[0] === '=' ? call.args[1] : call.args[0].slice(1)) ?? 'wert'}` };
  }
  const lower = x.toLowerCase();
  if (WINDOWS[lower] && !commands[lower]) return { id: 'win:' + lower, text: `${x} ist ein Windows-Befehl. Unter Linux heisst das: ${WINDOWS[lower]}` };
  // cd.. / ls-la: the space between command and argument is missing.
  const glued = all.filter(c => x.startsWith(c) && /^[.\-/~]/.test(x.slice(c.length))).sort((a, b) => b.length - a.length)[0];
  if (glued) return { id: 'space', text: `Zwischen Befehl und Argument gehoert ein Leerzeichen: ${glued} ${x.slice(glued.length)}` };
  const here = sh.fs.tryLookup(normalize(x, sh.cwd));
  if (here && here.t === 'f' && !x.includes('/')) {
    const exec = (here.m & 0o111) !== 0;
    return { id: 'dotslash', text: `Programme im aktuellen Ordner startest du mit ./${x}${exec ? '' : `  (vorher ausfuehrbar machen: chmod +x ${x} - oder einfach: bash ${x})`}` };
  }
  if (lower !== x && all.includes(lower)) return { id: 'case', text: `Linux unterscheidet Gross- und Kleinschreibung. Gemeint ist wohl: ${lower}` };
  const near = closest(x, all);
  if (near) return { id: 'typo', text: `Meintest du ${near}?` };
  return { id: 'unknown', once: true, text: 'Diesen Befehl gibt es hier nicht. help listet alle Befehle, TAB vervollstaendigt Namen.' };
}

function missingPath(sh, p) {
  const abs = normalize(p.replace(/^~(?=\/|$)/, sh.env.HOME || '/'), sh.cwd);
  const slash = abs.lastIndexOf('/');
  const dir = abs.slice(0, slash) || '/', base = abs.slice(slash + 1);
  const shown = p.includes('/') ? p.slice(0, p.lastIndexOf('/') + 1) : '';
  let entries = [];
  try { entries = sh.fs.readdir(dir); } catch { /* not readable */ }
  if (!entries.length && sh.fs.tryLookup(dir) === null) return { id: 'nodir', once: true, text: `Den Ordner ${shown || dir} gibt es nicht. Mit ls und TAB tastest du dich Stueck fuer Stueck heran.` };
  const ci = entries.find(e => e.toLowerCase() === base.toLowerCase());
  const near = ci || closest(base, entries);
  if (near) return { id: 'path', text: `Meintest du ${shown}${near}?` };
  return { id: 'nofile', once: true, text: 'Diese Datei gibt es hier nicht. ls zeigt, was im Ordner liegt - und TAB vervollstaendigt Dateinamen.' };
}

// Returns { id, text, once?, spoils? } or null. `once` tips are generic and shown only a few times;
// `spoils` names the trick the tip gives away, so it stays quiet while a mission asks for exactly that.
export function tipFor(sh, run) {
  if (run.incomplete) return { id: 'pending', once: true, text: 'Die Shell wartet auf den Rest (Prompt "> "): ein Anfuehrungszeichen, eine Klammer oder done/fi fehlt noch. Abbrechen mit ^C.' };
  const err = (run.stderr || '').split('\n');
  for (const line of err) {
    let m;
    if ((m = /^bash: (\S+): command not found$/.exec(line))) return notFound(sh, run, m[1]);
    if ((m = /^bash: cd: (.+): Not a directory$/.exec(line))) return { id: 'cdfile', text: `${m[1]} ist eine Datei, kein Ordner. Inhalt anzeigen: cat ${m[1]}` };
    if ((m = /^rm: cannot remove '(.+)': Is a directory$/.exec(line))) return { id: 'rmdir', text: `Ordner loescht rm nur mit -r: rm -r ${m[1]}  (Vorsicht, ohne Papierkorb!) - leere Ordner auch mit rmdir ${m[1]}` };
    if ((m = /^(\w+): (.+): Is a directory$/.exec(line))) return { id: 'isdir', text: `${m[2]} ist ein Ordner. Hineinwechseln: cd ${m[2]}  - Inhalt auflisten: ls ${m[2]}` };
    if ((m = /^bash: (\.\/\S+): Permission denied$/.exec(line))) return { id: 'noexec', text: `Das Skript ist nicht ausfuehrbar. Erst chmod +x ${m[1].slice(2)}, dann ${m[1]}  (oder: bash ${m[1].slice(2)})` };
    if (/Permission denied/.test(line) && sh.fs.user !== 'root') return { id: 'denied', once: true, spoils: 'sudo', text: 'Keine Berechtigung. ls -l zeigt, wem die Datei gehoert. Als Admin hilft sudo - sudo !! wiederholt den letzten Befehl mit sudo.' };
    if ((m = /: (?:cannot (?:access|open|stat) )?'?([^':]+)'?: No such file or directory$/.exec(line))) return missingPath(sh, m[1].trim());
    if (/syntax error/.test(line)) return { id: 'syntax', once: true, text: 'Syntaxfehler: Pruefe Anfuehrungszeichen, Klammern und Schluesselwoerter (if ... then ... fi, for ... do ... done).' };
  }
  return null;
}
