// Initial world: filesystem contents, process table, fake network and man pages.
import { now } from './vfs.js';

const T0 = now() - 3 * 86400;
const f = (d, m = 0o644, o = 'root', age = 0) => ({ t: 'f', d, m, o, g: o, mt: T0 + age });
const d = (c, m = 0o755, o = 'root', age = 0) => ({ t: 'd', c, m, o, g: o, mt: T0 + age });
const l = (to, o = 'root') => ({ t: 'l', to, m: 0o777, o, g: o, mt: T0 });
const h = (data, m = 0o644, age = 86400) => f(data, m, 'hacker', age);
const hd = (c, m = 0o755, age = 86400) => d(c, m, 'hacker', age);

export const ACCESS_CODE = '4815162342';
export const FLAG = 'FLAG{r00t_4cc3ss_gr4nt3d}';

const AUTH_LOG = `Nov 12 08:13:55 box sshd[811]: Accepted password for hacker from 192.168.1.10 port 50122 ssh2
Nov 12 08:20:11 box sshd[902]: Failed password for root from 10.0.0.66 port 41022 ssh2
Nov 12 08:20:14 box sshd[902]: Failed password for root from 10.0.0.66 port 41022 ssh2
Nov 12 08:20:19 box sshd[904]: Failed password for admin from 10.0.0.66 port 41030 ssh2
Nov 12 09:02:41 box sudo: hacker : TTY=pts/0 ; PWD=/home/hacker ; COMMAND=/usr/bin/apt update
Nov 12 09:45:03 box sshd[1004]: Failed password for invalid user oracle from 172.16.4.20 port 33810 ssh2
Nov 12 10:11:27 box sshd[1010]: Accepted publickey for hacker from 192.168.1.10 port 50340 ssh2
Nov 12 11:30:52 box sshd[1102]: Failed password for root from 10.0.0.66 port 41188 ssh2
Nov 12 11:30:55 box sshd[1102]: Failed password for root from 10.0.0.66 port 41188 ssh2
Nov 12 12:00:01 box CRON[1200]: pam_unix(cron:session): session opened for user root
Nov 12 13:37:00 box sshd[1337]: Failed password for hacker from 203.0.113.7 port 60001 ssh2
Nov 12 13:37:42 box sshd[1340]: Accepted password for hacker from 192.168.1.10 port 50911 ssh2
`;

const ACCESS_LOG = `192.168.1.10 - - [12/Nov/2026:08:14:02 +0100] "GET /index.html HTTP/1.1" 200 1043
10.0.0.66 - - [12/Nov/2026:08:19:40 +0100] "GET /admin HTTP/1.1" 403 199
10.0.0.66 - - [12/Nov/2026:08:19:44 +0100] "POST /login HTTP/1.1" 401 87
192.168.1.23 - - [12/Nov/2026:08:25:10 +0100] "GET /style.css HTTP/1.1" 200 5120
10.0.0.66 - - [12/Nov/2026:08:31:02 +0100] "POST /login HTTP/1.1" 401 87
172.16.4.20 - - [12/Nov/2026:09:44:51 +0100] "GET /robots.txt HTTP/1.1" 404 153
192.168.1.10 - - [12/Nov/2026:10:12:00 +0100] "GET /dashboard HTTP/1.1" 200 8841
10.0.0.66 - - [12/Nov/2026:11:30:40 +0100] "GET /.env HTTP/1.1" 404 153
192.168.1.23 - - [12/Nov/2026:11:58:13 +0100] "GET /index.html HTTP/1.1" 304 0
10.0.0.66 - - [12/Nov/2026:11:59:59 +0100] "POST /login HTTP/1.1" 200 412
203.0.113.7 - - [12/Nov/2026:13:36:48 +0100] "GET /wp-login.php HTTP/1.1" 404 153
192.168.1.10 - - [12/Nov/2026:13:38:05 +0100] "GET /logout HTTP/1.1" 302 0
`;

const README = `=== OPERATION NIGHTFALL ===

Willkommen im System, Operator.

Dieses Terminal verhaelt sich wie eine echte Linux-Shell.
Alles, was du hier lernst, funktioniert genauso auf einem
echten Server.

Wichtige Befehle fuer den Anfang:
  mission    aktuelle Mission anzeigen
  hint       Tipp zur Mission
  help       Uebersicht aller Befehle
  man <cmd>  Handbuch zu einem Befehl

Viel Erfolg. Vertraue niemandem. Lies die Logs.
`;

export function buildWorld() {
  const home = hd({
    '.bashrc': h(`# ~/.bashrc\nalias ll='ls -la'\nalias la='ls -A'\nexport EDITOR=nano\n`),
    '.bash_history': h('', 0o600),
    '.secret': h(`Wenn du das liest, hast du 'ls -a' verstanden.\nVersteckte Dateien beginnen mit einem Punkt.\n`, 0o600),
    'readme.txt': h(README),
    'notes.txt': h(`TODO\n- Logs unter ~/logs pruefen\n- Wer ist 10.0.0.66 ???\n- Irgendwo liegt ein *.key auf dem System\n- /etc/shadow ist nur fuer root lesbar\n`),
    documents: hd({
      'todo.txt': h(`milch kaufen\nserver patchen\npasswort aendern\nbackup pruefen\nserver patchen\n`),
      'contacts.csv': h(`name,alias,city\nTrinity,tr1n,Berlin\nNeo,the_one,Hamburg\nMorpheus,morph,Koeln\nCypher,cyph3r,Berlin\nTank,operator,Muenchen\n`),
      'report.txt': h(`Statusbericht\n\nDer Zugriff auf den Zielserver erfolgte ueber SSH.\nMehrere fehlgeschlagene Logins wurden beobachtet.\nDer Angreifer nutzt vermutlich ein Woerterbuch.\nEmpfehlung: Fail2ban aktivieren, Root-Login sperren.\n`),
    }),
    logs: hd({
      'auth.log': h(AUTH_LOG),
      'access.log': h(ACCESS_LOG),
    }),
    downloads: hd({
      'payload.b64': h(btoa(`ACCESS CODE: ${ACCESS_CODE}\n`) + '\n'),
      'words.txt': h(`banana\napple\ncherry\napple\nbanana\napple\ndate\n`),
      'numbers.txt': h(`42\n7\n1337\n100\n7\n9\n`),
    }),
  }, 0o755, 0);

  const root = d({
    bin: l('usr/bin'),
    sbin: l('usr/sbin'),
    boot: d({ 'vmlinuz-6.8.0-hackterm': f('\x7fELF', 0o600) }),
    dev: d({ null: f('', 0o666), zero: f('', 0o666), random: f('', 0o666), tty: f('', 0o666) }),
    etc: d({
      passwd: f(`root:x:0:0:root:/root:/bin/bash\ndaemon:x:1:1:daemon:/usr/sbin:/usr/sbin/nologin\nwww-data:x:33:33:www-data:/var/www:/usr/sbin/nologin\nsshd:x:105:65534::/run/sshd:/usr/sbin/nologin\nhacker:x:1000:1000:Operator:/home/hacker:/bin/bash\n`),
      shadow: f(`root:$6$nightfall$9aK2xQmW7vB1/:19700:0:99999:7:::\ndaemon:*:19700:0:99999:7:::\nhacker:$6$operator$Xk3mP0zL8rT5/:19700:0:99999:7:::\n`, 0o600),
      group: f(`root:x:0:\nsudo:x:27:hacker\nwww-data:x:33:\nhacker:x:1000:\n`),
      hostname: f('box\n'),
      hosts: f(`127.0.0.1\tlocalhost\n127.0.1.1\tbox\n10.0.0.66\tdarknode.local\n`),
      'os-release': f(`PRETTY_NAME="HackTerm Linux 1.0 (Nightfall)"\nNAME="HackTerm Linux"\nVERSION_ID="1.0"\nID=hackterm\nID_LIKE=debian\n`),
      motd: f(`Unauthorized access is strictly encouraged.\n`),
      sudoers: f(`root\tALL=(ALL:ALL) ALL\n%sudo\tALL=(ALL:ALL) NOPASSWD: ALL\n`, 0o440),
      ssh: d({ sshd_config: f(`Port 22\nPermitRootLogin yes\nPasswordAuthentication yes\n`) }),
      crontab: f(`# m h dom mon dow user command\n0 12 * * * root /usr/local/bin/backup.sh\n`),
    }),
    home: d({ hacker: home }),
    lib: l('usr/lib'),
    mnt: d({}),
    opt: d({}),
    proc: d({
      version: f('Linux version 6.8.0-hackterm (gcc 13.2.0) #1 SMP PREEMPT_DYNAMIC\n', 0o444),
      cpuinfo: f(`processor\t: 0\nmodel name\t: HackTerm Virtual CPU @ 3.20GHz\ncpu cores\t: 4\n`, 0o444),
      meminfo: f(`MemTotal:        8048576 kB\nMemFree:         5120000 kB\nMemAvailable:    6400000 kB\n`, 0o444),
    }, 0o555),
    root: d({
      'flag.txt': f(`${FLAG}\n\nGlueckwunsch, Operator. Du hast root erreicht.\n`, 0o600),
      '.bash_history': f(`cat /var/backups/master.key\npasswd hacker\nrm -rf /tmp/*\n`, 0o600),
    }, 0o700),
    run: d({}),
    srv: d({}),
    tmp: d({ 'session.tmp': h('pid=2048\n') }, 0o777),
    usr: d({
      bin: d({}),
      sbin: d({}),
      lib: d({}),
      local: d({ bin: d({ 'backup.sh': f(`#!/bin/bash\n# nightly backup\ntar -czf /var/backups/home.tar.gz /home\n`, 0o755) }) }),
      share: d({ dict: d({ words: f(`access\nadmin\nbackdoor\ncipher\ndaemon\nexploit\nfirewall\nkernel\npassword\nroot\nshell\n`) }) }),
    }),
    var: d({
      backups: d({ 'master.key': f('KEY-7F3A-9C21-E0B4\n', 0o644) }),
      log: d({
        syslog: f(`Nov 12 08:00:01 box systemd[1]: Started Daily apt download activities.\nNov 12 08:13:55 box sshd[811]: Server listening on 0.0.0.0 port 22.\nNov 12 12:00:01 box CRON[1200]: (root) CMD (/usr/local/bin/backup.sh)\nNov 12 13:37:01 box kernel: [ 1337.000] xmrig[1337]: high CPU usage detected\n`, 0o640),
        'auth.log': f(AUTH_LOG, 0o640),
      }),
      www: d({ html: d({ 'index.html': f(`<html><body><h1>It works!</h1></body></html>\n`) }) }),
      tmp: d({}, 0o777),
    }),
  });
  return root;
}

export const initialProcs = () => [
  { pid: 1, user: 'root', cpu: 0.0, mem: 0.1, tty: '?', time: '0:02', cmd: '/sbin/init' },
  { pid: 2, user: 'root', cpu: 0.0, mem: 0.0, tty: '?', time: '0:00', cmd: '[kthreadd]' },
  { pid: 412, user: 'root', cpu: 0.0, mem: 0.3, tty: '?', time: '0:01', cmd: '/usr/sbin/cron -f' },
  { pid: 811, user: 'root', cpu: 0.1, mem: 0.4, tty: '?', time: '0:03', cmd: 'sshd: /usr/sbin/sshd -D' },
  { pid: 902, user: 'www-data', cpu: 0.2, mem: 1.1, tty: '?', time: '0:07', cmd: 'nginx: worker process' },
  { pid: 1337, user: 'hacker', cpu: 97.3, mem: 12.4, tty: '?', time: '133:37', cmd: './xmrig --donate-level 0 -o darknode.local:3333' },
  { pid: 2048, user: 'hacker', cpu: 0.0, mem: 0.2, tty: 'pts/0', time: '0:00', cmd: '-bash' },
];

export const HOSTS = {
  localhost: '127.0.0.1', box: '127.0.1.1', '127.0.0.1': '127.0.0.1',
  'darknode.local': '10.0.0.66', '10.0.0.66': '10.0.0.66',
  'example.com': '93.184.215.14', 'google.com': '142.250.185.78',
  '8.8.8.8': '8.8.8.8', '1.1.1.1': '1.1.1.1', 'kernel.org': '139.178.84.217',
};

export const SITES = {
  'example.com': `<!doctype html>\n<html>\n<head><title>Example Domain</title></head>\n<body>\n<h1>Example Domain</h1>\n<p>This domain is for use in illustrative examples in documents.</p>\n</body>\n</html>\n`,
  'darknode.local': `<html><body><pre>\n  D A R K N O D E\n  mining pool :3333 -- status: ONLINE\n  workers: 1 (box / pid 1337)\n</pre></body></html>\n`,
  localhost: `<html><body><h1>It works!</h1></body></html>\n`,
};

// Manual pages: name -> [synopsis, description, examples[], category]
export const MAN = {
  pwd: ['pwd', 'Zeigt das aktuelle Arbeitsverzeichnis.', ['pwd'], 'Navigation'],
  cd: ['cd [DIR]', 'Wechselt das Verzeichnis. Ohne Argument: nach Hause. "cd -" springt zurueck.', ['cd documents', 'cd ..', 'cd ~', 'cd -'], 'Navigation'],
  ls: ['ls [-laAhRtrS1d] [FILE]...', 'Listet Verzeichnisinhalte. -l lang, -a auch versteckte, -h lesbare Groessen, -R rekursiv, -t nach Zeit.', ['ls -la', 'ls -lh /etc', 'ls *.txt'], 'Navigation'],
  tree: ['tree [-a] [-d] [-L N] [DIR]', 'Zeigt Verzeichnisse als Baum.', ['tree', 'tree -L 2 /etc'], 'Navigation'],
  cat: ['cat [-n] [FILE]...', 'Gibt Dateien aus (oder stdin). -n nummeriert Zeilen.', ['cat readme.txt', 'cat a.txt b.txt > c.txt'], 'Dateien lesen'],
  head: ['head [-n N] [FILE]...', 'Zeigt die ersten N Zeilen (Standard 10).', ['head -n 3 logs/access.log'], 'Dateien lesen'],
  tail: ['tail [-n N] [FILE]...', 'Zeigt die letzten N Zeilen. "-n +N" ab Zeile N.', ['tail -n 5 logs/auth.log'], 'Dateien lesen'],
  less: ['less [FILE]', 'Zeigt eine Datei an (in der Simulation ohne Blaettern).', ['less notes.txt'], 'Dateien lesen'],
  nl: ['nl [FILE]', 'Nummeriert Zeilen.', ['nl notes.txt'], 'Dateien lesen'],
  tac: ['tac [FILE]', 'Wie cat, aber rueckwaerts (letzte Zeile zuerst).', ['tac notes.txt'], 'Dateien lesen'],
  wc: ['wc [-lwc] [FILE]...', 'Zaehlt Zeilen (-l), Woerter (-w), Bytes (-c).', ['wc -l logs/auth.log', 'ls | wc -l'], 'Dateien lesen'],
  file: ['file FILE...', 'Erraet den Dateityp.', ['file readme.txt'], 'Dateien lesen'],
  stat: ['stat FILE...', 'Zeigt Metadaten: Groesse, Rechte, Besitzer, Zeit.', ['stat notes.txt'], 'Dateien lesen'],
  touch: ['touch FILE...', 'Legt leere Dateien an oder aktualisiert den Zeitstempel.', ['touch neu.txt'], 'Dateien verwalten'],
  mkdir: ['mkdir [-p] DIR...', 'Erstellt Verzeichnisse. -p legt fehlende Eltern mit an.', ['mkdir tools', 'mkdir -p a/b/c'], 'Dateien verwalten'],
  rmdir: ['rmdir DIR...', 'Loescht leere Verzeichnisse.', ['rmdir alt'], 'Dateien verwalten'],
  rm: ['rm [-rf] FILE...', 'Loescht Dateien. -r rekursiv (Ordner), -f ohne Rueckfrage/Fehler. Es gibt keinen Papierkorb!', ['rm alt.txt', 'rm -r ordner'], 'Dateien verwalten'],
  cp: ['cp [-r] SRC... DEST', 'Kopiert Dateien. -r fuer Verzeichnisse.', ['cp notes.txt notes.bak', 'cp -r logs backup'], 'Dateien verwalten'],
  mv: ['mv SRC... DEST', 'Verschiebt oder benennt um.', ['mv alt.txt neu.txt', 'mv *.log logs/'], 'Dateien verwalten'],
  ln: ['ln [-s] TARGET LINK', 'Erstellt Links. -s fuer symbolische Links.', ['ln -s logs/auth.log auth'], 'Dateien verwalten'],
  nano: ['nano FILE', 'Einfacher Texteditor.', ['nano notes.txt'], 'Dateien verwalten'],
  tar: ['tar -c|-x|-t [-v] [-z] -f ARCHIVE [FILE]...', 'Packt (-c), entpackt (-x) oder listet (-t) Archive.', ['tar -czf logs.tar.gz logs', 'tar -tf logs.tar.gz', 'tar -xf logs.tar.gz'], 'Dateien verwalten'],
  echo: ['echo [-n] [-e] [TEXT]...', 'Gibt Text aus. -n ohne Zeilenumbruch, -e wertet \\n, \\t aus.', ['echo Hallo', 'echo "text" > datei.txt', 'echo $HOME'], 'Text'],
  printf: ['printf FORMAT [ARG]...', 'Formatierte Ausgabe (%s, %d, \\n).', ['printf "%s hat %d Punkte\\n" Neo 42'], 'Text'],
  grep: ['grep [-ivnclrwoE] PATTERN [FILE]...', 'Sucht Zeilen, die zum Muster passen. -i Gross/klein egal, -v invertiert, -n Zeilennummern, -c zaehlen, -r rekursiv.', ['grep Failed logs/auth.log', 'grep -ri password /etc', 'ps aux | grep ssh'], 'Text'],
  sort: ['sort [-rnu] [-k N] [-t SEP] [FILE]...', 'Sortiert Zeilen. -n numerisch, -r umgekehrt, -u ohne Duplikate.', ['sort words.txt', 'sort -nr numbers.txt'], 'Text'],
  uniq: ['uniq [-cdu] [FILE]', 'Entfernt aufeinanderfolgende Duplikate. -c zaehlt. Vorher sortieren!', ['sort words.txt | uniq -c'], 'Text'],
  cut: ['cut -d SEP -f LIST [FILE]...', 'Schneidet Spalten aus. -d Trenner, -f Felder, -c Zeichen.', ["cut -d' ' -f1 logs/access.log", 'cut -d: -f1 /etc/passwd'], 'Text'],
  tr: ['tr [-ds] SET1 [SET2]', 'Ersetzt oder loescht Zeichen aus stdin.', ['echo hallo | tr a-z A-Z', "tr -d '\\n'"], 'Text'],
  sed: ["sed [-n] [-i] 's/ALT/NEU/g' [FILE]", 'Stream-Editor: ersetzen (s), loeschen (d), drucken (p).', ["sed 's/root/admin/g' /etc/passwd", "sed -n '2,4p' notes.txt", "sed '/^#/d' datei"], 'Text'],
  awk: ["awk [-F SEP] 'PROGRAMM' [FILE]", 'Spaltenbasierte Textverarbeitung. $1 = erstes Feld, NR = Zeilennummer, NF = Feldanzahl.', ["awk '{print $1}' logs/access.log", "awk -F: '{print $1, $3}' /etc/passwd", "awk '$9 == 404' logs/access.log"], 'Text'],
  rev: ['rev [FILE]', 'Dreht jede Zeile um.', ['echo hallo | rev'], 'Text'],
  tee: ['tee [-a] FILE...', 'Schreibt stdin in Datei UND auf stdout.', ['ls | tee liste.txt'], 'Text'],
  xargs: ['xargs [-n N] [-I STR] [CMD]', 'Baut aus stdin Argumente fuer einen Befehl.', ['find . -name "*.bak" | xargs rm', 'ls | xargs -n 1 echo Datei:'], 'Text'],
  diff: ['diff FILE1 FILE2', 'Zeigt Unterschiede zwischen zwei Dateien.', ['diff a.txt b.txt'], 'Text'],
  base64: ['base64 [-d] [FILE]', 'Kodiert/dekodiert Base64.', ['echo geheim | base64', 'base64 -d downloads/payload.b64'], 'Text'],
  seq: ['seq [FIRST [STEP]] LAST', 'Gibt Zahlenfolgen aus.', ['seq 5', 'seq 2 2 10'], 'Text'],
  bc: ['bc', 'Rechner; liest Ausdruecke von stdin.', ['echo "6*7" | bc'], 'Text'],
  find: ['find [PATH] [-name PAT] [-type f|d] [-maxdepth N] [-exec CMD {} \\;]', 'Sucht Dateien im Verzeichnisbaum.', ['find . -name "*.txt"', 'find / -name "*.key" 2>/dev/null', 'find . -type d'], 'Suchen'],
  which: ['which CMD...', 'Zeigt den Pfad eines Programms.', ['which ls'], 'Suchen'],
  type: ['type CMD...', 'Zeigt, was ein Befehl ist (Alias, Builtin, Programm).', ['type cd', 'type ll'], 'Suchen'],
  chmod: ['chmod [-R] MODE FILE...', 'Aendert Rechte. Oktal (755) oder symbolisch (u+x, go-w).', ['chmod +x script.sh', 'chmod 600 geheim.txt'], 'Rechte'],
  chown: ['chown [-R] USER[:GROUP] FILE...', 'Aendert den Besitzer (nur root).', ['sudo chown root datei'], 'Rechte'],
  sudo: ['sudo CMD', 'Fuehrt einen Befehl als root aus.', ['sudo cat /etc/shadow'], 'Rechte'],
  su: ['su [USER]', 'Wechselt den Benutzer (in der Simulation gesperrt - nutze sudo).', [], 'Rechte'],
  whoami: ['whoami', 'Zeigt den aktuellen Benutzernamen.', ['whoami'], 'System'],
  id: ['id', 'Zeigt Benutzer- und Gruppen-IDs.', ['id'], 'System'],
  hostname: ['hostname', 'Zeigt den Rechnernamen.', [], 'System'],
  uname: ['uname [-a]', 'Zeigt Systeminformationen.', ['uname -a'], 'System'],
  date: ['date [+FORMAT]', 'Zeigt Datum und Uhrzeit.', ['date', 'date +%Y-%m-%d'], 'System'],
  cal: ['cal', 'Zeigt einen Kalender.', [], 'System'],
  uptime: ['uptime', 'Zeigt Laufzeit und Last.', [], 'System'],
  free: ['free [-h]', 'Zeigt Speicherauslastung.', ['free -h'], 'System'],
  df: ['df [-h]', 'Zeigt belegten Plattenplatz je Dateisystem.', ['df -h'], 'System'],
  du: ['du [-sh] [FILE]...', 'Zeigt Platzverbrauch von Verzeichnissen.', ['du -sh *', 'du -h logs'], 'System'],
  ps: ['ps [aux]', 'Listet Prozesse. "ps aux" zeigt alle.', ['ps aux', 'ps aux | grep xmrig'], 'Prozesse'],
  top: ['top', 'Zeigt Prozesse nach CPU-Last (Momentaufnahme).', [], 'Prozesse'],
  kill: ['kill [-9] PID...', 'Beendet Prozesse per PID.', ['kill 1337', 'kill -9 1337'], 'Prozesse'],
  killall: ['killall NAME', 'Beendet Prozesse per Name.', ['killall xmrig'], 'Prozesse'],
  sleep: ['sleep N', 'Wartet N Sekunden (in der Simulation sofort).', [], 'Prozesse'],
  ping: ['ping [-c N] HOST', 'Prueft, ob ein Host erreichbar ist.', ['ping -c 3 darknode.local'], 'Netzwerk'],
  curl: ['curl [-I] [-o FILE] URL', 'Ruft eine URL ab.', ['curl example.com', 'curl -o seite.html example.com'], 'Netzwerk'],
  wget: ['wget URL', 'Laedt eine URL in eine Datei.', ['wget example.com'], 'Netzwerk'],
  ip: ['ip a | ip r', 'Zeigt Netzwerkschnittstellen und Routen.', ['ip a'], 'Netzwerk'],
  ifconfig: ['ifconfig', 'Zeigt Netzwerkschnittstellen (alt).', [], 'Netzwerk'],
  ssh: ['ssh USER@HOST', 'Verbindet sich mit einem entfernten Rechner.', [], 'Netzwerk'],
  env: ['env', 'Zeigt Umgebungsvariablen.', ['env | grep HOME'], 'Shell'],
  export: ['export NAME=VALUE', 'Setzt eine Umgebungsvariable.', ['export TARGET=10.0.0.66', 'echo $TARGET'], 'Shell'],
  unset: ['unset NAME', 'Loescht eine Variable.', [], 'Shell'],
  alias: ["alias NAME='CMD'", 'Definiert Kurzbefehle. Ohne Argument: alle anzeigen.', ["alias ll='ls -la'"], 'Shell'],
  unalias: ['unalias NAME', 'Entfernt einen Alias.', [], 'Shell'],
  history: ['history [-c]', 'Zeigt den Befehlsverlauf. "!!" wiederholt den letzten Befehl.', ['history | tail'], 'Shell'],
  clear: ['clear', 'Leert den Bildschirm (auch Ctrl+L).', [], 'Shell'],
  man: ['man CMD', 'Zeigt das Handbuch zu einem Befehl.', ['man grep'], 'Shell'],
  help: ['help', 'Uebersicht aller Befehle.', [], 'Shell'],
  bash: ['bash SCRIPT', 'Fuehrt ein Shell-Skript aus.', ['bash tools/scan.sh'], 'Shell'],
  source: ['source FILE', 'Fuehrt ein Skript in der aktuellen Shell aus.', ['source ~/.bashrc'], 'Shell'],
  test: ['test EXPR  oder  [ EXPR ]', 'Prueft Bedingungen: -f Datei, -d Ordner, -e existiert, = != -eq -lt -gt.', ['[ -f notes.txt ] && echo da'], 'Shell'],
  basename: ['basename PATH [SUFFIX]', 'Entfernt den Verzeichnisanteil.', ['basename /etc/passwd'], 'Shell'],
  dirname: ['dirname PATH', 'Entfernt den Dateinamen.', ['dirname /etc/passwd'], 'Shell'],
  realpath: ['realpath PATH', 'Zeigt den absoluten Pfad.', ['realpath ../x'], 'Shell'],
  mission: ['mission', 'Zeigt die aktuelle Mission.', [], 'Spiel'],
  hint: ['hint', 'Gibt einen Tipp zur aktuellen Mission.', [], 'Spiel'],
  missions: ['missions', 'Liste aller Missionen und Kapitel.', [], 'Spiel'],
  stats: ['stats', 'Rang, XP und Erfolge.', [], 'Spiel'],
  theme: ['theme [green|amber|cyan|red|mono]', 'Wechselt das Farbschema.', ['theme amber'], 'Spiel'],
  reset: ['reset --hard', 'Setzt Dateisystem und Spielstand komplett zurueck.', [], 'Spiel'],
  neofetch: ['neofetch', 'Systeminfo mit Logo.', [], 'Spiel'],
  cmatrix: ['cmatrix', 'Folge dem weissen Kaninchen.', [], 'Spiel'],
};

// Lookup tables are indexed with user input (host names, command names), so they must
// not inherit keys like "constructor" or "__proto__" from Object.prototype.
for (const table of [HOSTS, SITES, MAN]) Object.setPrototypeOf(table, null);
