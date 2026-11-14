// Engine tests, run with: node test/test.mjs
import { Shell } from '../js/shell.js';
import { Game, MISSIONS } from '../js/game.js';

let pass = 0, fail = 0;
function mk() {
  const sh = new Shell();
  sh.game = new Game();
  sh.buf = { out: '', err: '' };
  sh.write = (t, k) => { if (k === 'err') sh.buf.err += t; else if (k === 'out') sh.buf.out += t; };
  return sh;
}
// Strip ANSI colours so expectations stay readable.
const plain = s => s.replace(/\x1b\[[\d;]*m/g, '');
function exec(sh, line) {
  sh.buf.out = ''; sh.buf.err = '';
  const run = sh.run(line);
  return { out: plain(sh.buf.out), err: plain(sh.buf.err), code: run.code, run };
}
function t(name, line, expected, opts = {}) {
  const sh = opts.sh || mk();
  for (const pre of opts.pre || []) exec(sh, pre);
  const r = exec(sh, line);
  const got = opts.err ? r.err : r.out;
  const ok = (typeof expected === 'string' ? got === expected : expected.test(got)) && (opts.code === undefined || r.code === opts.code);
  if (ok) pass++;
  else { fail++; console.log(`FAIL ${name}\n  $ ${line}\n  expected: ${JSON.stringify(String(expected))}${opts.code !== undefined ? ` code ${opts.code}` : ''}\n  got:      ${JSON.stringify(got)} code ${r.code}\n  stderr:   ${JSON.stringify(r.err)}`); }
  return sh;
}

// --- basics ---
t('whoami', 'whoami', 'hacker\n');
t('pwd', 'pwd', '/home/hacker\n');
t('cd+pwd', 'cd documents && pwd', '/home/hacker/documents\n');
t('cd -', 'cd /etc; cd /tmp; cd -', '/etc\n');
t('cd missing', 'cd nope', 'bash: cd: nope: No such file or directory\n', { err: true, code: 1 });
t('cd file', 'cd readme.txt', 'bash: cd: readme.txt: Not a directory\n', { err: true });
t('cd denied', 'cd /root', 'bash: cd: /root: Permission denied\n', { err: true });
t('ls', 'ls', /^documents\s+downloads\s+logs\s+notes\.txt\s+readme\.txt\n$/);
t('ls -a', 'ls -a | head -n 4', '.\n..\n.bash_history\n.bashrc\n');
t('ls -l', 'ls -l notes.txt', /^-rw-r--r-- 1 hacker hacker \d+ \w{3} [ \d]\d \d\d:\d\d notes\.txt\n$/);
t('ls -la total', 'ls -la | head -n 1', /^total \d+\n$/);
t('ls missing', 'ls nope', "ls: cannot access 'nope': No such file or directory\n", { err: true, code: 2 });
t('ls glob', 'ls -1 documents/*.txt', 'documents/report.txt\ndocuments/todo.txt\n', {});
t('ls bin symlink', 'ls -l /bin', /^lrwxrwxrwx 1 root root 7 .* \/bin -> usr\/bin\n$/);
t('echo', 'echo hello   world', 'hello world\n');
t('echo quotes', `echo "a  b" 'c  $HOME' $HOME`, 'a  b c  $HOME /home/hacker\n');
t('echo -n', 'echo -n hi', 'hi');
t('echo -e', 'echo -e "a\\tb\\nc"', 'a\tb\nc\n');
t('var', 'X=5; echo $X ${X}y "$X"', '5 5y 5\n');
t('var export env', 'export FOO=bar; env | grep FOO', 'FOO=bar\n');
t('unexported not in env', 'FOO=bar; env | grep -c FOO', '0\n');
t('$?', 'false; echo $?', '1\n');
t('&& ||', 'false && echo a || echo b', 'b\n');
t('&& chain', 'true && echo a && echo b', 'a\nb\n');
t('cmd subst', 'echo "count: $(ls | wc -l)"', 'count: 5\n');
t('backticks', 'echo `whoami`', 'hacker\n');
t('arith', 'echo $((2 + 3 * 4)) $((10 / 3)) $((2 ** 8))', '14 3 256\n');
t('arith var', 'N=4; echo $((N * 2)) $(($N + 1))', '8 5\n');
t('brace', 'echo a{1,2,3}b {x..z} {1..3}', 'a1b a2b a3b x y z 1 2 3\n');
t('brace literal', 'echo {} {a} a,b', '{} {a} a,b\n');
t('glob none', 'echo *.zip', '*.zip\n');
t('glob quoted', 'echo "*"', '*\n');
t('tilde', 'echo ~ ~/x', '/home/hacker /home/hacker/x\n');
t('comment', 'echo a # b', 'a\n');
t('not found', 'foo', 'bash: foo: command not found\n', { err: true, code: 127 });
t('syntax', 'echo a |', /syntax error/, { err: true, code: 2 });
t('syntax2', '| ls', "bash: syntax error near unexpected token `|'\n", { err: true });
t('unclosed', 'echo "abc', /unexpected EOF/, { err: true });
t('alias', 'alias hi="echo hello"; hi there', 'hello there\n');
t('ll alias', 'll notes.txt', /^-rw-r--r-- 1 hacker/);
t('history !!', '!!', 'echo one\none\n', { pre: ['echo one'], sh: undefined, }) ;
t('word split', 'F="a b"; echo $(echo x y) | wc -w', '2\n');

t('brace limit', 'echo {1..100000000}', 'bash: brace expansion: too many words (max 10000)\n', { err: true, code: 1 });
t('brace product limit', 'echo {1..200}{1..200}', /too many words/, { err: true, code: 1 });

// --- files ---
t('mkdir/touch/ls', 'mkdir tools && touch tools/a tools/b && ls -1 tools', 'a\nb\n');
t('mkdir -p', 'mkdir -p a/b/c && find a', 'a\na/b\na/b/c\n');
t('mkdir exists', 'mkdir logs', "mkdir: cannot create directory 'logs': File exists\n", { err: true, code: 1 });
t('mkdir no parent', 'mkdir x/y', "mkdir: cannot create directory 'x/y': No such file or directory\n", { err: true });
t('redirect', 'echo hi > f.txt; echo there >> f.txt; cat f.txt', 'hi\nthere\n');
t('redirect in', 'wc -l < notes.txt', '5\n');
t('2>/dev/null', 'ls nope 2>/dev/null; echo ok', 'ok\n');
t('2>&1', 'ls nope 2>&1 | wc -l', '1\n');
t('cp', 'cp notes.txt n2 && diff notes.txt n2 && echo same', 'same\n');
t('cp dir no -r', 'cp logs l2', "cp: -r not specified; omitting directory 'logs'\n", { err: true, code: 1 });
t('cp -r', 'cp -r logs l2 && ls -1 l2', 'access.log\nauth.log\n');
t('cp into dir', 'cp notes.txt documents && ls documents | grep notes', 'notes.txt\n');
t('mv', 'mv notes.txt x.txt && ls | grep -c notes; ls x.txt', '0\nx.txt\n');
t('mv missing', 'mv nope x', "mv: cannot stat 'nope': No such file or directory\n", { err: true });
t('rm', 'rm notes.txt; ls notes.txt', "ls: cannot access 'notes.txt': No such file or directory\n", { err: true });
t('rm dir', 'rm logs', "rm: cannot remove 'logs': Is a directory\n", { err: true, code: 1 });
t('rm -r', 'rm -r logs && ls', /^documents\s+downloads\s+notes\.txt\s+readme\.txt\n$/);
t('rm -rf /', 'rm -rf /', /dangerous to operate recursively on '\/'/, { err: true, code: 1 });
t('rm -f missing', 'rm -f nope; echo $?', '0\n');
t('rm denied', 'rm /etc/passwd', "rm: cannot remove '/etc/passwd': Permission denied\n", { err: true });
t('rmdir nonempty', 'rmdir logs', "rmdir: failed to remove 'logs': Directory not empty\n", { err: true });
t('ln -s', 'ln -s notes.txt link && cat link | head -n 1 && ls -l link', /^TODO\nlrwxrwxrwx 1 hacker hacker 9 .* link -> notes\.txt\n$/);
t('write denied', 'echo x > /etc/passwd', 'bash: /etc/passwd: Permission denied\n', { err: true, code: 1 });
t('cat denied', 'cat /etc/shadow', 'cat: /etc/shadow: Permission denied\n', { err: true, code: 1 });
t('cat dir', 'cat logs', 'cat: logs: Is a directory\n', { err: true });
t('sudo cat', 'sudo cat /etc/shadow | head -n 1 | cut -d: -f1', 'root\n');
t('sudo whoami', 'sudo whoami; whoami', 'root\nhacker\n');
t('chmod +x', "echo 'echo run $1' > s.sh; chmod +x s.sh; ./s.sh arg; ls -l s.sh", /^run arg\n-rwxr-xr-x/);
t('exec denied', 'echo "echo run" > s.sh; ./s.sh', 'bash: ./s.sh: Permission denied\n', { err: true, code: 126 });
t('chmod octal', 'chmod 600 notes.txt; stat notes.txt | grep Access', /^Access: \(0600\/-rw-------\)/);
t('chmod sym', 'chmod u=rwx,go-r notes.txt; ls -l notes.txt', /^-rwx------/);
t('chmod not owner', 'chmod 777 /etc/passwd', "chmod: changing permissions of '/etc/passwd': Operation not permitted\n", { err: true });
t('bash script', 'printf "echo a\\necho b\\n" > s.sh; bash s.sh', 'a\nb\n');
t('tar', 'tar -czf l.tar.gz logs && rm -r logs && tar -xf l.tar.gz && ls -1 logs && tar -tf l.tar.gz', 'access.log\nauth.log\nlogs/\nlogs/access.log\nlogs/auth.log\n');
t('touch denied', 'touch /etc/x', "touch: cannot touch '/etc/x': Permission denied\n", { err: true });
t('/bin/ls', '/bin/ls -1 documents', 'contacts.csv\nreport.txt\ntodo.txt\n');
t('which', 'which ls cd', '/usr/bin/ls\n', { code: 1 });
t('type', 'type cd ls ll', "cd is a shell builtin\nls is /usr/bin/ls\nll is aliased to `ls -la'\n");

// --- text tools ---
t('head', 'head -n 2 downloads/words.txt', 'banana\napple\n');
t('head -N', 'head -2 downloads/words.txt', 'banana\napple\n');
t('tail', 'tail -n 2 downloads/words.txt', 'apple\ndate\n');
t('tail +N', 'tail -n +6 downloads/words.txt', 'apple\ndate\n');
t('wc -l', 'wc -l logs/auth.log', '12 logs/auth.log\n');
t('wc', 'wc downloads/numbers.txt', ' 6  6 18 downloads/numbers.txt\n');
t('wc stdin', 'cat downloads/numbers.txt | wc', '      6       6      18\n');
t('grep', 'grep -c Failed logs/auth.log', '7\n');
t('grep -n', 'grep -n date downloads/words.txt', '7:date\n');
t('grep -i -v', 'grep -iv A downloads/words.txt', 'cherry\n');
t('grep -r', 'grep -r patchen documents', 'documents/todo.txt:server patchen\ndocuments/todo.txt:server patchen\n');
t('grep -l', 'grep -rl Failed .', './logs/auth.log\n');
t('grep -E', "grep -E '^(a|d)' downloads/words.txt | sort -u", 'apple\ndate\n');
t('grep BRE', "grep 'a\\|d' downloads/numbers.txt; grep -c 'an\\+a' downloads/words.txt", '2\n', { });
t('grep -o', 'grep -o "10\\.0\\.0\\.[0-9]*" logs/access.log | sort -u', '10.0.0.66\n');
t('grep none', 'grep zzz notes.txt', '', { code: 1 });
t('grep dir', 'grep x logs', 'grep: logs: Is a directory\n', { err: true, code: 2 });
t('grep -w', 'echo "cat catalog" | grep -ow cat', 'cat\n');
t('sort', 'sort downloads/words.txt | head -n 2', 'apple\napple\n');
t('sort -n', 'sort -n downloads/numbers.txt', '7\n7\n9\n42\n100\n1337\n');
t('sort -nr -u', 'sort -nru downloads/numbers.txt', '1337\n100\n42\n9\n7\n');
t('sort -k -t', 'sort -t, -k3 documents/contacts.csv | head -n 2', 'Cypher,cyph3r,Berlin\nTrinity,tr1n,Berlin\n', {});
t('uniq -c', 'sort downloads/words.txt | uniq -c', '      3 apple\n      2 banana\n      1 cherry\n      1 date\n');
t('uniq -d', 'sort downloads/words.txt | uniq -d', 'apple\nbanana\n');
t('cut -d -f', "cut -d' ' -f1 logs/access.log | sort | uniq -c | sort -nr | head -n 1", '      5 10.0.0.66\n');
t('cut -f list', 'cut -d, -f1,3 documents/contacts.csv | head -n 2', 'name,city\nTrinity,Berlin\n');
t('cut -c', 'echo abcdef | cut -c2-4', 'bcd\n');
t('tr upper', 'echo hello | tr a-z A-Z', 'HELLO\n');
t('tr -d', 'echo hello | tr -d l', 'heo\n');
t('tr class', "echo 'a1b2' | tr -d '[:digit:]'", 'ab\n');
t('tr -s', "echo 'a   b' | tr -s ' '", 'a b\n');
t('sed s', "echo 'foo bar foo' | sed 's/foo/X/'", 'X bar foo\n');
t('sed s g', "echo 'foo bar foo' | sed 's/foo/X/g'", 'X bar X\n');
t('sed &', "echo 'abc' | sed 's/b/[&]/'", 'a[b]c\n');
t('sed groups', "echo 'john smith' | sed -E 's/(\\w+) (\\w+)/\\2 \\1/'", 'smith john\n');
t('sed BRE groups', "echo 'ab' | sed 's/\\(a\\)\\(b\\)/\\2\\1/'", 'ba\n');
t('sed -n p', "sed -n '2,3p' downloads/words.txt", 'apple\ncherry\n');
t('sed d', "sed '/apple/d' downloads/words.txt | wc -l", '4\n');
t('sed $d', "sed '$d' downloads/numbers.txt | tail -n 1", '7\n');
t('sed -i', "sed -i 's/apple/kiwi/' downloads/words.txt; grep -c kiwi downloads/words.txt", '3\n');
t('sed delim', "echo /a/b | sed 's|/a|/x|'", '/x/b\n');
t('awk print', "awk '{print $1}' logs/access.log | head -n 1", '192.168.1.10\n');
t('awk -F', "awk -F: '{print $1, $3}' /etc/passwd | tail -n 1", 'hacker 1000\n');
t('awk pattern', "awk -F, '$3 == \"Berlin\" {print $1}' documents/contacts.csv", 'Trinity\nCypher\n');
t('awk regex', "awk '/Accepted/ {n++} END {print n}' logs/auth.log", '3\n');
t('awk NR NF', "awk 'NR==2 {print NF, $NF}' logs/access.log", '10 199\n');
t('awk sum', "awk '{s += $1} END {print s}' downloads/numbers.txt", '1502\n');
t('awk concat', "awk -F, 'NR>1 {print $1 \"@\" $3}' documents/contacts.csv | head -n 1", 'Trinity@Berlin\n');
t('awk arrays', "awk '{c[$1]++} END {for (k in c) print c[k], k}' logs/access.log | sort -nr | head -n 1", '5 10.0.0.66\n');
t('awk if/printf', "awk '{ if ($1 > 50) printf \"%s big\\n\", $1 }' downloads/numbers.txt", '1337 big\n100 big\n');
t('awk ~', "awk '$7 ~ /login/ && $9 == 200 {print $1}' logs/access.log", '10.0.0.66\n');
t('awk BEGIN', "awk 'BEGIN { for (i = 1; i <= 3; i++) printf \"%d \", i * i; print \"\" }'", '1 4 9 \n');
t('awk length/toupper', "echo hello | awk '{print length($0), toupper($1)}'", '5 HELLO\n');
t('awk error', "awk '{print $1' notes.txt", /^awk: syntax error/, { err: true, code: 2 });
t('awk no escape', "awk 'BEGIN { print constructor }'", '\n');
t('find name', 'find . -name "*.log"', './logs/access.log\n./logs/auth.log\n');
t('find type d', 'find . -maxdepth 1 -type d', '.\n./documents\n./downloads\n./logs\n');
t('find key', 'find / -name "*.key" 2>/dev/null', '/var/backups/master.key\n', { code: 1 });
t('find denied msg', 'find /root', 'find: ‘/root’: Permission denied\n', { err: true });
t('find -exec', 'find documents -name "*.csv" -exec wc -l {} \\;', '6 documents/contacts.csv\n');
t('find -delete', 'find downloads -name "*.txt" -delete; ls downloads', 'payload.b64\n');
t('xargs', 'find . -name "*.log" | xargs wc -l | tail -n 1', '24 total\n');
t('xargs -I', 'echo a b | tr " " "\\n" | xargs -I {} echo item-{}', 'item-a\nitem-b\n');
t('tee', 'echo hi | tee t.txt | tr a-z A-Z; cat t.txt', 'HI\nhi\n');
t('base64', 'echo geheim | base64; echo Z2VoZWltCg== | base64 -d', 'Z2VoZWltCg==\ngeheim\n');
t('payload', 'base64 -d downloads/payload.b64', 'ACCESS CODE: 4815162342\n');
t('seq', 'seq 3; seq 2 2 6 | tr "\\n" " "', '1\n2\n3\n2 4 6 ');
t('rev/tac', 'echo abc | rev; printf "1\\n2\\n" | tac', 'cba\n2\n1\n');
t('bc', 'echo "6*7" | bc; echo "scale=2; 10/4" | bc; echo "7/2" | bc', '42\n2.50\n3\n');
t('diff', 'printf "a\\nb\\nc\\n" > x; printf "a\\nB\\nc\\nd\\n" > y; diff x y', '2c2\n< b\n---\n> B\n3a4\n> d\n', { code: 1 });
t('basename/dirname', 'basename /etc/passwd; dirname /etc/passwd; basename a/b.txt .txt', 'passwd\n/etc\nb\n');
t('test', '[ -f notes.txt ] && echo f; [ -d notes.txt ] || echo nd; [ 3 -gt 2 ] && echo gt; test "a" = "b"; echo $?', 'f\nnd\ngt\n1\n');
t('printf', 'printf "%s=%d\\n" a 1 b 2; printf "%5s|%-5s|%03d\\n" x y 7', 'a=1\nb=2\n    x|y    |007\n');
t('du', 'du -s logs', /^\d+\tlogs\n$/);
t('tree', 'tree logs', 'logs\n├── access.log\n└── auth.log\n\n0 directories, 2 files\n');
t('file', 'file logs notes.txt /bin/ls', 'logs: directory\nnotes.txt: ASCII text\n/bin/ls: ELF 64-bit LSB pie executable, x86-64, dynamically linked, stripped\n');
t('id/uname', 'id; uname -a', 'uid=1000(hacker) gid=1000(hacker) groups=1000(hacker),27(sudo)\nLinux box 6.8.0-hackterm #1 SMP PREEMPT_DYNAMIC x86_64 GNU/Linux\n');
t('date fmt', 'date +%Y', /^\d{4}\n$/);

// --- processes / net ---
t('ps', 'ps aux | grep xmrig | grep -v grep | awk \'{print $2}\'', '1337\n');
t('kill', 'kill 1337; ps aux | grep -c xmrig', '0\n', {});
t('kill denied', 'kill 811', 'bash: kill: (811) - Operation not permitted\n', { err: true, code: 1 });
t('kill none', 'kill 99999', 'bash: kill: (99999) - No such process\n', { err: true });
t('sudo kill', 'sudo kill 811; ps aux | grep -c sshd', '0\n');
t('ping', 'ping -c 2 darknode.local | head -n 1', 'PING darknode.local (10.0.0.66) 56(84) bytes of data.\n');
t('ping unknown', 'ping nope.invalid', 'ping: nope.invalid: Name or service not known\n', { err: true, code: 2 });
t('curl', 'curl -s example.com | grep -o "<h1>.*</h1>"', '<h1>Example Domain</h1>\n');
t('man', 'man grep | head -n 2', /^NAME\n    grep - /);
t('usage error', 'ls -Z', "ls: invalid option -- 'Z'\nTry 'man ls' for more information.\n", { err: true, code: 2 });

// --- completion ---
{
  const sh = mk();
  const eq = (name, got, exp) => { if (JSON.stringify(got) === JSON.stringify(exp)) pass++; else { fail++; console.log(`FAIL ${name}: ${JSON.stringify(got)} != ${JSON.stringify(exp)}`); } };
  eq('complete cmd', sh.complete('who').line, 'whoami ');
  eq('complete path', sh.complete('cat rea').line, 'cat readme.txt ');
  eq('complete dir', sh.complete('cd doc').line, 'cd documents/');
  eq('complete multi', sh.complete('cat do'), { line: 'cat do', options: ['documents/', 'downloads/'] });
  eq('complete nested', sh.complete('cat logs/au').line, 'cat logs/auth.log ');
  eq('complete abs', sh.complete('ls /etc/host').options, ['hostname', 'hosts']);
}

// --- mission 4 needs hidden files to actually show up ---
{
  const sh = mk();
  sh.game.s.idx = 3;
  const r1 = exec(sh, 'cd downloads; ls -la');
  const ev1 = sh.game.afterRun(sh, r1.run);
  const r2 = exec(sh, 'cd; ls -a');
  const ev2 = sh.game.afterRun(sh, r2.run);
  if (sh.game.s.idx === 4 && ev1.some(e => e.type === 'nudge') && !ev1.some(e => e.type === 'mission') && ev2.some(e => e.type === 'mission')) pass++;
  else { fail++; console.log('FAIL mission 4 hidden files', JSON.stringify(ev1), JSON.stringify(ev2)); }
}

// --- persistence round trip ---
{
  const sh = mk();
  exec(sh, 'mkdir keep; echo data > keep/f; cd keep; export Z=1');
  const sh2 = new Shell(JSON.parse(JSON.stringify(sh.serialize())));
  sh2.write = () => {};
  let out = '';
  sh2.write = (s, k) => { if (k === 'out') out += s; };
  sh2.run('pwd; cat f; echo $Z');
  if (out === '/home/hacker/keep\ndata\n1\n') pass++; else { fail++; console.log('FAIL persistence', JSON.stringify(out)); }
}

// --- full mission walkthrough using each mission's hint solution ---
{
  const sh = mk();
  const g = sh.game;
  const solutions = [
    'whoami', 'pwd', 'ls', 'ls -la', 'cat readme.txt', 'cd documents', 'cd',
    'mkdir tools', 'touch tools/scan.sh', "echo 'echo Scanning...' > tools/scan.sh", 'cp notes.txt notes.bak',
    'mv notes.bak archive.txt', 'rm archive.txt',
    'head -n 3 logs/access.log', 'tail -n 3 logs/auth.log', 'grep Failed logs/auth.log', 'wc -l logs/auth.log',
    'find / -name "*.key" 2>/dev/null',
    'grep Failed logs/auth.log | wc -l', 'grep Failed logs/auth.log > failed.txt',
    "cut -d' ' -f1 logs/access.log | sort | uniq -c | sort -nr", 'base64 -d downloads/payload.b64',
    'chmod +x tools/scan.sh', 'sudo cat /etc/shadow', 'kill 1337', 'sudo cat /root/flag.txt',
  ];
  let ok = solutions.length === MISSIONS.length;
  solutions.forEach((line, i) => {
    const r = exec(sh, line);
    const ev = g.afterRun(sh, r.run);
    if (!ev.some(e => e.type === 'mission') || g.s.idx !== i + 1) { ok = false; console.log(`FAIL mission ${i + 1} not solved by: ${line}\n  out: ${JSON.stringify(r.out)} err: ${JSON.stringify(r.err)}`); }
  });
  // A wrong command must not advance a mission.
  const g2 = new Game(); const sh2 = mk(); sh2.game = g2;
  g2.afterRun(sh2, exec(sh2, 'pwd').run);
  if (g2.s.idx !== 0) { ok = false; console.log('FAIL wrong command advanced mission'); }
  if (ok) pass++; else fail++;
  console.log(`walkthrough: xp=${g.s.xp} rank=${g.rank().name} ach=${g.s.ach.join(',')}`);
  exec(sh, './tools/scan.sh');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
