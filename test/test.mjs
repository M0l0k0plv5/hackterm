// Engine tests, run with: node test/test.mjs
import { Shell } from '../js/shell.js';
import { Game, MISSIONS } from '../js/game.js';
import { HASHES } from '../js/more.js';
import { createHash } from 'node:crypto';

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
// Unfinished input waits for more lines (PS2 prompt "> "), like an interactive bash.
{
  const sh = mk();
  const r1 = exec(sh, 'echo a |');
  const p2 = sh.prompt();
  const r2 = exec(sh, 'tr a b');
  const r3 = exec(sh, 'echo "abc');
  const r4 = exec(sh, 'def"');
  if (r1.run.incomplete && p2 === '> ' && r2.out === 'b\n' && r3.run.incomplete && r4.out === 'abc\ndef\n' && sh.prompt() !== '> ') pass++;
  else { fail++; console.log('FAIL continuation', JSON.stringify([r1.run, p2, r2.out, r3.run, r4.out])); }
}
t('syntax', 'echo a | | b', /syntax error/, { err: true, code: 2 });
t('syntax2', '| ls', "bash: syntax error near unexpected token `|'\n", { err: true });
t('unclosed subst', 'echo $(echo "abc)', /unexpected EOF/, { err: true });
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
  eq('complete cmd', sh.complete('whoa').line, 'whoami ');
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

// --- names that collide with Object.prototype must behave like normal names ---
t('proto file', 'touch __proto__ constructor; echo hi > toString; ls; cat toString', /^__proto__\s[\s\S]*constructor[\s\S]*toString\nhi\n$/);
t('proto missing', 'cat constructor', 'cat: constructor: No such file or directory\n', { err: true, code: 1 });
t('proto mkdir', 'mkdir hasOwnProperty && ls -d hasOwnProperty', 'hasOwnProperty\n');
t('proto var', 'echo "[$constructor][$__proto__]"; constructor=v; echo $constructor', '[][]\nv\n');
t('proto alias', 'alias __proto__="echo aliased"; __proto__', 'aliased\n');
{
  const sh = mk();
  exec(sh, 'mkdir -p a/__proto__; echo x > a/__proto__/f; constructor=1');
  const sh2 = new Shell(JSON.parse(JSON.stringify(sh.serialize())));
  let out = ''; sh2.write = (s, k) => { if (k === 'out') out += s; };
  sh2.run('cat a/__proto__/f; echo $constructor');
  if (out === 'x\n1\n' && Object.keys(Object.prototype).length === 0) pass++; else { fail++; console.log('FAIL proto persistence', JSON.stringify(out)); }
}

t('proto host ping', 'ping -c 1 constructor', 'ping: constructor: Name or service not known\n', { err: true, code: 2 });
t('proto host trace', 'traceroute __proto__', /Name or service not known/, { err: true, code: 2 });
t('proto man', 'man constructor', /No manual entry for constructor/, { err: true, code: 16 });
t('proto unit', 'systemctl status toString', 'Unit toString.service could not be found.\n', { err: true, code: 4 });

// --- tar archives are user-editable files and must be validated ---
t('tar corrupt', `echo 'SIMTAR1\n{"p":1}' > bad.tar; tar -xf bad.tar`, /Archive is corrupt/, { err: true, code: 2 });
t('tar no chmod foreign', `echo 'SIMTAR1\n[{"p":"f","t":"f","d":"x","m":4095}]' > a.tar; tar -xf a.tar; ls -l f`, /^-rwxrwxrwx /);

// --- additional commands (js/more.js) ---
t('yes', 'yes ok | head -n 2', 'ok\nok\n');
t('paste -sd', 'seq 4 | paste -sd+', '1+2+3+4\n');
t('paste files', 'paste downloads/words.txt downloads/numbers.txt | head -n 2', 'banana\t42\napple\t7\n');
t('comm', 'printf "a\\nb\\nc\\n" > x; printf "b\\nc\\nd\\n" > y; comm x y', 'a\n\t\tb\n\t\tc\n\td\n');
t('comm -12', 'printf "a\\nb\\n" > x; printf "b\\nc\\n" > y; comm -12 x y', 'b\n');
t('column -t', 'column -t -s, documents/contacts.csv | head -n 2', 'name      alias     city\nTrinity   tr1n      Berlin\n');
t('fold -s', 'echo "eins zwei drei" | fold -w 8 -s', 'eins \nzwei \ndrei\n');
t('shuf -n', 'shuf -i 1-3 | sort', '1\n2\n3\n');
t('shuf -e', 'shuf -e a b c -n 2 | wc -l', '2\n');
t('expr mul', 'expr 6 \\* 7', '42\n');
t('expr prec', 'expr 2 + 3 \\* 4', '14\n');
t('expr length', 'expr length hallo', '5\n');
t('expr match', 'expr abc123 : "[a-z]*"', '3\n');
t('expr group', 'expr report.txt : "\\(.*\\)\\.txt"', 'report\n');
t('expr false', 'expr 3 = 4', '0\n', { code: 1 });
t('expr div0', 'expr 1 / 0', 'expr: division by zero\n', { err: true, code: 2 });
t('expr nonint', 'expr a + 1', 'expr: non-integer argument\n', { err: true, code: 2 });
t('factor', 'factor 1337 360', '1337: 7 191\n360: 2 2 2 3 3 5\n');
{
  // Hash implementations against node:crypto, including multi-block and UTF-8 input.
  const inputs = ['', 'abc', 'a'.repeat(55), 'a'.repeat(56), 'a'.repeat(64), 'x'.repeat(1000), 'Grüße, Operator ✓\n'];
  const algo = { md5sum: 'md5', sha1sum: 'sha1', sha256sum: 'sha256' };
  let ok = true;
  for (const [cmd, fn] of Object.entries(HASHES)) for (const s of inputs) {
    const want = createHash(algo[cmd]).update(s, 'utf8').digest('hex');
    const got = fn(new TextEncoder().encode(s));
    if (got !== want) { ok = false; console.log(`FAIL ${cmd} ${JSON.stringify(s.slice(0, 20))}: ${got} != ${want}`); }
  }
  if (ok) pass++; else fail++;
}
t('sha256sum', 'echo -n abc | sha256sum', 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad  -\n');
t('sha256sum -c', 'sha256sum notes.txt > s; sha256sum -c s; echo x >> notes.txt; sha256sum -c s', 'notes.txt: OK\nnotes.txt: FAILED\n', { code: 1 });
t('xxd', 'echo "Hello world" | xxd', '00000000: 4865 6c6c 6f20 776f 726c 640a            Hello world.\n');
t('xxd -p -r', 'echo hi | xxd -p | xxd -r -p', 'hi\n');
t('xxd -r', 'echo "Hello world" | xxd | xxd -r', 'Hello world\n');
t('hexdump -C', 'echo "Hello world" | hexdump -C', '00000000  48 65 6c 6c 6f 20 77 6f  72 6c 64 0a              |Hello world.|\n0000000c\n');
t('gzip roundtrip', 'gzip notes.txt && ls notes* && gunzip notes.txt.gz && head -n 1 notes.txt', 'notes.txt.gz\nTODO\n');
t('gzip -k zcat', 'gzip -k readme.txt; ls readme*; zcat readme.txt.gz | head -n 1', /^readme\.txt\s+readme\.txt\.gz\n=== OPERATION NIGHTFALL ===\n$/);
t('gzip pipe', 'echo hi | gzip | gunzip', 'hi\n');
t('gzip tty', 'gzip', /not written to a terminal/, { err: true, code: 1 });
t('file gz', 'gzip -k notes.txt; file notes.txt.gz', 'notes.txt.gz: gzip compressed data, was "notes.txt", from Unix\n');
t('chgrp', 'chgrp sudo notes.txt; stat -c %G notes.txt', 'sudo\n');
t('chgrp denied', 'chgrp root notes.txt', "chgrp: changing group of 'notes.txt': Operation not permitted\n", { err: true, code: 1 });
t('mktemp', 'f=$(mktemp); stat -c "%a %U" $f', '600 hacker\n');
t('mktemp -d', 'd=$(mktemp -d); stat -c %F $d', 'directory\n');
t('stat -c', 'stat -c "%n %a %A %U:%G" /etc/shadow', '/etc/shadow 600 -rw------- root:root\n');
t('umask', 'umask; umask 077; touch p; mkdir q; stat -c %a p q; umask -S', '0022\n600\n700\nu=rwx,g=,o=\n');
t('time', 'time echo hi', 'hi\n');
t('time stderr', 'time true', /^\nreal\t0m\d\.\d{3}s\nuser\t.*\nsys\t0m0\.000s\n$/, { err: true });
t('dmesg user', 'dmesg', 'dmesg: read kernel buffer failed: Operation not permitted\n', { err: true, code: 1 });
t('dmesg root', 'sudo dmesg | grep -c CPU', '2\n');
t('systemctl status', 'systemctl is-active ssh', 'active\n');
t('systemctl denied', 'systemctl stop ssh', /Interactive authentication required/, { err: true, code: 1 });
t('systemctl stop', 'sudo systemctl stop nginx; systemctl is-active nginx; ss -tln | grep -c :80', 'inactive\n0\n');
t('systemctl start', 'sudo systemctl stop nginx; sudo systemctl start nginx; systemctl is-active nginx', 'active\n');
t('journalctl user', 'journalctl', '-- No entries --\n', { code: 1 });
t('journalctl -u', 'sudo journalctl -u ssh | grep -c Failed', '7\n');
t('crontab none', 'crontab -l', 'no crontab for hacker\n', { err: true, code: 1 });
t('crontab install', 'echo "*/5 * * * * ~/tools/scan.sh" > job; crontab job; crontab -l', '*/5 * * * * ~/tools/scan.sh\n');
t('crontab bad', 'echo "kaputt" > job; crontab job', /errors in crontab file/, { err: true, code: 1 });
t('crontab -r', 'echo "@daily echo hi" > job; crontab job; crontab -r; crontab -l', 'no crontab for hacker\n', { err: true, code: 1 });
t('pstree', 'pstree', 'init─┬─cron\n     ├─nginx\n     ├─sshd───bash───pstree\n     └─xmrig\n');
t('pstree kill', 'kill 1337; pstree | grep -c xmrig', '0\n');
t('nmap', 'nmap localhost | grep open', '22/tcp   open   ssh\n80/tcp   open   http\n');
t('nmap -sV', 'nmap -sV -p 3333 darknode.local | grep 3333', '3333/tcp open   dec-notes  XMRig stratum pool\n');
t('nmap closed', 'nmap -p 23 localhost | grep 23/', '23/tcp   closed telnet\n');
t('nmap -sn', 'nmap -sn 192.168.1.0/24 | grep -c "Host is up"', '3\n');
t('nmap bad port', 'nmap -p abc localhost', /port specifications are illegal/, { err: true, code: 1 });
t('nc -z ok', 'nc -zv localhost 22', 'Connection to localhost (127.0.0.1) 22 port [tcp/ssh] succeeded!\n', { err: true });
t('nc -z refused', 'nc -zv localhost 81', /Connection refused/, { err: true, code: 1 });
t('nc banner', 'nc localhost 22', 'SSH-2.0-OpenSSH_9.6p1 Ubuntu-3ubuntu13\r\n');
t('nc http', 'printf "GET / HTTP/1.0\\r\\n\\r\\n" | nc example.com 80 | head -n 1', 'HTTP/1.1 200 OK\r\n');
t('host', 'host example.com; host 10.0.0.66', 'example.com has address 93.184.215.14\n66.0.0.10.in-addr.arpa domain name pointer darknode.local.\n');
t('host nx', 'host nope.invalid', 'Host nope.invalid not found: 3(NXDOMAIN)\n', { code: 1 });
t('dig +short', 'dig +short kernel.org; dig -x 8.8.8.8 +short', '139.178.84.217\ndns.google.\n');
t('dig full', 'dig example.com | grep -A1 "ANSWER SECTION"', ';; ANSWER SECTION:\nexample.com.\t\t300\tIN\tA\t93.184.215.14\n');
t('nslookup', 'nslookup google.com | tail -n 3', 'Name:\tgoogle.com\nAddress: 142.250.185.78\n\n');
t('traceroute', 'traceroute -n darknode.local | wc -l', '3\n');
t('netstat user', 'netstat -tnp | grep 3333', /1337\/xmrig\n$/);
t('netstat hidden', 'netstat -tlnp | grep :22', /LISTEN\s+-\n$/);
t('netstat root', 'sudo netstat -tlnp | grep :22', /811\/sshd\n$/);
t('netstat kill', 'kill 1337; netstat -tn | grep -c 3333', '0\n', { code: 1 });
t('lsof -i', 'lsof -i | tail -n 1', /^xmrig\s+1337\s+hacker\s+12u\s+IPv4.*darknode\.local:dec-notes \(ESTABLISHED\)$/m);
t('grep -A', 'grep -A1 Neo documents/contacts.csv', 'Neo,the_one,Hamburg\nMorpheus,morph,Koeln\n');
t('grep -C sep', 'seq 10 | grep -C1 -E "3|8"', '2\n3\n4\n--\n7\n8\n9\n');
t('grep -B -n', 'grep -n -B1 date downloads/words.txt', '6-apple\n7:date\n');
t('grep -C merge', 'seq 5 | grep -C1 -E "2|4"', '1\n2\n3\n4\n5\n');
t('date tz', 'date +%Z', /^(CET|CEST|UTC|[A-Z]{2,5}|GMT[+-]\d+)\n$/);

// --- control structures, functions, here-documents ---
t('for', 'for i in 1 2 3; do echo "R$i"; done', 'R1\nR2\nR3\n');
t('for glob', 'for f in *.txt; do echo $f; done', 'notes.txt\nreadme.txt\n');
t('for brace', 'for i in {1..3}; do printf $i; done; echo', '123\n');
t('for empty', 'for x in; do echo nope; done; echo ok', 'ok\n');
t('for c-style', 'for ((i=0; i<3; i++)); do echo $i; done', '0\n1\n2\n');
t('for multiline', 'for i in a b\ndo\n  echo $i\ndone', 'a\nb\n');
t('while', 'i=0; while [ $i -lt 3 ]; do echo $i; i=$((i+1)); done', '0\n1\n2\n');
t('until', 'n=0; until [ $n -ge 4 ]; do n=$((n+1)); done; echo $n', '4\n');
t('if else', 'if [ -f nope ]; then echo a; else echo b; fi', 'b\n');
t('if elif', 'if false; then echo a; elif [ 1 -eq 1 ]; then echo b; else echo c; fi', 'b\n');
t('if status', 'if false; then echo a; fi; echo $?', '0\n');
t('if cmd', 'if grep -q Failed logs/auth.log; then echo Angriff; fi', 'Angriff\n');
t('case', 'case $USER in root) echo Chef;; hack*) echo Operator;; *) echo Gast;; esac', 'Operator\n');
t('case alt', 'x=a.md; case $x in *.txt|*.md) echo text;; *) echo other;; esac', 'text\n');
t('case quoted', 'x="*"; case abc in "$x") echo literal;; *) echo glob;; esac', 'glob\n');
t('function', 'gruss() { echo "Hallo $1 ($#)"; }; gruss Neo Trinity', 'Hallo Neo (2)\n');
t('function kw', 'function f { echo kw; }; f', 'kw\n');
t('function type', 'f() { :; }; type f', 'f is a function\nf () { :; }\n');
t('local', 'f() { local x=1; echo in$x; }; x=9; f; echo out$x', 'in1\nout9\n');
t('return', 'f() { return 3; }; f; echo $?', '3\n');
t('return outside', 'return', /can only `return'/, { err: true, code: 1 });
t('recursion', 'fak() { if [ $1 -le 1 ]; then echo 1; else echo $(( $1 * $(fak $(( $1 - 1 ))) )); fi; }; fak 5', '120\n');
t('break', 'for i in 1 2 3 4; do [ $i = 3 ] && break; echo $i; done', '1\n2\n');
t('continue', 'for i in 1 2 3; do [ $i = 2 ] && continue; echo $i; done', '1\n3\n');
t('continue 2', 'for i in 1 2; do for j in a b; do [ $j = b ] && continue 2; echo $i$j; done; done', '1a\n2a\n');
t('break outside', 'break', /only meaningful/, { err: true });
t('quoted at', 'f() { for a in "$@"; do echo "[$a]"; done; }; f "a b" c', '[a b]\n[c]\n');
t('quoted at empty', 'f() { for a in "$@"; do echo x; done; echo done; }; f', 'done\n');
t('shift', 'f() { shift; echo "$@"; }; f a b c', 'b c\n');
t('unset -f', 'f() { echo hi; }; unset -f f; f', /f: command not found/, { err: true, code: 127 });
t('read pipe', 'echo "Neo 42 extra" | { read name rest; echo "$name|$rest"; }', 'Neo|42 extra\n');
t('read REPLY', 'echo "  x  " | { read -r; echo "[$REPLY]"; }', '[  x  ]\n');
t('read tty', 'read x', /kann nicht auf Tastatureingaben warten/, { err: true, code: 1 });
t('while read', 'while read -r l; do echo ">$l"; done < documents/todo.txt | head -n 2', '>milch kaufen\n>server patchen\n');
t('while read IFS', 'while IFS=, read -r n a c; do echo $c; done < documents/contacts.csv | tail -n 1', 'Muenchen\n');
t('while read pipe', 'grep Failed logs/auth.log | while read m d t rest; do echo $t; done | head -n 1', '08:20:11\n');
t('while cat rest', 'printf "1\\n2\\n3\\n" | while read a; do cat; done', '2\n3\n');
t('heredoc', 'cat <<EOF\nHallo $USER\n$(echo cmd)\nEOF', 'Hallo hacker\ncmd\n');
t('heredoc quoted', "cat <<'EOF'\n$USER\nEOF", '$USER\n');
t('heredoc strip', 'cat <<-EOF\n\tA\n\tEOF', 'A\n');
t('herestring', 'tr a-z A-Z <<< "hallo"', 'HALLO\n');
t('dbracket glob', '[[ $USER == hack* ]] && echo ja', 'ja\n');
t('dbracket quoted', '[[ $USER == "hack*" ]] || echo nein', 'nein\n');
t('dbracket logic', '[[ -f notes.txt && ! -d notes.txt ]] && echo ok', 'ok\n');
t('dbracket regex', '[[ abc123 =~ [0-9]+ ]] && echo $BASH_REMATCH', '123\n');
t('dbracket nosplit', 'x="a b"; [[ $x == "a b" ]] && echo eq', 'eq\n');
t('arith cmd', 'x=1; ((x++)); ((x+=5)); echo $x; ((x > 100)) || echo klein', '7\nklein\n');
t('let', 'let y=6*7; echo $y', '42\n');
t('plus assign', 'a=x; a+=y; echo $a', 'xy\n');
t('group redirect', '{ echo a; echo b; } > g.txt; cat g.txt', 'a\nb\n');
t('loop pipe', 'for i in 3 1 2; do echo $i; done | sort', '1\n2\n3\n');
t('loop redirect', 'for i in 1 2; do echo $i; done > l.txt; wc -l < l.txt', '2\n');
t('subshell', '(cd /tmp; x=1; echo $PWD); echo $PWD $x', '/tmp\n/home/hacker\n');
t('negate', '! false && echo neg', 'neg\n');
t('nested', 'for i in 1 2; do if [ $i = 2 ]; then case $i in 2) echo zwei;; esac; fi; done', 'zwei\n');
t('comment', 'echo a # kommentar\necho b', 'a\nb\n');
t('syntax fi', 'fi', "bash: syntax error near unexpected token `fi'\n", { err: true, code: 2 });
t('syntax done', 'for i in 1; do echo; done done', /syntax error/, { err: true, code: 2 });
t('keyword quoted', '"if"', /if: command not found/, { err: true, code: 127 });
t('loop limit', 'while true; do :; done', /mehr als 10000 Schleifendurchlaeufe/, { err: true, code: 130 });
t('loop limit pipe', 'while true; do echo y; done | head -n 2', 'y\ny\n');
t('recursion limit', 'f() { f; }; f', /maximum function nesting level exceeded/, { err: true, code: 130 });
{
  // A fork bomb must stop quickly and without flooding the screen.
  const sh = mk();
  const t0 = Date.now();
  const r = exec(sh, ':(){ :|:& };:');
  const ms = Date.now() - t0;
  if (r.code === 130 && ms < 2000 && r.err.split('\n').length < 5) pass++;
  else { fail++; console.log('FAIL fork bomb', r.code, ms, r.err.slice(0, 200)); }
}
{
  // Scripts may span several lines and use functions, loops and positional parameters.
  const sh = mk();
  exec(sh, `printf '#!/bin/bash\\nzaehle() {\\n  local n=0\\n  for x in "$@"; do\\n    n=$((n+1))\\n  done\\n  echo "$n Argumente"\\n}\\nzaehle "$@"\\nif [ $# -gt 1 ]; then\\n  echo viele\\nfi\\n' > s.sh; chmod +x s.sh`);
  const r = exec(sh, './s.sh a "b c" d');
  if (r.out === '3 Argumente\nviele\n') pass++; else { fail++; console.log('FAIL multi-line script', JSON.stringify(r.out), r.err); }
}
{
  // Functions survive a save/load round trip.
  const sh = mk();
  exec(sh, 'hallo() { echo "hi $1"; }');
  const sh2 = new Shell(JSON.parse(JSON.stringify(sh.serialize())));
  let out = ''; sh2.write = (s, k) => { if (k === 'out') out += s; };
  sh2.run('hallo welt');
  if (out === 'hi welt\n') pass++; else { fail++; console.log('FAIL function persistence', JSON.stringify(out)); }
}
{
  // Multi-line input typed interactively, line by line.
  const sh = mk();
  const a = exec(sh, 'for i in 1 2; do');
  const b = exec(sh, '  echo $i');
  const c = exec(sh, 'done');
  if (a.run.incomplete && b.run.incomplete && c.out === '1\n2\n' && sh.history.at(-1) === 'for i in 1 2; do\n  echo $i\ndone') pass++;
  else { fail++; console.log('FAIL interactive loop', JSON.stringify([a.run, b.run, c.out, sh.history.at(-1)])); }
}
t('grep multi -e', 'seq 10 | grep -e 3 -e 8', '3\n8\n');
t('grep -ie', 'grep -ie neo -e TANK documents/contacts.csv', 'Neo,the_one,Hamburg\nTank,operator,Muenchen\n');

// --- parameter expansion, arrays and the newer builtins ---
t('trim suffix/prefix', 'f=a.tar.gz; echo ${f%.gz} ${f%%.*} ${f#*.} ${f##*.}', 'a.tar a tar.gz gz\n');
t('basename/dirname', 'p=/usr/local/bin; echo ${p##*/} ${p%/*}', 'bin /usr/local\n');
t('substr/case/replace', 'x=hello; echo ${x:1:3} ${x: -2} ${x^^} ${x^} ${x/l/L} ${x//l/L} ${#x}', 'ell lo HELLO Hello heLlo heLLo 5\n');
t('anchored replace', 's="Hallo Welt"; echo ${s,,} ${s::5} ${s/#H/h} ${s/%t/T}', 'hallo welt Hallo hallo Welt Hallo WelT\n');
t('defaults', 'echo ${y:=dflt} $y; echo ${z:-n} ${z+set} [${y:+w}]', 'dflt dflt\nn [w]\n');
t(':? aborts the line', 'echo ${z:?fehlt}; echo nie', 'bash: z: fehlt\n', { err: true, code: 1 });
t('indirect', 'x=5; echo ${!x-none}; y=x; echo ${!y}', 'none\n5\n');
t('prefix names', 'MYA=1 MYB=2; echo ${!MY*}', 'MYA MYB\n');
t('bad substitution', 'echo ${x@@}', 'bash: ${x@@}: bad substitution\n', { err: true });
t('array basics', 'a=(eins zwei "drei vier"); echo ${#a[@]} ${a[1]} ${a[-1]}; for i in "${a[@]}"; do echo "<$i>"; done', '3 zwei drei vier\n<eins>\n<zwei>\n<drei vier>\n');
t('array append/sparse', 'a=(1 2 3); a+=(4); a[6]=7; echo ${a[@]} ${#a[@]} ${!a[@]}; unset a[1]; echo ${a[@]}', '1 2 3 4 7 5 0 1 2 3 6\n1 3 4 7\n');
t('array slice/ops', 'a=(x y z); echo ${a[@]:1} ${a[@]^^} ${a[@]/y/Y} "${a[*]}"', 'y z X Y Z x Y z x y z\n');
t('array copy', 'a=(x "y z"); b=("${a[@]}"); echo ${#b[@]}', '2\n');
t('array in subshell', 'a=(1 2); (a+=(3); echo ${#a[@]}); echo ${#a[@]}', '3\n2\n');
t('declare -i', 'declare -i n=5*4; n+=1; echo $n', '21\n');
t('declare -p array', 'declare -a l=(a b); declare -p l', 'declare -a l=([0]="a" [1]="b")\n');
t('declare -F', 'f(){ :;}; declare -F', 'declare -f f\n');
t('assoc basics', 'declare -A port=([ssh]=22 [http]=80); port[dns]=53; echo ${port[ssh]} ${#port[@]}; for k in "${!port[@]}"; do echo "$k=${port[$k]}"; done', '22 3\nssh=22\nhttp=80\ndns=53\n');
t('assoc quoted keys', 'declare -A m; k="a b"; m[$k]=1; m["x y"]+=2; m["x y"]+=3; echo "${m[a b]}" "${m[x y]}"; unset "m[a b]"; echo ${#m[@]}', '1 23\n1\n');
t('assoc declare -p', 'declare -A m=([a]=1 ["b c"]=2); declare -p m', 'declare -A m=([a]="1" ["b c"]="2" )\n');
t('assoc needs subscript', 'declare -A m=(x y)', /must use subscript/, { err: true });
t('assoc vs indexed', 'a=(1); declare -A a', /cannot convert indexed to associative/, { err: true });
t('assoc in subshell', 'declare -A m=([k]=1); (m[k]=2; echo ${m[k]}); echo ${m[k]}', '2\n1\n');
t('assoc local', 'f() { local -A t=([q]=1); echo ${t[q]}; }; f; echo "[${t[q]-}]"', '1\n[]\n');
t('indexed with subscripts', 'a=([2]=c x [0]=a); echo ${a[@]} ${!a[@]}', 'a c x 0 2 3\n');
t('readonly', 'readonly K=1; K=2; unset K; echo $K', '1\n');
t('readonly msg', 'readonly K=1; K=2', 'bash: K: readonly variable\n', { err: true });
t('local array', 'f() { local -a t=(1 2); echo ${#t[@]}; }; f; echo "[${t[@]}]"', '2\n[]\n');
t('local int', 'f() { local -i n=$1; n+=1; echo $n; }; f 4; echo "[${n-u}]"', '5\n[u]\n');
t('local outside func', 'local x=1', 'bash: local: can only be used in a function\n', { err: true, code: 1 });
t('printf -v', 'printf -v v "%03d" 7; echo $v', '007\n');
t('set --', 'set -- a b c; echo $# $2; set --; echo $#', '3 b\n0\n');
t('set -e', 'set -e; echo a; false; echo b', 'a\n');
t('set -e conditions', 'set -e; if false; then :; fi; false || echo ok; ! true; echo weiter', 'ok\nweiter\n');
t('pipefail', 'set -o pipefail; false | true; echo $?; set +o pipefail; false | true; echo $?', '1\n0\n');
t('set -u', 'set -u; echo $nix; echo x', 'bash: nix: unbound variable\n', { err: true });
t('set -x', 'set -x; echo hi', '+ echo hi\n', { err: true });
t('set -o list', 'set -o pipefail; set -o | grep pipefail', 'pipefail       \ton\n');
t('mapfile', "printf 'a\\nb\\nc\\n' | { mapfile -t L; echo ${#L[@]} ${L[2]}; }", '3 c\n');
t('readarray file', 'readarray -t arr < /etc/passwd; echo ${arr[0]%%:*}', 'root\n');
t('read -a', 'IFS=: read -a parts <<< "a:b:c"; echo ${parts[2]} ${#parts[@]}', 'c 3\n');
t('getopts', 'f() { while getopts "vf:" o; do echo "$o ${OPTARG-}"; done; shift $((OPTIND-1)); echo "rest $@"; }; f -v -f log x y', 'v \nf log\nrest x y\n');
t('getopts bad option', 'f() { getopts "a" o; echo $o; }; f -z', '?\n');
t('ERR trap', "f() { trap 'echo ERR $?' ERR; false; echo nach; }; f", 'ERR 1\nnach\n');
t('kill $$ runs trap', "trap 'echo got USR1' USR1; kill -USR1 $$; kill -s USR1 $$; trap '' TERM; kill $$; echo alive", 'got USR1\ngot USR1\nalive\n');
t('kill $$ KILL', 'kill -9 $$', /nicht abschiessen/, { err: true });
t('kill job spec', 'true & kill %1; kill %7', /^\[1\] \d+\nbash: kill: \(\d+\) - No such process\nbash: kill: %7: no such job\n$/, { err: true });
t('kill bad signal', 'kill -FOO 1337', 'bash: kill: FOO: invalid signal specification\n', { err: true });
t('kill normal pid still works', 'kill -9 1337; ps aux | grep -c xmrig', '0\n');
{
  const sh = mk();
  exec(sh, "trap 'echo abgefangen' INT");
  sh.buf.out = '';
  const hit = sh.trapSignal('INT');
  if (hit && sh.buf.out === 'abgefangen\n' && !sh.trapSignal('TERM')) pass++; else { fail++; console.log('FAIL trapSignal INT', hit, JSON.stringify(sh.buf.out)); }
}
t('trap -p', "trap 'echo x' INT; trap -p INT; trap - INT; trap -p", "trap -- 'echo x' INT\n");
t('EXIT trap in script', `printf '%s\\n' "trap 'echo bye \\$?' EXIT" 'set -e' 'echo start' 'false' 'echo never' > /tmp/s.sh; bash /tmp/s.sh; echo rc=$?; set -o | grep errexit`, 'start\nbye 1\nrc=1\nerrexit        \toff\n');
t('pushd/popd', 'cd /; pushd /etc >/dev/null; pushd /tmp >/dev/null; dirs; popd >/dev/null; pwd', '/tmp /etc /\n/etc\n');
t('popd empty', 'popd', 'bash: popd: directory stack empty\n', { err: true, code: 1 });
t('background + wait', 'false & wait $!; echo $?', '1\n');
t('background notice', 'true &', /^\[1\] \d+\n$/, { err: true });
t('jobs', 'true & false & jobs', '[1]-  Done                    true\n[2]+  Exit 1                  false\n');
t('unset -f', 'f() { :; }; unset -f f; type f', 'bash: type: f: not found\n', { err: true });
t('declare -f source', 'f() { echo $1; }; declare -f f', 'f () { echo $1; }\n');
{
  const sh = mk();
  exec(sh, 'arr=(a "b c"); readonly RO=1; declare -A cfg=([__proto__]=x [host]=box)');
  const back = new Shell(JSON.parse(JSON.stringify(sh.serialize())));
  back.game = new Game(); back.buf = { out: '', err: '' };
  back.write = (x, k) => { if (k === 'out') back.buf.out += x; };
  t('arrays persist', 'echo ${#arr[@]} ${arr[1]}; RO=2; echo $RO ${cfg[host]} ${cfg[__proto__]} ${#cfg[@]}', '2 b c\n1 box x 2\n', { sh: back });
}
{
  const sh = mk();
  exec(sh, 'meinvar=1; meinfunc() { :; }');
  const c1 = sh.complete('echo $mei'), c2 = sh.complete('meinf');
  if (c1.line === 'echo $meinvar ' && c2.line === 'meinfunc ') pass++; else { fail++; console.log('FAIL completion of $VAR / functions', c1, c2); }
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

// --- chapter 7 missions must not accept near misses ---
{
const first = MISSIONS.findIndex(m => m.ch === 6);
const cases = [
  [0, 'ls logs', false], [0, 'for f in logs/*.log; do basename $f .log; done', false], [0, 'for f in logs/*.log; do basename ${f%.log}; done', true],
  [1, 'ziele=(localhost darknode.local example.com)', false], [1, 'ziele=(localhost darknode.local example.com box); echo ${#ziele[@]}', true],
  [2, 'for z in localhost darknode.local example.com; do nc -zv $z 22; done', false],
  [3, 'wc -l logs/auth.log; tail -1 logs/auth.log', false], [3, 'readarray z < logs/auth.log; echo ${#z[@]} "${z[@]: -1}"', true],
  [4, 'nmap -p 22 darknode.local', false],
  [5, "bash -c \"trap 'echo bye' EXIT; touch /tmp/spur\"", false],
  [6, "bash -c 'set -euo pipefail; echo ok'", false], [6, "set -euo pipefail; echo $NIX", false],
  [7, 'echo "Ziele: x" > report.txt', false], [7, 'printf "Ziele: %s\\nAngriffe: 3\\n" "${ziele[*]}" > report.txt', false],
];
  for (const [k, line, want] of cases) {
    const sh = mk();
    exec(sh, 'ziele=(localhost darknode.local example.com)');
    const g = new Game({ idx: first + k });
    const got = g.afterRun(sh, exec(sh, line).run).some(e => e.type === 'mission');
    if (got === want) pass++; else { fail++; console.log(`FAIL mission check "${MISSIONS[first + k].title}": ${line} -> ${got}`); }
  }
}

// --- learning mode tips ---
{
  const tipCases = [
    ['grpe Failed logs/auth.log', 'Meintest du grep?'], ['Ls', /Gross- und Kleinschreibung.*ls$/], ['dir', /Windows-Befehl.*ls -l/],
    ['cd..', /Leerzeichen: cd \.\.$/], ['cd readme.txt', /Datei, kein Ordner.*cat readme.txt/], ['cat logs', /ist ein Ordner/],
    ['cat redme.txt', 'Meintest du readme.txt?'], ['cat logs/Auth.log', 'Meintest du logs/auth.log?'], ['rm logs', /rm -r logs/],
    ['x = 5', /x=5$/], ['[-f x]', /Leerzeichen drumherum/], ['touch t.sh; ./t.sh', /chmod \+x t\.sh/], ['echo "abc', /wartet auf den Rest/],
    ['ls', null], ['grep -c Failed logs/auth.log', null],
  ];
  for (const [line, want] of tipCases) {
    const sh = mk();
    sh.game = new Game({ idx: MISSIONS.length });
    const ev = sh.game.afterRun(sh, exec(sh, line).run).filter(e => e.type === 'tip');
    const got = ev[0]?.text ?? null;
    const ok = want === null ? got === null : typeof want === 'string' ? got === want : want.test(got ?? '');
    if (ok) pass++; else { fail++; console.log(`FAIL tip for ${line}: ${JSON.stringify(got)}`); }
  }
  // Generic tips stop after a few showings; tipps aus silences everything; sudo tip waits while a mission teaches sudo.
  const sh = mk();
  sh.game = new Game({ idx: MISSIONS.length });
  const count = () => sh.game.afterRun(sh, exec(sh, 'asdfgh').run).filter(e => e.type === 'tip').length;
  const shown = [1, 2, 3, 4, 5].map(count).reduce((a, b) => a + b);
  exec(sh, 'tipps aus');
  const typo = sh.game.afterRun(sh, exec(sh, 'grpe x').run).filter(e => e.type === 'tip').length;
  const sudoIdx = MISSIONS.findIndex(m => m.hint.startsWith('sudo cat /etc/shadow'));
  const sh2 = mk();
  sh2.game = new Game({ idx: sudoIdx });
  const spoiled = sh2.game.afterRun(sh2, exec(sh2, 'cat /etc/shadow').run).filter(e => e.type === 'tip').length;
  if (shown === 3 && typo === 0 && spoiled === 0 && sudoIdx >= 0) pass++; else { fail++; console.log('FAIL tip throttling', shown, typo, spoiled, sudoIdx); }
}

// --- cheat sheet ---
{
  const sh = mk();
  sh.game = new Game({ idx: 15 });
  const all = exec(sh, 'spick').out, locked = exec(sh, 'spick 7').out, bad = exec(sh, 'spick 9');
  const ok = all.includes('Kapitel 3: Lesen & Suchen') && !all.includes('Kapitel 4') && /gesperrt/.test(locked) && bad.code === 2;
  sh.game = new Game({ idx: MISSIONS.length });
  const done = exec(sh, 'cheat 7').out;
  if (ok && done.includes('set -euo pipefail')) pass++; else { fail++; console.log('FAIL spick', JSON.stringify(all), locked, done); }
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
    'ss -tulpn', 'nmap -sV darknode.local', 'for h in localhost darknode.local example.com; do ping -c 1 $h; done',
    'if [ -f /var/backups/master.key ]; then echo GEFAEHRDET; else echo SICHER; fi',
    'grep Failed logs/auth.log | while read monat tag zeit rest; do echo $zeit; done',
    'portscan() { nmap "$1"; }; portscan darknode.local', 'sha256sum tools/scan.sh > tools.sha256 && sha256sum -c tools.sha256',
    'echo "*/5 * * * * $HOME/tools/scan.sh" > job.txt && crontab job.txt && crontab -l', 'sudo systemctl stop nginx && ss -tln',
    'for f in logs/*.log; do n=${f##*/}; echo ${n%.log}; done', 'ziele=(localhost darknode.local example.com); echo ${#ziele[@]}',
    'for z in "${ziele[@]}"; do nc -zv $z 22; done', 'mapfile -t zeilen < logs/auth.log; echo ${#zeilen[@]}; echo "${zeilen[-1]}"',
    'scan() { local OPTIND p=80; while getopts "p:" o; do p=$OPTARG; done; shift $((OPTIND-1)); nmap -p $p "$1"; }; scan -p 22 darknode.local',
    `bash -c "trap 'rm -f /tmp/spur; echo aufgeraeumt' EXIT; touch /tmp/spur; ls /tmp"`,
    `bash -c 'set -euo pipefail; echo start; echo $NICHTDA; echo NIE'`,
    '{ echo "Ziele: ${ziele[*]}"; echo "Angriffe: $(grep -c Failed logs/auth.log)"; } > report.txt; cat report.txt',
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
