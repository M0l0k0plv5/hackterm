# HackTerm

Learn Linux/Unix commands on your iPhone in a simulated hacker terminal.
Pure HTML/CSS/JavaScript web app (PWA), no build step and no dependencies.

## Features

- **Real shell semantics**: pipes `|`, redirections `> >> < 2> 2>&1 &>`, `&& || ;`,
  variables, `$(...)`, backticks, `$((...))`, globs `* ? [..]`, brace expansion `{a,b} {1..5}`,
  quoting, aliases, history `!!`, tab completion, scripts with `$1`, `./script.sh` and the execute bit.
- **Simulated filesystem** with Unix permissions (rwx, owner/group), symlinks, `/etc`, `/var/log`,
  `/root` (root only), `/proc` ... Saved in `localStorage`.
- **~100 commands** with real options and real error messages: `ls cd cat grep sed awk find sort uniq
  cut tr wc head tail xargs tee diff tar chmod sudo ps kill base64 curl ping nano` and more.
  awk is a real little interpreter (arrays, `for`, `if`, `printf`, `BEGIN/END`, regex).
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

## Tests

```sh
node test/test.mjs
```

Covers the shell, the commands and a full playthrough of all missions.

## Structure

| File | Purpose |
| --- | --- |
| `js/vfs.js` | in-memory filesystem with permissions |
| `js/shell.js` | lexer, parser, expansion, pipelines, completion |
| `js/commands.js` | command implementations |
| `js/awk.js` | awk interpreter, also used for `$((...))` and `bc` |
| `js/world.js` | initial filesystem, processes, man pages |
| `js/game.js` | missions, XP, ranks, achievements |
| `js/app.js` | UI: rendering, input, nano editor, effects, storage |
