# Free, always-on hosting for Iron Arena

Goal: players, accounts and rooms keep working 24/7 with **no commands to run** after setup — the server starts on boot, restarts itself if it crashes, and redeploys when you `git push`.

> **Not yet tested on a real VM.** The scripts were syntax-checked and the server was smoke-tested in production mode locally (origin lock, dev-unlock off, `kill -9` crash → data intact), but nothing here has run on an actual cloud machine. Expect to fix a small thing or two on first setup. Free-tier terms change — verify them before relying on them.

## Architecture (all free tiers)

| Piece | What | Where |
|---|---|---|
| Client | static site (`npm run build` → `dist/`) | **Cloudflare Pages** — auto-builds from your GitHub repo |
| Game server + rooms + accounts | `node server/index.js`, SQLite file on its own disk | **One always-free VM** (recommended: Oracle Cloud Always Free) |
| Keeps it running | systemd (`Restart=always`, starts on boot) | included |
| HTTPS / `wss://` | Caddy + free Let's Encrypt cert | included |
| Backups | nightly SQLite copy (+ optional off-machine copy via rclone) | included |

Rooms need nothing extra: one server process already runs many isolated matches at once and opens a new lobby whenever the existing ones are full or in progress.

## How much can one free VM carry? (measured)
Benchmarked on a dev laptop (ARM server cores are slower — treat as optimistic). One 30-player match costs ~0.1–0.4 ms of CPU per 33 ms tick, so **CPU is not the limit; outbound bandwidth is**:

| Match | Outbound traffic |
|---|---|
| 1 human + 29 bots | ~170 KB/s (≈1.4 Mbit/s) |
| 30 humans | ~2.4 MB/s (≈19 Mbit/s) |

(Already reduced ~55–70% by sending static player data once and loot only on change.) Rule of thumb: **each active player costs ≈ 80–170 KB/s while in a match.**
- Oracle Always Free advertises ~10 TB/month outbound → on the order of **tens of continuously-active players**, far more with normal "a few hours a day" usage.
- Google Cloud's free e2-micro only includes ~1 GB/month outbound → **not enough** (a single match uses that in about 2 hours).
- Further savings available later if you outgrow this: send snapshots at 20 Hz, only send entities near each player, compress.

## One-time setup

### 1. Create the VM (Oracle Cloud Always Free)
1. Sign up at oracle.com/cloud/free (card required for identity verification; you shouldn't be charged on Always Free resources — check the current terms). Pick your **home region carefully; it can't be changed later.**
2. Create an Ubuntu 22.04/24.04 instance on an Always Free shape (Ampere A1 ARM, or the AMD micro). Upload your SSH public key.
3. In the instance's network **security list**, add ingress rules for TCP **80** and **443** (the setup script configures the on-machine firewall; Oracle's cloud firewall is separate).
4. Oracle may reclaim Always Free VMs that stay almost idle for a long time; upgrading the account to "Pay As You Go" (still $0 within the free limits) is commonly recommended to avoid that — check Oracle's current policy.

### 2. Get a hostname that points at the VM
Easiest, no signup: use **`<ip-with-dashes>.sslip.io`**, e.g. VM IP `203.0.113.7` → `203-0-113-7.sslip.io`. (Or a free DuckDNS name, or your own domain.)

### 3. Put the code on GitHub
Push this repo to GitHub (public repo is simplest for the server to clone).

### 4. Run the setup script (once)
SSH into the VM, then:
```bash
curl -fsSL https://raw.githubusercontent.com/YOU/iron-arena/main/deploy/setup-server.sh -o setup-server.sh
sudo DOMAIN=203-0-113-7.sslip.io \
     REPO_URL=https://github.com/YOU/iron-arena.git \
     CLIENT_ORIGIN=https://YOUR-SITE.pages.dev \
     bash setup-server.sh
```
It installs Node 22 + Caddy, creates the service user, clones the repo, writes `/etc/iron-arena.env`, installs and starts the systemd service, sets up HTTPS and the firewall, and schedules the nightly backup. When it finishes, `https://<DOMAIN>/healthz` should answer `{"ok":true,"db":"ok",...}`.

### 5. Deploy the client (Cloudflare Pages)
Create a Pages project from your GitHub repo: build command `npm run build`, output directory `dist`, environment variable **`VITE_SERVER_URL=wss://<DOMAIN>`**. Every push redeploys the site. Use the resulting `https://….pages.dev` address as `CLIENT_ORIGIN` above (if you set it wrong, edit `ALLOWED_ORIGINS` in `/etc/iron-arena.env` and `sudo systemctl restart iron-arena`).

### 6. (Optional) Auto-deploy the server on `git push`
1. On the VM: `sudo -u ironarena ssh-keygen -t ed25519 -N '' -f /home/ironarena/.ssh/id_deploy && sudo -u ironarena sh -c 'cat /home/ironarena/.ssh/id_deploy.pub >> /home/ironarena/.ssh/authorized_keys'`
2. In GitHub → Settings → Secrets → Actions add `DEPLOY_HOST` (VM IP/hostname), `DEPLOY_USER` (`ironarena`), `DEPLOY_SSH_KEY` (contents of `/home/ironarena/.ssh/id_deploy`).
3. After that, pushing to `main` runs `.github/workflows/deploy.yml`: pull → install → restart → health check.

## Day to day
- **Nothing to run.** The service starts on boot and restarts within ~2 s of a crash.
- Logs: `journalctl -u iron-arena -f` · status: `systemctl status iron-arena` · restart: `sudo systemctl restart iron-arena`
- Manual update: `sudo -u ironarena /opt/iron-arena/deploy/update.sh`
- Config lives in `/etc/iron-arena.env` (see `.env.example`).

## Backups & restore
- Accounts live in `/var/lib/iron-arena/iron-arena.db` (SQLite). A nightly job writes a compressed copy to `/var/backups/iron-arena/` (keeps 14).
- Off-machine copy (recommended — a single VM can fail): install and configure `rclone` for a free storage remote, then set `RCLONE_REMOTE=remote:folder` in `/etc/iron-arena.env`.
- Restore: `sudo systemctl stop iron-arena && gunzip -c /var/backups/iron-arena/<file>.db.gz > /var/lib/iron-arena/iron-arena.db && sudo chown ironarena: /var/lib/iron-arena/iron-arena.db && sudo systemctl start iron-arena`

## Limits to know about
- **Single machine, single process.** If the VM is down, the game is down; live matches end if the server restarts (accounts and progress persist). No multi-server scaling built.
- A hard crash can lose at most the last fraction of a second of account writes (they're flushed right away; a clean stop flushes everything).
- Passwords can't be reset (no email flow yet).

## Alternative: hosted Postgres instead of the VM's SQLite
Only needed if you later run more than one game server. Set `IRON_DB=postgres` and `DATABASE_URL=postgres://…?sslmode=require` (Neon / Supabase free tiers); tables are created automatically, and the server reports "unavailable" (never crashes) if the database is unreachable. Verify it first with `IRON_TEST_DATABASE_URL=… node server/accounts/test-store-contract.mjs` against a throwaway database.

## Other free-ish options (weaker)
- **Render / Koyeb free web service:** no VM or card, but free instances may sleep when idle (cold starts, dropped matches) and limits change — only for casual testing.
- **Your own always-on PC / Raspberry Pi** + a Cloudflare Tunnel: free, works while that machine is on.
