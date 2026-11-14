// Gamification: missions, XP, ranks and achievements. DOM-free.
import { commands, C } from './commands.js';
import { ACCESS_CODE } from './world.js';

const HOME = '/home/hacker';
const ran = (run, name) => run.cmds.some(c => c.name === name && c.code === 0);
const used = (run, name) => run.cmds.some(c => c.name === name);
const node = (sh, p) => sh.fs.tryLookup(p);
const isAllFlag = a => /^-\w*[aA]/.test(a) || a === '--all' || a === '--almost-all';
// True if an ls listing contains a dot entry other than "." and "..".
const showsHidden = out => out.split(/\s+/).some(w => /^\.[^.\s/]/.test(w) || /^\.\.[^\s/]/.test(w));

export const RANKS = [
  [0, 'Script Kiddie'], [150, 'Rookie'], [450, 'Operator'], [800, 'Sysadmin'],
  [1200, 'Hacker'], [1700, 'Elite'], [2000, 'Root'],
];

export const CHAPTERS = ['Orientierung', 'Dateien', 'Lesen & Suchen', 'Pipes & Umleitung', 'Rechte & System'];

export const MISSIONS = [
  // --- Chapter 1 ---
  { ch: 0, xp: 30, title: 'Wer bin ich?',
    brief: 'Du bist in ein fremdes System eingeloggt. Finde zuerst heraus, unter welchem Benutzer du arbeitest.',
    hint: 'Tippe: whoami', check: (sh, r) => ran(r, 'whoami') },
  { ch: 0, xp: 30, title: 'Standort bestimmen',
    brief: 'Jede Shell hat ein aktuelles Verzeichnis. Lass dir anzeigen, wo du gerade bist (print working directory).',
    hint: 'Tippe: pwd', check: (sh, r) => ran(r, 'pwd') },
  { ch: 0, xp: 30, title: 'Umsehen',
    brief: 'Was liegt hier herum? Liste den Inhalt des aktuellen Verzeichnisses auf.',
    hint: 'Tippe: ls', check: (sh, r) => ran(r, 'ls') },
  { ch: 0, xp: 30, title: 'Versteckte Dateien',
    brief: 'Dateien, die mit einem Punkt beginnen, sind versteckt. In deinem Home-Verzeichnis liegen welche - zeige ALLE Dateien an, auch die versteckten.',
    hint: 'ls kennt die Option -a (all). Im Home-Verzeichnis: cd ~ und dann ls -la',
    // Only counts if a hidden entry (other than . and ..) actually appeared in the output.
    check: (sh, r) => used(r, 'ls') && showsHidden(r.stdout),
    nudge: (sh, r) => (r.cmds.some(c => c.name === 'ls' && c.args.some(isAllFlag)) && !showsHidden(r.stdout)
      ? 'Richtige Option! Aber hier gibt es keine versteckten Dateien. Wechsle mit "cd ~" in dein Home und versuch es dort.' : null) },
  { ch: 0, xp: 30, title: 'Briefing lesen',
    brief: 'In deinem Home liegt eine readme.txt. Gib ihren Inhalt aus.',
    hint: 'cat gibt Dateien aus: cat readme.txt', check: (sh, r) => r.stdout.includes('OPERATION NIGHTFALL') },
  { ch: 0, xp: 30, title: 'Verzeichnis wechseln',
    brief: 'Wechsle in das Verzeichnis documents und sieh dich dort um.',
    hint: 'cd documents', check: sh => sh.cwd === HOME + '/documents' },
  { ch: 0, xp: 30, title: 'Zurueck nach Hause',
    brief: 'Kehre in dein Home-Verzeichnis zurueck. Es gibt mehrere Wege: "cd ..", "cd ~" oder einfach "cd".',
    hint: 'cd ohne Argument bringt dich immer nach Hause.', check: (sh, r) => used(r, 'cd') && sh.cwd === HOME },
  // --- Chapter 2 ---
  { ch: 1, xp: 50, title: 'Werkzeugkiste',
    brief: 'Lege in deinem Home ein neues Verzeichnis namens tools an.',
    hint: 'mkdir tools', check: sh => node(sh, HOME + '/tools')?.t === 'd' },
  { ch: 1, xp: 50, title: 'Leere Datei',
    brief: 'Erzeuge im Verzeichnis tools eine leere Datei scan.sh.',
    hint: 'touch tools/scan.sh', check: sh => node(sh, HOME + '/tools/scan.sh')?.t === 'f' },
  { ch: 1, xp: 50, title: 'Erstes Skript',
    brief: 'Schreibe eine Zeile in tools/scan.sh. Mit ">" leitest du die Ausgabe eines Befehls in eine Datei um.',
    hint: 'echo \'echo Scanning...\' > tools/scan.sh', check: sh => (node(sh, HOME + '/tools/scan.sh')?.d ?? '').trim().length > 0 },
  { ch: 1, xp: 50, title: 'Sicherungskopie',
    brief: 'Kopiere notes.txt nach notes.bak (im Home-Verzeichnis).',
    hint: 'cp notes.txt notes.bak', check: sh => node(sh, HOME + '/notes.bak')?.t === 'f' },
  { ch: 1, xp: 50, title: 'Umbenennen',
    brief: 'Benenne notes.bak in archive.txt um. Umbenennen heisst unter Unix: verschieben.',
    hint: 'mv notes.bak archive.txt', check: sh => !!node(sh, HOME + '/archive.txt') && !node(sh, HOME + '/notes.bak') },
  { ch: 1, xp: 50, title: 'Spuren verwischen',
    brief: 'Loesche archive.txt wieder. Vorsicht: rm kennt keinen Papierkorb.',
    hint: 'rm archive.txt', check: (sh, r) => used(r, 'rm') && !node(sh, HOME + '/archive.txt') && !node(sh, HOME + '/notes.bak') },
  // --- Chapter 3 ---
  { ch: 2, xp: 70, title: 'Kopfzeilen',
    brief: 'Logs koennen riesig sein. Zeige nur die ersten 3 Zeilen von logs/access.log an.',
    hint: 'head -n 3 logs/access.log', check: (sh, r) => ran(r, 'head') },
  { ch: 2, xp: 70, title: 'Das Ende zaehlt',
    brief: 'Die neuesten Eintraege stehen am Ende. Zeige die letzten 3 Zeilen von logs/auth.log.',
    hint: 'tail -n 3 logs/auth.log', check: (sh, r) => ran(r, 'tail') },
  { ch: 2, xp: 70, title: 'Nadel im Heuhaufen',
    brief: 'Jemand probiert Passwoerter durch. Suche in logs/auth.log alle Zeilen, die "Failed" enthalten.',
    hint: 'grep Failed logs/auth.log', check: (sh, r) => ran(r, 'grep') && r.stdout.includes('Failed password') },
  { ch: 2, xp: 70, title: 'Zeilen zaehlen',
    brief: 'Wie viele Zeilen hat logs/auth.log? Lass sie zaehlen.',
    hint: 'wc -l logs/auth.log', check: (sh, r) => r.cmds.some(c => c.name === 'wc' && c.code === 0 && c.args.some(a => /^-\w*l/.test(a))) },
  { ch: 2, xp: 70, title: 'Schluesselsuche',
    brief: 'Irgendwo im System liegt eine Datei mit der Endung .key. Durchsuche das gesamte Dateisystem ab /. Fehlermeldungen kannst du mit 2>/dev/null ausblenden.',
    hint: 'find / -name "*.key" 2>/dev/null', check: (sh, r) => used(r, 'find') && r.stdout.includes('master.key') },
  // --- Chapter 4 ---
  { ch: 3, xp: 100, title: 'Die Pipe',
    brief: 'Mit | wird die Ausgabe eines Befehls zur Eingabe des naechsten. Zaehle die fehlgeschlagenen Logins: filtere mit grep und zaehle mit wc.',
    hint: 'grep Failed logs/auth.log | wc -l', check: (sh, r) => used(r, 'grep') && used(r, 'wc') && r.stdout.trim() === '7' },
  { ch: 3, xp: 100, title: 'Beweise sichern',
    brief: 'Speichere alle "Failed"-Zeilen aus logs/auth.log in der Datei failed.txt in deinem Home.',
    hint: 'grep Failed logs/auth.log > failed.txt', check: sh => (node(sh, HOME + '/failed.txt')?.d ?? '').includes('Failed password') },
  { ch: 3, xp: 100, title: 'Wer klopft am lautesten?',
    brief: 'Finde heraus, welche IP am haeufigsten in logs/access.log auftaucht. Schneide die erste Spalte aus (cut oder awk), sortiere, zaehle Duplikate (uniq -c) und sortiere numerisch.',
    hint: "cut -d' ' -f1 logs/access.log | sort | uniq -c | sort -nr",
    check: (sh, r) => used(r, 'sort') && used(r, 'uniq') && /\b5 10\.0\.0\.66/.test(r.stdout) },
  { ch: 3, xp: 100, title: 'Verschluesselte Fracht',
    brief: 'In downloads/payload.b64 liegt eine Base64-kodierte Nachricht. Dekodiere sie.',
    hint: 'base64 -d downloads/payload.b64', check: (sh, r) => r.stdout.includes(ACCESS_CODE) },
  // --- Chapter 5 ---
  { ch: 4, xp: 150, title: 'Ausfuehrbar machen',
    brief: 'Dein Skript tools/scan.sh darf noch nicht ausgefuehrt werden. Gib ihm das Execute-Recht und starte es danach mit ./tools/scan.sh',
    hint: 'chmod +x tools/scan.sh   (falls die Datei fehlt: mkdir -p tools; echo "echo Scanning..." > tools/scan.sh)',
    check: sh => !!((node(sh, HOME + '/tools/scan.sh')?.m ?? 0) & 0o100) },
  { ch: 4, xp: 150, title: 'Superuser',
    brief: '/etc/shadow enthaelt die Passwort-Hashes und ist nur fuer root lesbar. Probier es erst normal - dann mit sudo.',
    hint: 'sudo cat /etc/shadow', check: (sh, r) => used(r, 'sudo') && r.stdout.includes('root:$6$') },
  { ch: 4, xp: 150, title: 'Der Parasit',
    brief: 'Die CPU gluecht: Ein Krypto-Miner laeuft auf der Box. Finde den Prozess mit ps aux (Tipp: | grep xmrig) und beende ihn ueber seine PID.',
    hint: 'ps aux | grep xmrig   ->   kill 1337', check: sh => !sh.procs.some(p => p.pid === 1337) },
  { ch: 4, xp: 300, title: 'Capture the Flag',
    brief: 'Letzte Mission: In /root liegt flag.txt. Das Verzeichnis gehoert root - du weisst inzwischen, was zu tun ist.',
    hint: 'sudo cat /root/flag.txt', check: (sh, r) => r.stdout.includes('FLAG{') },
];

export const ACHIEVEMENTS = [
  { id: 'pipe', name: 'Pipe Dream', desc: 'Erste Pipe gebaut', test: (g, sh, r) => r.line.includes('|') && r.cmds.length >= 2 },
  { id: 'man', name: 'RTFM', desc: 'Das Handbuch gelesen', test: (g, sh, r) => ran(r, 'man') },
  { id: 'sudo', name: 'Great Power', desc: 'Zum ersten Mal sudo benutzt', test: (g, sh, r) => used(r, 'sudo') },
  { id: 'explorer', name: 'Kartograph', desc: '8 verschiedene Verzeichnisse besucht', test: g => g.s.dirs.length >= 8 },
  { id: 'toolbox', name: 'Werkzeugkasten', desc: '20 verschiedene Befehle benutzt', test: g => g.s.used.length >= 20 },
  { id: 'rmrf', name: 'Chaos-Agent', desc: 'rm -rf / versucht', test: (g, sh, r) => r.cmds.some(c => c.name === 'rm' && c.args.includes('/')) },
  { id: 'matrix', name: 'White Rabbit', desc: 'cmatrix gestartet', test: (g, sh, r) => used(r, 'cmatrix') },
  { id: 'script', name: 'Automatisierer', desc: 'Ein eigenes Skript ausgefuehrt', test: (g, sh, r) => r.cmds.some(c => c.script && c.code === 0) },
  { id: 'century', name: 'Tastaturheld', desc: '100 Befehle eingegeben', test: g => g.s.cmds >= 100 },
];
const ACH_XP = 25;
const META = new Set(['mission', 'hint', 'missions', 'stats', 'help', 'theme', 'reset']);

export class Game {
  constructor(saved) {
    this.s = Object.assign({ xp: 0, idx: 0, ach: [], cmds: 0, hints: 0, dirs: [], used: [] }, saved);
  }
  get mission() { return MISSIONS[this.s.idx] || null; }
  rank(xp = this.s.xp) {
    let i = 0;
    while (i + 1 < RANKS.length && xp >= RANKS[i + 1][0]) i++;
    const next = RANKS[i + 1]?.[0] ?? null;
    return { i, name: RANKS[i][1], min: RANKS[i][0], next, progress: next ? (xp - RANKS[i][0]) / (next - RANKS[i][0]) : 1 };
  }

  // Evaluate a finished command line; returns a list of events for the UI.
  afterRun(sh, run) {
    const events = [];
    if (!run.cmds.length) return events;
    const before = this.rank().i;
    this.s.cmds++;
    for (const c of run.cmds) if (c.code !== 127 && !this.s.used.includes(c.name)) this.s.used.push(c.name);
    if (!this.s.dirs.includes(sh.cwd)) this.s.dirs.push(sh.cwd);
    const m = this.mission;
    if (m && !run.cmds.every(c => META.has(c.name))) {
      let ok = false;
      try { ok = !!m.check(sh, run); } catch { ok = false; }
      if (ok) {
        this.s.xp += m.xp;
        this.s.idx++;
        events.push({ type: 'mission', mission: m, number: this.s.idx, next: this.mission });
      } else if (m.nudge) {
        let text = null;
        try { text = m.nudge(sh, run); } catch { text = null; }
        if (text) events.push({ type: 'nudge', text });
      }
    }
    for (const a of ACHIEVEMENTS) {
      if (this.s.ach.includes(a.id)) continue;
      let ok = false;
      try { ok = !!a.test(this, sh, run); } catch { ok = false; }
      if (ok) { this.s.ach.push(a.id); this.s.xp += ACH_XP; events.push({ type: 'ach', ach: a, xp: ACH_XP }); }
    }
    const after = this.rank();
    if (after.i > before) events.push({ type: 'rank', rank: after.name });
    return events;
  }

  // Text renderings (ANSI coloured) shared by commands and UI.
  missionText() {
    const m = this.mission;
    if (!m) return `${C.bgreen}Alle Missionen abgeschlossen.${C.r} Das System gehoert dir - freies Spiel.\nTipp: help, man <befehl>, stats\n`;
    const n = String(this.s.idx + 1).padStart(2, '0');
    return `${C.bcyan}┌─ MISSION ${n}/${MISSIONS.length} · Kapitel ${m.ch + 1}: ${CHAPTERS[m.ch]}${C.r}\n` +
      `${C.bcyan}│${C.r} ${C.b}${m.title}${C.r}\n${C.bcyan}│${C.r} ${m.brief}\n` +
      `${C.bcyan}└─${C.r} ${C.yellow}+${m.xp} XP${C.r} ${C.gray}· Tipp gefaellig? -> hint${C.r}\n`;
  }
  eventText(e) {
    if (e.type === 'mission') {
      return `\n${C.bgreen}✔ MISSION ${String(e.number).padStart(2, '0')} ABGESCHLOSSEN: ${e.mission.title}${C.r}  ${C.byellow}+${e.mission.xp} XP${C.r}\n` +
        (e.next && e.next.ch !== e.mission.ch ? `${C.bcyan}★ Kapitel ${e.mission.ch + 1} "${CHAPTERS[e.mission.ch]}" gemeistert!${C.r}\n` : '') +
        '\n' + this.missionText();
    }
    if (e.type === 'ach') return `${C.byellow}🏆 ERFOLG: ${e.ach.name}${C.r} ${C.gray}- ${e.ach.desc}${C.r}  ${C.byellow}+${e.xp} XP${C.r}\n`;
    if (e.type === 'nudge') return `${C.yellow}» ${e.text}${C.r}\n`;
    if (e.type === 'rank') return `${C.bred}▲ RANG-AUFSTIEG:${C.r} ${C.b}${e.rank.toUpperCase()}${C.r}\n`;
    return '';
  }
}

// ---- game commands ----

commands.mission = ctx => { ctx.out(ctx.sh.game.missionText()); };
commands.hint = ctx => {
  const g = ctx.sh.game;
  const m = g.mission;
  if (!m) { ctx.out('Keine offene Mission.\n'); return; }
  g.s.hints++;
  ctx.out(`${C.yellow}TIPP:${C.r} ${m.hint}\n`);
};
commands.missions = ctx => {
  const g = ctx.sh.game;
  let s = '';
  MISSIONS.forEach((m, i) => {
    if (i === 0 || MISSIONS[i - 1].ch !== m.ch) s += `\n${C.bcyan}Kapitel ${m.ch + 1}: ${CHAPTERS[m.ch]}${C.r}\n`;
    const mark = i < g.s.idx ? `${C.green}[x]${C.r}` : i === g.s.idx ? `${C.byellow}[>]${C.r}` : `${C.gray}[ ]${C.r}`;
    const title = i <= g.s.idx ? m.title : `${C.gray}???${C.r}`;
    s += ` ${mark} ${String(i + 1).padStart(2, '0')} ${title}\n`;
  });
  ctx.out(s.slice(1));
};
commands.stats = ctx => {
  const g = ctx.sh.game;
  const r = g.rank();
  const bar = n => '█'.repeat(Math.round(n * 20)).padEnd(20, '░');
  let s = `${C.bcyan}OPERATOR-PROFIL${C.r}\n`;
  s += ` Rang      ${C.b}${r.name}${C.r}\n`;
  s += ` XP        ${g.s.xp}${r.next ? ` / ${r.next}` : ''}\n`;
  s += ` Fortschr. ${C.green}${bar(r.progress)}${C.r}\n`;
  s += ` Missionen ${g.s.idx}/${MISSIONS.length}\n`;
  s += ` Befehle   ${g.s.cmds} eingegeben, ${g.s.used.length} verschiedene\n`;
  s += ` Tipps     ${g.s.hints}\n\n${C.bcyan}ERFOLGE${C.r} ${g.s.ach.length}/${ACHIEVEMENTS.length}\n`;
  for (const a of ACHIEVEMENTS) {
    const got = g.s.ach.includes(a.id);
    s += got ? ` ${C.byellow}🏆 ${a.name}${C.r} - ${a.desc}\n` : ` ${C.gray}🔒 ???${C.r}\n`;
  }
  ctx.out(s);
};
commands.reset = ctx => {
  if (ctx.args[0] !== '--hard') {
    ctx.out('Setzt Dateisystem UND Spielstand zurueck. Zum Bestaetigen: reset --hard\n');
    return 1;
  }
  ctx.sh.request = { type: 'reset' };
};
