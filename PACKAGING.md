# Packaging and distributing Levix

How to ship this bot, and why the setup is now short enough that someone who
has never opened a terminal can get through it.

Written after the move off MongoDB and `.env`. If you are looking for *what*
changed rather than *how to ship it*, the summary is at the end.

---

## 1. What made packaging possible

A program is easy to package when it needs nothing from the machine it lands
on. Four changes got Levix there.

**One datastore, and it is a file.** `node:sqlite` ships inside Node from
version 24, so the database costs zero dependencies: nothing to compile, no
`mongod` to install, no connection string to get wrong, no service to start
before the bot. The old setup asked a non-developer to install MongoDB. That
was, on its own, the single biggest reason people gave up.

**No configuration file.** There is no `.env`. Every value an operator can
change is a row in `bot_settings`, read through `settings.get(key)` at call
time, edited from the control panel. A fresh install runs correctly with an
empty database.

**Secrets are generated, not requested.** The session signing key is 48 random
bytes made on first start and stored. The panel password is chosen once in the
browser and kept as an scrypt hash. Nobody is ever asked to invent a secret and
paste it into a file — which they would otherwise do badly, or skip.

**Everything mutable is in one directory.** Database, WhatsApp session, memory
files, editable AI persona, logs, temp media. Resolution order lives in
`src/config/paths.cjs`:

1. `--data <dir>` on the command line
2. `LEVIX_DATA_DIR` — the one environment variable read anywhere in the code,
   because a Docker volume has no other way to say where it is
3. `<repo>/data` when running from a clone
4. `~/.levix` otherwise

That last split is what lets the same code run from a git checkout, a global
npm install, and a read-only container image without a flag.

---

## 2. The four channels

| Channel | For | They need | Time to first message |
| --- | --- | --- | --- |
| npm global | anyone with Node | Node 24+ | ~2 min |
| Docker | anyone with Docker | Docker | ~3 min (first build) |
| Install script | a Linux VPS | Node 24+, systemd, sudo | ~3 min, survives reboot |
| Single binary | no Node at all | nothing | ~1 min |

### 2.1 npm — the default

```bash
npm install -g levix-bot
levix
```

The npm distribution package is `levix-bot`. Its `bin` entry intentionally
installs the short `levix` command, so the product and CLI keep the Levix name.

Shipping a release:

```bash
npm version patch          # or minor / major
npm publish                # `files` in package.json controls what goes
git push --follow-tags
```

`package.json` carries `bin: { levix: "bin/levix.js" }` and a `files` list, so
the tarball is source, views, public assets and the deploy templates — no
tests, no build output, no data.

`src/cli.js` checks the Node version before anything else and prints an
actionable message instead of a stack trace. It carries the modes and the
commands you cannot reach from inside the panel:

```bash
levix                    # the bot + the panel, and a browser on a desktop
levix headless           # the bot alone — no Express, no port opened
levix where              # print the data directory
levix reset-password     # forget the panel password, keep the WhatsApp link
levix domain bot.example.com   # reverse proxy + HTTPS, may need sudo
```

`npx --package levix-bot levix` works too, but installing globally is better
here: the bot is a long-running service, not a one-shot tool.

### 2.2 Docker — the "nothing on my system" option

```bash
docker compose up -d
docker compose logs levix | grep -F '[Setup] Setup code:' | tail -1
```

`Dockerfile` is a two-stage build on `node:24-slim`. Debian, not Alpine, on
purpose: `ffmpeg-static` ships a glibc binary that will not run on musl, and
the failure is silent — thumbnails just stop.

Everything lives in one named volume mounted at `/data`, which the image marks
`VOLUME` and hands to the unprivileged `node` user.

To publish images:

```bash
docker build -t ghcr.io/abdodiab2005/levix:1.2.0 -t ghcr.io/abdodiab2005/levix:latest .
docker push ghcr.io/abdodiab2005/levix --all-tags
```

One caveat worth putting in the release notes: the control-panel port is a
setting in the database, and changing it inside a container just moves the
listener away from the published port. Under Docker, change the mapping in
`docker-compose.yml` instead. The field says so in the panel.

Never run more than one replica. A WhatsApp pairing is a single session, and
two processes on one database would fight over it.

### 2.3 The install script — a server that comes back after a reboot

```bash
curl -fsSL https://levix.leviro.net/install.sh | bash
```

`deploy/install.sh` checks Node, installs `levix-bot` from npm, creates a
`levix` system user and `/var/lib/levix`, installs `deploy/levix.service`,
enables it and prints where to go next. It is deliberately short and commented
so anyone can read it before piping it into a shell — which they should.

The unit is hardened the way a single-directory app allows: `ProtectSystem=
strict` with one `ReadWritePaths`, `ProtectHome`, `NoNewPrivileges`,
`PrivateTmp`. `Restart=always` matters — the bot deliberately exits on an
unrecoverable error and expects a supervisor to bring it back.

For a desktop rather than a server, `pm2` covers the same ground:

```bash
pm2 start levix --name levix && pm2 save && pm2 startup
```

### 2.4 The single executable — no Node at all

```bash
npm i -D esbuild postject     # build-only
npm run build:sea             # -> build/levix  (~134 MB, linux-x64)
```

One file. It carries its own Node, its own SQLite, the control panel, and all
55 commands. Copy it to a machine with nothing installed and run it.

`scripts/build-sea.mjs` does four things, because Node's SEA takes exactly one
CommonJS file and this app is neither:

1. **Writes command manifests.** Both loaders (`command.handler.js` and
   `group.cjs`) scan a directory at startup. An executable has no directory to
   scan, so the build generates `_manifest.cjs` files that `require` every
   command statically. Without a manifest the loaders read the directory as
   before, so a normal install is unaffected — and dropping a new `.cjs` into
   `src/commands/` still works with no build step.

2. **Inlines the assets.** `views/`, `public/` and the persona template
   (~690 KB) go in as base64. On first run the executable writes them under
   `<data>/assets/<build stamp>` and points the app there via
   `setAssetRoot()`; a previous build's copy is deleted. Express and EJS get
   real paths on a real filesystem and never know the difference.

3. **Unwraps `createRequire`.** Fifteen ESM files do
   `const require = createRequire(import.meta.url)` and then require a `.cjs`
   sibling. esbuild inlines a plain `require("./x.cjs")` but *not* one made
   through `createRequire` — it leaves it as a runtime lookup, which inside an
   executable fails. An esbuild plugin drops that one line per file, which
   turns those calls into plain requires the bundler resolves.

4. **Bundles, prepares the blob, injects it** with
   `--experimental-sea-config` and `postject`, including the macOS
   remove-signature / re-sign dance.

Three things had to change in the app itself for this to work, all of them
improvements on their own:

- `app.engine("ejs", require("ejs").__express)` instead of letting Express
  `require("ejs")` lazily by name.
- The socket.io browser bundle is vendored in `public/socket.io.min.js` with
  `serveClient: false`, rather than being read out of `node_modules` per
  request — the same treatment `qrcode.min.js` already had.
- Pino's `transport` targets run in worker threads that load their target by
  module path. Packaged builds use `pino.multistream` in-process instead; same
  three destinations, detected with `require("node:sea").isSea()`.

**What the binary does not carry: ffmpeg.** `ffmpeg-static` is an 80 MB native
binary that has to exist on disk to be executed. The build resolves the module
to `null`, so `src/utils/thumbnail.cjs` falls through to `ffmpeg` on `PATH`, or
whatever Settings → Media points at. Without either, video previews are off and
images fall back to raw-JPEG previews. Everything else works.

**One binary per platform.** SEA embeds the host's `node`, so build on the
platform you are targeting — GitHub Actions with a matrix is the natural home
for this (`.github/workflows/release.yml` does exactly that).

---

## 3. What the first five minutes look like

### For someone who is not a developer

1. Install Node from nodejs.org — the big green LTS button.
2. Open Terminal, paste `npm install -g levix-bot`, press Enter.
3. Type `levix`. A box appears with an address.
4. Open the address. Type a password twice.
5. Click **Connection**, press **Start session**, then scan the QR with
   WhatsApp → Linked devices. Levix does not open a WhatsApp connection until
   you ask it to.
6. Send `!ping` to yourself. It replies.

No file is edited. No key is generated. Nothing is installed besides Node —
and with the single binary, not even that.

The remaining sharp edges, and what each one now says:

| Trips them up | What happens |
| --- | --- |
| Old Node | `bin/levix.js` explains which version and where to get it |
| Port taken | A sentence saying the bot is probably already running, and where to change the port |
| Lost password | `levix reset-password`, WhatsApp link untouched |
| Where's my data? | `levix where` |
| Panel on a public IP | First-run page demands the terminal-printed setup code |

### For a developer

```bash
git clone … && cd levix && npm install && npm start
```

Data lands in `./data` (gitignored), so a clone never touches `~/.levix`.
`npm run dev` is the same under nodemon. No database to start, no `.env` to
copy, no fixtures. Delete `data/` to reset.

---

## 3b. What proves a distribution works

Three scripts, each of which exercises the built artifact rather than the
checkout — because the checkout is exactly what can't tell you whether the
thing you ship works:

| Command | What it actually does |
| --- | --- |
| `npm run validate:tarball` | `npm pack`, install into an empty prefix, run the installed `levix`: first run, password, restart, headless, `reset-password` |
| `npm run validate:sea` | copies the executable to a directory with no source tree, starts it, checks extracted assets, the rendered views, the vendored socket.io client, the command manifests, pino's transports, restart persistence, `ffmpeg` absent, recovery |
| `npm run validate:docker` | builds, starts, claims through the panel, then `restart` / `down`+`up` / rebuild-the-image, checking the password and database survive each; also that it runs as `node`, that `/data` is writable on a fresh volume, and that one process runs |

`npm test` is the fast suite that runs constantly; these three take minutes and
run in CI and before a tag.

`validate:docker` exits **2** when there is no Docker daemon, so "not tested
here" is distinguishable from "broken" — CI treats a 2 on a runner as a
failure.

## 4. Releasing

A tagged release should produce: the `levix-bot` npm package, a Docker image,
and one binary per platform.

```bash
npm version minor
git push --follow-tags
```

`.github/workflows/release.yml` reacts to the tag. It **calls
`ci.yml` first** — the same jobs a pull request runs (tests, tarball install,
the executable on all three platforms, Docker) — and every publishing job
`needs: ci`. A release that would fail CI is not a release; there is no
release-only copy of the test matrix to drift out of date.

Then it publishes `levix-bot` to npm (needs `NPM_TOKEN`), pushes the image to
GHCR (uses the built-in `GITHUB_TOKEN`), builds and *validates* one binary per
platform, and attaches them to the release along with `SHA256SUMS.txt`.

The checksums are computed in the same job that uploads the files, from those
exact files, and verified with `sha256sum -c` before the upload. Nothing is
hardcoded, and the manifest cannot describe a different build than the one
people download.

```
sha256sum -c SHA256SUMS.txt
```

### 4a. The public installer

The last job of a release publishes the installer that

```bash
curl -fsSL https://levix.leviro.net/install.sh | bash
```

fetches. It runs **after the GitHub Release exists**, which is after CI, the
packed tarball and all three executables have passed — an installer cannot go
public ahead of the release it installs.

`deploy/install.sh` is the only installer source in the repository. Nothing
generated from it is ever committed. A release does this to it:

```
deploy/install.sh                      VERSION="latest"
  └─ scripts/build-release-installer.mjs v2.0.1
       └─ dist/levix-v2.0.1-install.sh  VERSION="2.0.1"
            ├─ GitHub Release asset  (covered by SHA256SUMS.txt)
            └─ the download server
                 ├─ /install/v2.0.1.sh   written once, never rewritten
                 └─ /install.sh          replaced by a rename
```

Because the version is baked into the file rather than looked up when it runs,
`https://levix.leviro.net/install/v2.0.1.sh` still installs 2.0.1 long after
2.5.0 exists. `/install.sh` is a moving alias for the newest stable release.

A **prerelease** (`v2.1.0-rc.1`) publishes its versioned installer and leaves
`/install.sh` alone, so a release candidate can be handed to someone by URL
without becoming what everybody else installs.

`scripts/publish-installer.sh` is the half that runs on the server, and it is a
separate file so `tests/installer.test.mjs` can run it against a temporary
directory. It validates the upload (shebang, `bash -n`, pinned to the version
being published) *before* anything is put in place, writes every file by
renaming a sibling onto it, refuses to rewrite a versioned installer that
already exists with different content, and refuses to move `/install.sh`
backwards to an older release. If the versioned file is published but the alias
is not, it says so and fails the job rather than reporting success.

Rolling back is a copy, on purpose:

```bash
sudo -u levix-deploy cp /var/www/levix-downloads/install/v2.0.0.sh \
                        /var/www/levix-downloads/install.sh
```

Nothing about this touches the website, and Nginx serves the files straight off
disk — no reload, no restart, nothing to redeploy. `deploy/nginx/` has the
location blocks.

Secrets, on the `installer-production` environment:
`LEVIX_DEPLOY_HOST`, `LEVIX_DEPLOY_USER`, `LEVIX_DEPLOY_SSH_KEY`,
`LEVIX_DEPLOY_KNOWN_HOSTS`, and optionally `LEVIX_DEPLOY_PORT` and
`LEVIX_DEPLOY_ROOT`. The deployment account owns one directory and nothing
else; the workflow never disables host-key checking and never runs `sudo` on
the server.

Before tagging:

- [ ] `npm start` on a clean `data/` — the setup page appears
- [ ] Set a password, press Start session, scan a QR, `!ping` answers
- [ ] `docker compose up --build` — same flow
- [ ] `npm run build:sea`, run the binary against an empty data directory
- [ ] `levix reset-password` then log in again
- [ ] Existing install still starts (the schema migrates on open)

### Schema changes

`src/db/db.cjs` holds an array of migrations and stamps `PRAGMA user_version`.
Append a function, never edit one that has shipped. Every start applies what is
missing, so an upgrade is just a new version of the code.

---

## 5. Summary of what changed

| Before | Now |
| --- | --- |
| MongoDB + mongoose, install a server first | `node:sqlite`, one file, zero dependencies |
| In-memory snapshot + write-behind queue to fake sync reads | Direct synchronous queries |
| `.env` with ~30 keys, several required to boot | No file; database + panel, empty install works |
| `SESSION_SECRET`, `BOT_PASSWORD` invented by hand | Generated; password chosen in the browser |
| `OWNERS_LIST` / `ADMINS_LIST` | Whoever scans the QR, plus the Roles screen |
| `POST /api/send` with an API key | Removed |
| `config.json` shipped and edited in place | `src/config/defaults.cjs`, overridden in the database |
| `config/schedule.json` | A `schedules` table the panel can list |
| Data scattered: `./memory`, `./logs`, `./media`, Mongo | One data directory |
| Two runtime deps for config (`dotenv`, `mongoose`) | Neither |

Dependencies dropped: `mongoose`, `dotenv`. Added: none at runtime;
`esbuild` and `postject` for the optional binary build.