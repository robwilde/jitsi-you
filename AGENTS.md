# Repository Guidelines

## Project Overview

Self-hosted [Jitsi Meet](https://jitsi.org) for a 3-person team ("Konvoy Team Video"). Local Ubuntu/Debian server
first — Docker Compose, behind NAT, static public IP, Let's Encrypt — with AWS migration deferred until real bandwidth
is measured (`README.md:3`, `jitsi-v1-setup-guide.md:3`).

**This repo contains no application source code.** It is a configuration + runbook repo: three artifacts that are copied
*into* an unpacked upstream [`jitsi/docker-jitsi-meet`](https://github.com/jitsi/docker-jitsi-meet) release living
outside this tree. There is no `package.json`, `Makefile`, or `Dockerfile` here, and no `docker-compose.yml` — the
compose files ship in the upstream release archive and are deliberately not vendored (`jitsi-v1-setup-guide.md:131`), so
reach for env vars and `custom-config.js` before introducing local build machinery.

Source of
truth: [Jitsi Handbook — Docker self-hosting](https://jitsi.github.io/handbook/docs/devops-guide/devops-guide-docker),
checked 5 Sep 2026 (`jitsi-v1-setup-guide.md:4`).

## Architecture & Data Flow

Four upstream containers, all configured indirectly through env vars (`jitsi-v1-setup-guide.md:165`, `:235`):

| Service   | Role                                                                       | Configured by                                                                                                  |
|-----------|----------------------------------------------------------------------------|----------------------------------------------------------------------------------------------------------------|
| `web`     | nginx + Jitsi Meet JS frontend, ACME issuance + the `acme-renewal` service | `HTTP_PORT`, `HTTPS_PORT`, `PUBLIC_URL`, `LETSENCRYPT_*`, `ENABLE_*_PAGE`, `RESOLUTION*`, `ENABLE_P2P`         |
| `prosody` | XMPP signalling + internal user accounts                                   | `AUTH_TYPE`, `ENABLE_AUTH`, `ENABLE_GUESTS`, `*_PASSWORD`                                                      |
| `jicofo`  | conference focus / allocation                                              | `JICOFO_AUTH_PASSWORD`, `JICOFO_AUTH_LIFETIME`, `JICOFO_MAX_MEMORY`                                            |
| `jvb`     | videobridge SFU (media)                                                    | `JVB_AUTH_PASSWORD`, `JVB_ADVERTISE_IPS`, `JVB_DISABLE_STUN`, `COLIBRI_REST_ENABLED`, `VIDEOBRIDGE_MAX_MEMORY` |

```mermaid
graph LR
    B1[Browser 1] -- " 443/TCP signalling<br/>XMPP-over-WebSocket " --> W[web + prosody + jicofo]
    B2[Browser 2] -- " 443/TCP " --> W
    B1 <-. " P2P media<br/>2 participants only " .-> B2
    B1 -- " 10000/UDP RTP " --> J[jvb SFU]
    B2 -- " 10000/UDP RTP " --> J
    B3[Browser 3] -- " 10000/UDP RTP " --> J
```

Two facts drive most debugging:

- **2-participant calls are peer-to-peer and never touch the server** (`ENABLE_P2P=1`, `jitsi.env:39`; the image
  defaults it to `true` anyway). A call that works with 2 users but breaks with 3 is a JVB problem — UDP 10000
  forwarding or `JVB_ADVERTISE_IPS` (`jitsi-v1-setup-guide.md:211`, `:259`). If it breaks for only *one* participant it
  is that user's network blocking UDP: there is no TURN server, so no TCP fallback (`:89-93`, `:260`).
- **Split-horizon NAT:** `JVB_ADVERTISE_IPS` lists LAN IP *then* public IP, comma-separated (`jitsi.env:26`). Only one
  IP present ⇒ media works on LAN xor remote, never both (`jitsi-v1-setup-guide.md:261`). It is **media-only** — the
  LAN's path to the *web UI* is a separate concern needing router hairpinning or split DNS (`:94-120`, `:262`).

Config flows one way, and the two config layers have **different reload semantics** — this is the single most important
operational distinction:

- `jitsi.env` → copied to `.env` in the release dir → consumed by compose → requires **
  `docker compose down && docker compose up -d`**. `restart` reuses old containers and silently ignores `.env` edits
  (`jitsi-v1-setup-guide.md:237`, `:264`).
- `custom-config.js` → copied to `~/.jitsi-meet-cfg/web/` → **appended** to the container-generated `config.js` on every
  `web` start → requires only **`docker compose restart web`** (`custom-config.js:2-4`, `jitsi-v1-setup-guide.md:236`).

## Key Directories

The repo is flat — five tracked files, no subdirectories. All persistent state lives **outside** the repo:

- `~/.jitsi-meet-cfg/{web,prosody/config,prosody/prosody-plugins-custom,jicofo,jvb,jigasi,jibri,transcriber}` —
  bind-mounted config; root set by `CONFIG` (`jitsi.env:18`). Holds `custom-config.js`; **preserve it across upgrades**
  (`jitsi-v1-setup-guide.md:240`).
- `~/.jitsi-meet-cfg/storage/{jibri,prosody,transcripts,web}` and `~/.jitsi-meet-cfg/tmp/{web-crontabs,web-load-test}` —
  must exist and be `chmod 777` *before first start*; containers run as uid 1000 with a read-only rootfs
  (`jitsi-v1-setup-guide.md:144-154`). Missing/unwritable ⇒ "not writable" boot failure (`:256`). `storage/web` holds
  acme.sh plus the issued certs and `storage/prosody` holds the user accounts — those two are the ones that must survive
  a migration (`:178-184`, `:247`). `tmp/` is regenerable; `tmp/web-crontabs` is vestigial at `stable-11146-2` (no
  compose mount) but kept so the commands still match the handbook.
- `~/jitsi-docker-jitsi-meet-*/` — the unpacked upstream release; where `.env`, `gen-passwords.sh`, and the compose
  files actually live. Git-ignored (`.gitignore:13`).

## Development Commands

There is no build, no compile step, and no package manager. "Development" is deployment. All commands are **Docker
Compose v2** (`docker compose`, space — never `docker-compose`) and run from the unpacked release dir, not the repo
(`jitsi-v1-setup-guide.md:122`).

Install (`jitsi-v1-setup-guide.md:131-162`):

```bash
cd ~
# 4.1 Get the latest release — the handbook says DO NOT git clone
wget $(wget -q -O - https://api.github.com/repos/jitsi/docker-jitsi-meet/releases/latest | grep zip | cut -d\" -f4)
unzip stable-*                       # zipball saves as "stable-NNNNN", no .zip
cd jitsi-docker-jitsi-meet-*
cp /path/to/jitsi.env .env && nano .env   # hostname, LE email, LAN IP, public IP, TZ
./gen-passwords.sh                   # fills the empty Security section; backs up to .env.bak
mkdir -p ~/.jitsi-meet-cfg/{web,prosody/config,prosody/prosody-plugins-custom,jicofo,jvb,jigasi,jibri,transcriber}
mkdir -p ~/.jitsi-meet-cfg/storage/{jibri,prosody,transcripts,web}
mkdir -p ~/.jitsi-meet-cfg/tmp/{web-crontabs,web-load-test}
chmod 777 ~/.jitsi-meet-cfg/storage/{jibri,prosody,transcripts,web}
chmod 777 ~/.jitsi-meet-cfg/tmp/{web-crontabs,web-load-test}
cp /path/to/custom-config.js ~/.jitsi-meet-cfg/web/custom-config.js   # non-env keys only
docker compose up -d
docker compose logs -f web           # watch ACME/cert lines
```

Day-to-day (`jitsi-v1-setup-guide.md:218-227`):

```bash
docker compose ps                             # health: web, prosody, jicofo, jvb all Up
docker compose logs -t -f jvb                 # web | prosody | jicofo | jvb
docker compose restart web                    # after editing custom-config.js (channelLastN etc.)
docker compose down && docker compose up -d   # after editing .env — restart is NOT enough
docker compose pull && docker compose up -d   # upgrade, after re-running the §4.1 wget
docker compose down -v                        # uninstall / start over
```

Certificate staging → production, once ACME is proven working (`jitsi-v1-setup-guide.md:173-177`):

```bash
sed -i 's/^LETSENCRYPT_USE_STAGING=1/LETSENCRYPT_USE_STAGING=0/' .env
rm -rf ~/.jitsi-meet-cfg/storage/web/*   # acme.sh + issued certs live here; staging certs are not cleared automatically
docker compose down && docker compose up -d
```

User accounts — internal XMPP domain is `meet.jitsi`, **not** the public hostname (`jitsi-v1-setup-guide.md:188-197`):

```bash
docker compose exec prosody /bin/bash
prosodyctl --config /run/prosody/config/prosody.cfg.lua register rob meet.jitsi 'StrongPass1'
prosodyctl --config /run/prosody/config/prosody.cfg.lua unregister <name> meet.jitsi
find /var/lib/prosody/data/meet%2ejitsi/accounts -type f -exec basename {} .dat \;
```

Prerequisites: DNS `A` record `→` public IP (`dig +short meet.example.com`); router forwards **80/TCP, 443/TCP,
10000/UDP** to the LAN IP and **never 22**;
`sudo ufw allow 80/tcp && sudo ufw allow 443/tcp && sudo ufw allow 10000/udp` (`jitsi-v1-setup-guide.md:78-126`). Also
decide up front how LAN clients resolve the hostname — hairpin NAT or split DNS (`:94-120`).

## Code Conventions & Common Patterns

**Override, never fork.** Nothing upstream is vendored or patched. Behaviour is changed only by (a) an env var in
`jitsi.env`, or (b) a `config.js` key in `custom-config.js`. Pick the right layer and never duplicate a setting across
both — anything upstream exposes as an env var (`ENABLE_PREJOIN_PAGE`, `ENABLE_LOBBY`, `ENABLE_RECORDING`,
`START_WITH_*` at `jitsi.env:79-86`; `RESOLUTION*`/`ENABLE_P2P` at `jitsi.env:39-43`) belongs in `jitsi.env`; only keys
with no env equivalent go in `custom-config.js`. Duplicating is worse than untidy: the image's generated `config.js`
already emits `config.resolution`, `config.constraints` and `config.p2p.enabled` from those vars, so a fragment
restating them is a no-op that hides where the real value comes from.

`custom-config.js` idiom — it is a **fragment appended into an existing scope**, not a module. `config` already exists;
there is no wrapper, declaration, export, or IIFE:

```js
config.channelLastN = 3;         // 3 most recent speakers — sized to the 3-person team
```

Because the fragment is concatenated into existing scope, it must not redeclare `config` or use module/bundler syntax
(`module.exports`, `import`, `window.config = …`) — those would break or shadow the generated object. Locally-scoped
`const`/`let` for a computed value is fine. If a key needs a nested object that the generated `config.js` may not have
created, init it defensively (`config.x = config.x || {}`) before assigning. Currently overrides exactly three keys, all
without env equivalents: `channelLastN`, `disableThirdPartyRequests`, `enableInsecureRoomNameWarning`
(`custom-config.js:12-16`). No `interface_config` / `custom-interface_config.js` exists in this repo.

Comment style, both `.js` and `.env`: every non-obvious value carries a *why*, and comments cross-reference guide
sections (`custom-config.js:8` → "see guide §7"; `jitsi.env:45-48` explains why `COLIBRI_REST_ENABLED` has to be set at
all). Keep this — it is the repo's main affordance. When adding a tunable, state the rationale and the guide section
that verifies it.

**Secrets.** `jitsi.env` is a tracked **template with empty placeholders**; `gen-passwords.sh` fills them in the derived
`.env`, which is git-ignored along with `.env.bak`, `*.env.local`, `*.pem`, `*.key`, `*.crt` (`.gitignore:2-18`). Never
commit a populated `.env`, never paste generated passwords into `jitsi.env`, and keep the six placeholders empty:
`JICOFO_AUTH_PASSWORD`, `JVB_AUTH_PASSWORD`, `JIGASI_XMPP_PASSWORD`, `JIGASI_TRANSCRIBER_PASSWORD`,
`JIBRI_RECORDER_PASSWORD`, `JIBRI_XMPP_PASSWORD` (`jitsi.env:97-102`). Containers refuse to start if they are empty in
the real `.env` (`jitsi.env:95`).

Example placeholders are RFC-5737/example-domain values and must stay that way in tracked files: `meet.example.com`,
`you@example.com`, `192.168.1.50` (LAN), `203.0.113.10` (public) (`jitsi.env:8-12`).

## Important Files

| File                      | Purpose                                                                                                                                                                                                                                                                                                           |
|---------------------------|-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `jitsi-v1-setup-guide.md` | 274-line operational runbook and the authority for every command. §1 rationale, §2 sizing (+ §2.1 distro, §2.2 port matrix), §3 prerequisites, §4 install, §5 cert staging→production, §6 accounts, §7 test plan + bandwidth, §8 day-2 ops, §9 AWS notes, §10 troubleshooting table, then "Open items to confirm" |
| `jitsi.env`               | 112-line `.env` template → copied to the release dir as `.env`. Opens with `# shellcheck disable=SC2034`                                                                                                                                                                                                          |
| `custom-config.js`        | 16-line frontend override fragment; only the three keys with no env equivalent (`channelLastN`, `disableThirdPartyRequests`, `enableInsecureRoomNameWarning`)                                                                                                                                                     |
| `README.md`               | Index + quick start; points at the guide from §5 onward                                                                                                                                                                                                                                                           |
| `.gitignore`              | Env files, Jitsi runtime state, downloaded release archives, TLS material, IDE files (`.idea/*`, appended by JetBrains)                                                                                                                                                                                           |

Current tuning worth knowing: `TZ=Australia/Brisbane` (`jitsi.env:21`), `ENABLE_AUTH=1` / `ENABLE_GUESTS=0` /
`AUTH_TYPE=internal` / `ENABLE_AUTO_LOGIN=1` / `JICOFO_AUTH_LIFETIME=24 hours` (`jitsi.env:70-74`), 720p cap via
`RESOLUTION`/`RESOLUTION_WIDTH` with `ENABLE_P2P=1` (`jitsi.env:39-43`), `COLIBRI_REST_ENABLED=1` so §7's bandwidth
measurement actually returns data (`jitsi.env:49`), `JVB_DISABLE_STUN=1` since both advertise IPs are explicit
(`jitsi.env:31`), `JICOFO_MAX_MEMORY=512m`, `VIDEOBRIDGE_MAX_MEMORY=1024m` (`jitsi.env:91-92`),
`RESTART_POLICY=unless-stopped` (`jitsi.env:107`), `LETSENCRYPT_ACME_SERVER="letsencrypt"` because the image defaults to
ZeroSSL (`jitsi.env:57-58`).

## Runtime/Tooling Preferences

- **Docker Compose v2 required.** Verify with `docker compose version` → `v2.x`; the invoking user must be in the
  `docker` group (`jitsi-v1-setup-guide.md:122`). Never emit `docker-compose` (v1) syntax.
- **No Node, Bun, npm, or any JS runtime is currently involved.** `custom-config.js` is never executed, bundled, linted,
  or type-checked locally — it is read by the browser after the `web` container concatenates it. There is
  correspondingly no lockfile, formatter config, or CI workflow today.
- **Never `git clone` docker-jitsi-meet** — the handbook and guide require the release zipball
  (`jitsi-v1-setup-guide.md:131`). The stack tracks `releases/latest` and nothing is pinned by default;
  `JITSI_IMAGE_VERSION` is present but commented out (`jitsi.env:109-112`), and the guide records the release actually
  deployed (`stable-11146-2`) so an upgrade can be diffed (`jitsi-v1-setup-guide.md:240`).
- **Verify upstream claims against the deployed tag, not `master`.** `master`'s compose emits `unstable` images and has
  drifted from the release — e.g. cert renewal moved from cron to the `acme-renewal` service in `stable-11146-2` (PR
  #2305), so `tmp/web-crontabs` no longer has a compose mount.
- Host: Debian 12/13 or Ubuntu 22.04/24.04 LTS x86_64, 4 GB RAM target (2 GB floor), 4 *dedicated* cores (Prosody is
  single-threaded), 20 GB disk; Docker from Docker's apt repo, never the distro package
  (`jitsi-v1-setup-guide.md:33-74`). Upload bandwidth is the real constraint: ≈0.2 Mbit/s at 180p, 0.5 at 360p, 2.5 at
  720p. Exactly three ports leave the host — 80/tcp, 443/tcp, 10000/udp (`:62-74`).
- Firewall steps use **ufw**; the guide contains no firewalld equivalents, so translate if the host differs
  (`jitsi-v1-setup-guide.md:125`).
- Out of scope for v1: Jibri, Jigasi, Etherpad (`jitsi-v1-setup-guide.md:27`).
- Git: `main`, `origin` = `git@github.com-robwilde:robwilde/jitsi-you.git` — sentence-case prose subjects, not
  Conventional Commits. The `github.com-robwilde` host alias is deliberate: `~/.ssh/config` maps bare `github.com` to a
  different work account (`rob-ee-wilde`) with `IdentitiesOnly yes`, so a plain `git@github.com:` URL authenticates as
  the wrong user and GitHub rejects the push with `Permission to robwilde/jitsi-you.git denied`. Do not "simplify" the
  URL back. Note `gh` cannot parse alias URLs — pass `--repo robwilde/jitsi-you` explicitly.

## Testing & QA

**There is no automated test suite, linter, or CI** — nothing to run, and none should be invented. Verification is the
manual §7 test plan, ordered so each step isolates one failure mode (`jitsi-v1-setup-guide.md:207-213`):

1. **One browser**, join a room, allow cam/mic → login prompt then self-view. Failure ⇒ cert/HTTPS (§5); a
   `getUserMedia` error means you used plain HTTP.
2. **Two users, one remote** → audio+video both ways. This path is P2P, so passing it says nothing about JVB; failure ⇒
   443 forwarding, DNS, or (from the LAN) no hairpin.
3. **Third user** (one LAN, two remote) → all three within ~5 s. First test that actually uses JVB. Fails for everyone ⇒
   UDP 10000 forwarding or `JVB_ADVERTISE_IPS` (check `docker compose logs jvb | grep -i harvest`); fails for one person
   only ⇒ that user's network blocks UDP.
4. **Screen share** from each user → readable quality; else bandwidth-bound.
5. **`docker compose restart`** → clients reconnect automatically.

Health and measurement:

```bash
docker compose ps    # web, prosody, jicofo, jvb all Up
docker stats
curl -s http://localhost:8080/colibri/stats | jq '{conferences, participants, bit_rate_download, bit_rate_upload, total_packets_lost}'   # needs COLIBRI_REST_ENABLED=1
ip -br link && sudo apt install -y nload && nload eth0
```

Colibri stats are bound to localhost only, and require `COLIBRI_REST_ENABLED=1` — the image defaults it to `false` and
the endpoint otherwise just 404s (`jitsi-v1-setup-guide.md:222-224`). Peak `bit_rate_upload` plus `nload` outgoing must
sit under ISP upload with margin; cross-check with `speedtest-cli` or `iperf3 -c <remote>`. If saturated, set
`RESOLUTION=360` and `RESOLUTION_WIDTH=640` in `.env` and do a full `down && up` (`jitsi-v1-setup-guide.md:227`,
`:265`). In-call, the connection indicator on your own tile reports bitrate, resolution, and packet loss (`:229`).

A staging-CA browser warning is a **pass**, not a failure — it proves ACME worked end-to-end before you spend production
rate limit (5 duplicate certs per domain per 7 days) (`jitsi-v1-setup-guide.md:171-173`). Note that iOS/Android apps
reject staging certs, so mobile can only be tested after §5 (`:263`).

Consult the §10 troubleshooting table (`jitsi-v1-setup-guide.md:254-266`) before diagnosing from scratch; it maps eleven
known symptoms to causes and fixes, and deliberately splits the pairs that share a symptom — 3rd-user failure for
everyone vs. one person, and LAN media vs. the LAN web UI.
