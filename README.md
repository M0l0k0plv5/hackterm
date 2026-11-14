# HackTerm

Learn Linux/Unix commands on your iPhone in a simulated hacker terminal.
Pure HTML/CSS/JavaScript web app (PWA), no build step and no dependencies.

## Features

- **Real shell semantics**: pipes `|`, redirections `> >> < 2> 2>&1 &>`, `&& || ;`,
  variables, `$(...)`, backticks, `$((...))`, globs `* ? [..]`, brace expansion `{a,b} {1..5}`,
  quoting, aliases, history `!!`, tab completion, scripts with `$1`, `./script.sh` and the execute bit.
- **Simulated filesystem** with Unix permissions (rwx, owner/group), symlinks, `/etc`, `/var/log`,
  `/root` (root only), `/proc` ... Saved in `localStorage`.
- **~150 commands** with real options and real error messages: `ls cd cat grep sed awk find sort uniq
  cut tr wc head tail xargs tee diff tar chmod sudo ps kill base64 curl ping nano` and more.
  awk is a real little interpreter (arrays, `for`, `if`, `printf`, `BEGIN/END`, regex).
- **Text, hashes and archives**: `paste comm column fold shuf expr factor`, `md5sum sha1sum sha256sum`
  (with `-c`), `xxd hexdump`, `gzip gunzip zcat`, `grep -A/-B/-C`, `stat -c`, `umask`, `mktemp`, `chgrp`.
- **System and services**: `systemctl journalctl crontab pstree dmesg who w last lscpu lsblk mount time`.
  Stopping a service really removes its process and its listening port.
- **Simulated network toolbox**: `nmap nc host nslookup dig traceroute netstat ss lsof`. Nothing leaves
  the browser; the hosts, ports and sockets match the story (e.g. the miner's connection to darknode).
- **Gamification**: 26 missions in 5 chapters with a story (attacker in the logs, crypto miner,
  root flag), XP, 7 ranks, 9 achievements, `hint`, `stats`, `missions`.
- **Hacker look**: CRT scanlines, glow, boot sequence, `cmatrix`, themes (`theme amber|cyan|red|mono`).
- **iPhone**: special-key bar (TAB, arrows, `| > ~ * $` ...), keyboard-aware layout, safe areas,
  "Add to Home Screen" for fullscreen and offline use (service worker).

## Run

```sh
python3 -m http.server 8765
# Mac:    http://localhost:8765
# iPhone: http://<Mac-IP>:8765  (same Wi-Fi)
```

Offline mode/service worker needs HTTPS (e.g. GitHub Pages); everything else also works over plain HTTP.

## Security

Everything runs inside the page. Commands are interpreted by the simulator; there is no `eval`,
no `new Function` and no network access. All terminal output is HTML-escaped, and a strict
Content-Security-Policy (`script-src 'self'`, no inline code) is set in `index.html`. Maps that are
indexed with user input (directory entries, variables, aliases, lookup tables) have no prototype,
so names like `__proto__` or `constructor` behave like any other name. Archives created by `tar`
are plain files the user can edit and are validated before extraction. Output sizes and recursion
are capped so that a command cannot freeze the tab. A pathological regular expression in `grep`/`sed`
can still make the own tab slow, as in any browser regex engine.

## Tests

```sh
node test/test.mjs
```

Covers the shell, the commands, the security fixes and a full playthrough of all missions.

## Structure

| File | Purpose |
| --- | --- |
| `js/vfs.js` | in-memory filesystem with permissions |
| `js/shell.js` | lexer, parser, expansion, pipelines, completion |
| `js/commands.js` | command implementations |
| `js/more.js` | additional commands: text, hashes, gzip, services, cron, network |
| `js/awk.js` | awk interpreter, also used for `$((...))` and `bc` |
| `js/world.js` | initial filesystem, processes, man pages |
| `js/game.js` | missions, XP, ranks, achievements |
| `js/app.js` | UI: rendering, input, nano editor, effects, storage |
