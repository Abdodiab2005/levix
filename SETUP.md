# Setting up Levix

Levix is a WhatsApp bot you run yourself. It links to your own WhatsApp account
by scanning a QR code, exactly like WhatsApp Web, and everything after that is
configured from a control panel in your browser.

There is no configuration file to edit. There are no keys to generate. If a
guide anywhere tells you to create a `.env` file, it is out of date.

---

## What you need

- A computer or a small server that stays on. A Raspberry Pi is enough.
- **Node.js 24 or newer** — [nodejs.org](https://nodejs.org), pick the LTS
  button. (Or skip Node entirely and use Docker, below.)
- A phone with WhatsApp, to scan the QR once.

Levix stores everything in one file using SQLite, which Node 24 includes.
Nothing is compiled, nothing else is installed, no database server is needed.

---

## The quickest way

```bash
npm install -g levix
levix
```

The terminal prints something like:

```
  Levix is running

  Panel: http://localhost:3001/setup
  Data:  ~/.levix

  First run — that link asks you to pick a password.
  Opening it from another machine also needs this code: 43CB5162

  Opening Levix in your browser...

  Press Ctrl+C to stop.
```

1. On a desktop the browser opens by itself. Otherwise open that address.
2. Choose a password. (Opening the page from a *different* machine also asks
   for the setup code above — that's what stops a stranger from claiming your
   bot before you do.)
3. You land on the control panel. Go to **Connection** and scan the QR with
   WhatsApp → Settings → Linked devices → Link a device.
4. Send `!ping` in any chat. The bot answers.

Levix only opens a browser when there is one to open: over SSH, under systemd,
in Docker or in CI it just prints the address and says why. `--no-open` turns
it off anywhere.

That's the whole setup. Keep the terminal open, or see *Keeping it running*.

---

## With Docker instead

No Node install, nothing on your system but the container:

```bash
git clone https://github.com/Abdodiab2005/levix
cd levix
docker compose up -d
```

Then open <http://localhost:3001>. The setup code is in the logs:

```bash
docker compose logs levix | grep -A3 "Setup code"
```

Everything the bot owns lives in the `levix-data` volume.

---

## Running it without the web panel

On a server you may not want a panel at all:

```bash
levix headless
```

That starts the bot and nothing else — no web interface, no port opened. If the
bot has never been paired it prints the QR straight into the terminal:

```
  Levix — headless

  No WhatsApp session found.

  Scan this QR from:
  WhatsApp -> Linked devices -> Link a device

  [ the QR ]

  ✓ WhatsApp connected
  ✓ Levix is ready

  55 commands loaded
```

You can switch modes freely: the data directory is the same either way.

---

## Putting it on a domain

```bash
sudo levix domain bot.example.com
```

Levix looks at what the server already runs and fits in with it:

| What it finds | What it does |
| --- | --- |
| nginx (+ certbot) | adds one nginx site, runs `nginx -t`, reloads, offers HTTPS |
| Caddy | adds one site file to the existing Caddy |
| Apache | prints the reverse-proxy settings; changes nothing |
| a hosting panel (Plesk, cPanel, CloudPanel, …) | prints the settings and where to enter them; changes nothing |
| nothing at all | offers to install Caddy, which handles HTTPS by itself |
| something unrecognised on :80/:443 | stops and tells you what is there |

It never edits another site, never overwrites `nginx.conf`, and never reloads a
configuration that failed validation. Running it twice does not create a second
copy of anything.

The bot itself never needs root — only this command does, and only when it is
actually going to write to `/etc`.

---

## Turning on the parts that need a key

The bot works out of the box. Two features need a free key, and both are set in
**Settings** in the panel — never in a file:

| Feature | Where to get the key |
| --- | --- |
| AI replies (`!gemini`, `!ai`) | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) |
| Weather (`!weather`) | [openweathermap.org/api](https://openweathermap.org/api) |

Paste the key, press Save. It applies to the next message — no restart.

---

## Keeping it running

Closing the terminal stops the bot. Pick one:

**Docker** — already handled; the container restarts by itself.

**A Linux server** — the installer sets up a service that starts on boot:

```bash
curl -fsSL https://levix.leviro.net/install.sh | bash
```

Read the script first if you like — it is short, and it explains each step.

That always installs the newest stable Levix. To stay on one version — the same
script, pinned — use its own URL:

```bash
curl -fsSL https://levix.leviro.net/install/v2.0.0.sh | bash
```

**Your own machine** — `pm2` works well:

```bash
npm install -g pm2
pm2 start levix --name levix
pm2 save && pm2 startup
```

---

## Where your data is

One directory holds all of it: the database, the WhatsApp session, the bot's
long-term memory, the logs.

```bash
levix where
```

- installed with npm: `~/.levix`
- running from a git clone: `./data` inside the clone
- Docker: the `levix-data` volume

**Backing up** means copying that directory. **Moving to another machine**
means copying it across and starting Levix there — including the WhatsApp
session, so you don't even rescan the QR.

---

## When something goes wrong

**"Port 3001 is already taken"** — Levix is already running, or something else
holds that port. Open <http://localhost:3001> and see. To move it: Settings →
Server → Control panel port, then restart.

**Forgot the panel password**

```bash
levix reset-password
```

Then start it again and pick a new one. The WhatsApp link is untouched.

**The bot stopped answering** — WhatsApp dropped the link, usually because the
phone was offline for a long time. Open the panel; if it asks for a QR, scan it
again.

**"Levix needs Node 24 or newer"** — your Node is older. Install the LTS build
from [nodejs.org](https://nodejs.org) and try again.

**Start over completely** — stop the bot, delete the data directory
(`levix where` prints it), start it again. That wipes everything: settings,
memory, the WhatsApp link.

---

## Two things worth knowing

**Whoever scans the QR owns the bot.** That account is the owner and can run
every command. You can add more owners and admins from **Roles** in the panel.

**The panel has no HTTPS of its own.** On your own machine that's fine. On a
server reachable from the internet, run `sudo levix domain bot.example.com` —
it puts a reverse proxy with a certificate in front, sets the proxy-hop count
for you, and stops the panel listening publicly on its raw port.
