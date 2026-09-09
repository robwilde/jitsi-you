# Konvoy Team Video — Jitsi Meet v1 Setup Guide

**Target:** 3 users, self-hosted on a local Ubuntu/Debian x86_64 server behind NAT (static public IP), Docker Compose, Let's Encrypt, login required, some users on the same LAN as the server.
**Source:** [Jitsi Meet Handbook](https://jitsi.github.io/handbook/docs/devops-guide/devops-guide-docker) (Docker self-hosting guide, requirements, FAQ), checked 5 Sep 2026.

Files that accompany this guide: `jitsi.env` (becomes `.env`), `custom-config.js`.

> **Public repo warning:** `jitsi.env` holds placeholders only. After `gen-passwords.sh` the real `.env` contains service secrets — it is git-ignored; never commit it or `.env.bak`.

Placeholders used throughout — replace all of them:

| Placeholder | Meaning |
|---|---|
| `meet.example.com` | Your hostname |
| `you@example.com` | Email for Let's Encrypt |
| `192.168.1.50` | Server LAN IP |
| `203.0.113.10` | Your static public IP |

---

## 1. Why these choices

- **Docker Compose, not apt.** Config lives in one `.env`; teardown is `docker compose down -v`; the same stack moves to AWS (EC2 or EKS) unchanged. The apt route scatters state across nginx/prosody/jicofo/jvb host configs.
- **Internal auth, no guests.** Default Jitsi is open — anyone hitting the URL creates rooms. `ENABLE_AUTH=1 / AUTH_TYPE=internal / ENABLE_GUESTS=0` means only your 3 Prosody accounts get in. The handbook's "secure domain" page is marked deprecated; the Docker `.env` route is the supported equivalent.
- **Let's Encrypt from day one.** Self-signed certs break the mobile apps and put warnings in browsers. The image defaults to ZeroSSL as ACME server; the `.env` forces Let's Encrypt.
- **Split-horizon `JVB_ADVERTISE_IPS`.** Media (UDP 10000) bypasses any HTTP proxy. The bridge must advertise both the LAN IP (for those of you in the office) and the public IP (for remote). Getting this wrong is the #1 cause of "works with 2, breaks with 3" — with 2 participants the call is peer-to-peer and never touches the server.
- **No Jibri/Jigasi/Etherpad in v1.** Jibri (recording) alone wants 8 GB RAM and a dedicated box. Add later.

## 2. Server requirements (from the handbook)

| | Minimum | Comfortable |
|---|---|---|
| RAM | 2 GB | 4 GB |
| CPU | 2 cores | 4 dedicated cores (Prosody is single-threaded anyway) |
| Disk | 20 GB | — |
| Network | **Upload** is the constraint — see §7 | |

Bitrate reference per stream: 180p ≈ 0.2 Mbit/s, 360p ≈ 0.5, 720p ≈ 2.5, 4K ≈ 10. Three people at 720p through the bridge ≈ 7.5 Mbit/s in / ~15 Mbit/s out worst case; simulcast usually halves that.

The handbook's headline figure is "usually 8 GB", but that is sized for general
deployments; it explicitly allows 4 GB for small meetings and 2 GB for test/very small
ones. Three users is the small case, so **4 GB is the target and 2 GB is the floor** —
`JICOFO_MAX_MEMORY=512m` + `VIDEOBRIDGE_MAX_MEMORY=1024m` in the `.env` are sized for it.
Cores matter less than dedication: Prosody uses exactly one, so 4 *dedicated* cores beat
8 shared/stolen vCPUs on a VPS. Disk is 20 GB of anything; SSD is nice-to-have, not
required. Skip swap-thrash risk by not co-hosting anything else on the box.

### 2.1 Distro

Any current **Debian 12/13** or **Ubuntu 22.04/24.04 LTS** x86_64. The host distro barely
matters — all four services run in containers built on Debian stable with S6 — so pick
whichever you patch reliably. Two rules that do matter:

- **Install Docker from Docker's own apt repo**, not the distro package. The handbook flags
  the Debian-repo Docker (20.10.5) for not listening on IPv6 ports; you also need Compose
  v2, which older distro packages don't ship.
- **Nothing else on the box.** No other web server, no other Docker stack on 80/443.
  Jitsi is a real-time system and the handbook is blunt about co-tenancy harming it.

### 2.2 Ports

What the release actually publishes (verified against `stable-11146-2`'s `docker-compose.yml`):

| Service | Published | Scope | Purpose |
|---|---|---|---|
| `web` | `80 → 8000/tcp` | public | ACME HTTP-01 challenge + redirect to HTTPS |
| `web` | `443 → 8443/tcp` | public | Web UI, XMPP-over-WebSocket, Colibri WebSocket |
| `jvb` | `10000/udp` | public | RTP media to/from the bridge |
| `jvb` | `127.0.0.1:8080` | localhost | Colibri REST stats (§7) — never expose |
| `jicofo` | `127.0.0.1:8888` | localhost | Jicofo REST — never expose |
| `prosody` | *none* | internal | XMPP is reached through `web` on 443, not directly |

So exactly **three** ports leave the host: 80/tcp, 443/tcp, 10000/udp. Forward and firewall
only those (§3.2, §3.6). Jigasi's `20000-20050/udp` is not needed — it is out of scope for v1.

## 3. Prerequisites (do before touching the server)

1. **DNS:** `A` record `meet.example.com → 203.0.113.10`, TTL 1800. Confirm: `dig +short meet.example.com`.
2. **Router port-forwards → 192.168.1.50:**

   | Port | Proto | Purpose |
   |---|---|---|
   | 80 | TCP | Let's Encrypt HTTP-01 challenge + redirect to HTTPS |
   | 443 | TCP | Web UI, XMPP-over-WebSocket, Colibri WebSocket |
   | 10000 | UDP | Media (RTP) to the videobridge |

   Do **not** forward 22.

   Media is **UDP 10000 only** — `docker-jitsi-meet` bundles no TURN server, so there is
   no TCP/TLS fallback. A remote user whose network blocks outbound UDP will fail §7
   test 3 while everyone else passes it. For 3 known users that is an accepted risk in
   v1; the fix, if it bites, is an external coturn on 443/tcp wired in via
   `TURN_HOST` / `TURN_PORT` / `TURN_TRANSPORT`.
3. **LAN clients must be able to reach `meet.example.com`.** A LAN machine resolves the
   public IP and then has to hairpin back in through the router on 443 — plenty of
   consumer routers don't do NAT loopback. Decide the plan now; the definitive test is
   after §4.6, run from a LAN machine:
   ```bash
   curl -sSkI --connect-timeout 5 --max-time 10 https://meet.example.com/
   ```
   Flags matter here. `-k` is deliberate and **connectivity-only**: while §5 is still on
   the staging CA, certificate validation *must* fail, and a plain `curl -sI` returns
   nothing at all (exit 60) — indistinguishable from a dead hairpin, which is the very
   thing you are testing. `-s` drops the progress meter, `-S` keeps errors visible, and
   there is no pipe, so the exit status survives. Verified readings:

   | Output | Exit | Meaning |
   |---|---|---|
   | `HTTP/1.1 200 OK` | 0 | Hairpin works — nothing to do |
   | `curl: (28) Connection timed out` | 28 | No NAT loopback → use split DNS |
   | `curl: (7) Failed to connect` | 7 | Port-forward or host firewall, not hairpin |
   | `curl: (60) SSL certificate problem` | 60 | You dropped `-k` while still on staging |

   Re-run without `-k` after §5 to confirm the production cert validates.

   No hairpin on the LAN while a remote client works → fix with split DNS:
   point `meet.example.com → 192.168.1.50` on whatever serves DNS to the LAN (router
   DNS override, Pi-hole/AdGuard, or `/etc/hosts` on the one or two LAN machines).
   `JVB_ADVERTISE_IPS` does **not** cover this — it is media-only and oblivious to the
   HTTPS/WebSocket path.
4. **Nothing else on the server is bound to 80/443/10000.** Check: `sudo ss -tulpn | grep -E ':(80|443|10000)\s'`. If something is (Traefik, Caddy, nginx), stop here — the guide needs the reverse-proxy variant instead (`DISABLE_HTTPS=1`, proxy `/xmpp-websocket` and `/colibri-ws`).
5. **Docker Compose v2:** `docker compose version` → `v2.x`. Ensure your user is in the `docker` group.
6. **Host firewall (if ufw is on):**
   ```bash
   sudo ufw allow 80/tcp && sudo ufw allow 443/tcp && sudo ufw allow 10000/udp
   ```

## 4. Install

```bash
# 4.1 Get the latest release (handbook: DO NOT git clone)
cd ~
wget $(wget -q -O - https://api.github.com/repos/jitsi/docker-jitsi-meet/releases/latest | grep zip | cut -d\" -f4)
unzip stable-*                     # GitHub zipball saves as "stable-NNNNN" (no .zip)
cd jitsi-docker-jitsi-meet-*

# 4.2 Drop in the prepared .env, then edit the placeholders
cp /path/to/jitsi.env .env
nano .env          # meet.example.com, you@example.com, 192.168.1.50, 203.0.113.10, TZ

# 4.3 Generate service passwords (fills the Security section; backup in .env.bak)
./gen-passwords.sh

# 4.4 Config dirs — containers run as uid 1000 with a read-only rootfs.
#     storage/ and tmp/ MUST exist and be writable BEFORE first start.
#     Copied verbatim from the handbook. `chmod 777` is its instruction; `chown -R
#     1000:1000 ... && chmod 755` is equivalent and tighter if you prefer.
#     tmp/web-crontabs is vestigial as of stable-11146-2 (no compose mount any more)
#     but harmless — keep it so the commands still match the handbook.
mkdir -p ~/.jitsi-meet-cfg/{web,prosody/config,prosody/prosody-plugins-custom,jicofo,jvb,jigasi,jibri,transcriber}
mkdir -p ~/.jitsi-meet-cfg/storage/{jibri,prosody,transcripts,web}
mkdir -p ~/.jitsi-meet-cfg/tmp/{web-crontabs,web-load-test}
chmod 777 ~/.jitsi-meet-cfg/storage/{jibri,prosody,transcripts,web}
chmod 777 ~/.jitsi-meet-cfg/tmp/{web-crontabs,web-load-test}

# 4.5 Frontend overrides with no .env equivalent (appended to the generated
#     config.js on every `web` start). Resolution/P2P live in .env — see §7.
cp /path/to/custom-config.js ~/.jitsi-meet-cfg/web/custom-config.js

# 4.6 Start
docker compose up -d
docker compose logs -f web      # watch for the ACME/cert lines; Ctrl-C when quiet
```

`docker compose ps` should show `web`, `prosody`, `jicofo`, `jvb` all `Up`.

## 5. Certificate: staging → production

`.env` ships with `LETSENCRYPT_USE_STAGING=1` so a misconfigured DNS/port-forward can't burn the rate limit (5 duplicate certs per domain per 7 days).

1. Browse to `https://meet.example.com`. Expect a cert warning from the *staging* CA — that means ACME worked end to end.
2. Switch to production:
   ```bash
   sed -i 's/^LETSENCRYPT_USE_STAGING=1/LETSENCRYPT_USE_STAGING=0/' .env
   rm -rf ~/.jitsi-meet-cfg/storage/web/*        # acme.sh + issued certs live here; staging certs are not cleared automatically
   docker compose down && docker compose up -d
   ```
3. Reload the page — valid padlock. Renewal is handled by the `web` container's
   long-running `acme-renewal` service, which runs `acme.sh --cron` every 12 h
   (state in `~/.jitsi-meet-cfg/storage/web/acme.sh`, so **that** is the directory to
   preserve). There is no host or container crontab: upstream replaced cron with this
   service in `stable-11146-2` (PR #2305, "replace cron with a rootless acme.sh renewal
   service") and the image installs acme.sh with `--nocron`. `~/.jitsi-meet-cfg/tmp/` is
   regenerable and safe to delete.

## 6. Create the three user accounts

```bash
docker compose exec prosody /bin/bash
# inside the container — no output on success
prosodyctl --config /run/prosody/config/prosody.cfg.lua register rob    meet.jitsi 'StrongPass1'
prosodyctl --config /run/prosody/config/prosody.cfg.lua register user2  meet.jitsi 'StrongPass2'
prosodyctl --config /run/prosody/config/prosody.cfg.lua register user3  meet.jitsi 'StrongPass3'
# verify
find /var/lib/prosody/data/meet%2ejitsi/accounts -type f -exec basename {} .dat \;
exit
```

`meet.jitsi` is the *internal* XMPP domain, not your public hostname — that's correct. Remove a user with `... unregister <name> meet.jitsi`.

Login persists via `ENABLE_AUTO_LOGIN=1` for `JICOFO_AUTH_LIFETIME` (24 h in the `.env`).

## 7. Test plan & bandwidth measurement (feeds the AWS sizing decision)

Run these in order; each isolates one failure mode.

| # | Test | Passes if | If it fails |
|---|---|---|---|
| 1 | One browser, join room, allow cam/mic | Prompted to log in, then see yourself | Cert/HTTPS problem → §5; getUserMedia error means you hit HTTP not HTTPS |
| 2 | Two users, one remote | Audio+video both ways | This is **P2P** — the server is only signalling, so passing this tells you *nothing* about JVB. Fail = 443 forward, DNS, or (from the LAN) no hairpin → §3.3 |
| 3 | **Third user joins** (one on LAN, two remote) | All three see/hear each other within ~5 s | First test that actually uses JVB. Fails for **everyone** = UDP 10000 forward or `JVB_ADVERTISE_IPS`; check `docker compose logs jvb \| grep -i harvest`. Fails for **one person only** = that user's network blocks UDP, and there is no TCP fallback → §3.2 |
| 4 | Screen share from each user | Others see it at readable quality | Bandwidth — see below |
| 5 | Kill and restart: `docker compose restart` | Users reconnect automatically | — |

**Measuring what you actually need** (run during test 3/4, ~10 min):

```bash
# server-side: total throughput on the host NIC (find its name with: ip -br link)
sudo apt install -y nload && nload eth0
# per-container
docker stats
# JVB's own view of bitrate/packet loss. Needs COLIBRI_REST_ENABLED=1 in .env —
# the image defaults it to false and the endpoint just 404s. Bound to localhost only.
curl -s http://localhost:8080/colibri/stats | jq '{conferences, participants, bit_rate_download, bit_rate_upload, total_packets_lost}'
```

Note the peak `bit_rate_upload` from JVB and `nload` outgoing. Your ISP upload must exceed that with margin; if not, set `RESOLUTION=360` and `RESOLUTION_WIDTH=640` in `.env` and run `docker compose down && docker compose up -d`. Also verify the link independently: `speedtest-cli` or `iperf3 -c <remote>` from the server.

Client-side sanity: in a call, press the connection indicator (top-left of your tile) → shows bitrate, resolution, packet loss.

## 8. Day-to-day operations

```bash
docker compose ps                         # health
docker compose logs -t -f jvb             # web | prosody | jicofo | jvb
docker compose restart web                # after editing custom-config.js (channelLastN etc.)
docker compose down && docker compose up -d   # after editing .env — including resolution/P2P
```

**Upgrade:** re-run the `wget` from §4.1, unzip over the top ("overwrite all"), `docker compose pull && docker compose up -d`. Keep `~/.jitsi-meet-cfg` — it holds your cert, user accounts and custom config. Note the release tag you land on (currently `stable-11146-2`); the compose contract does change between releases, so record it before upgrading and diff if something breaks.

**Uninstall / start over:** `docker compose down -v`. Only delete `~/.jitsi-meet-cfg` if you've first set `ENABLE_LETSENCRYPT=0` or you'll re-issue a cert against the rate limit.

## 9. Moving to AWS later — what to carry over

- Same compose files and `.env`. Change: `JVB_ADVERTISE_IPS=<private IP>,<Elastic IP>`, DNS A record → Elastic IP.
- **Copy `~/.jitsi-meet-cfg/storage/prosody/`** or you land on AWS with a working stack and no logins — that is where the three accounts from §6 live. (Re-running §6 on the new host is equally fine for 3 users; just don't skip both.)
- Security group: 80/tcp, 443/tcp, 10000/udp from `0.0.0.0/0`; 22 from your IP only.
- Sizing from §7: JVB egress ≈ your peak `bit_rate_upload`. A `t3.medium` (2 vCPU/4 GB) covers 3–6 users; egress is the cost line (~$0.09/GB out), so a 1 h 3-way call ≈ 2 GB (realistic, simulcast) to 7 GB (worst case, all 720p) ≈ $0.20–0.60. Measure in §7 rather than guess.
- Optional: Terraform the EC2 + SG + Route53 record; or, if you'd rather it live on EKS, the community `jitsi-contrib/jitsi-helm` chart takes the same env vars — but JVB needs `hostNetwork` or a NodePort on UDP 10000, which is the awkward part on Kubernetes.

## 10. Troubleshooting quick reference

| Symptom | Cause | Fix |
|---|---|---|
| Container won't start, "not writable" | `storage/` or `tmp/` missing/permissions | §4.4 |
| Container won't start, password error | Security section empty | `./gen-passwords.sh` |
| Cam/mic "unknown reason" | Accessed over plain HTTP | Use HTTPS URL |
| 2 users fine, 3rd breaks **for everyone** | UDP 10000 not forwarded, or `JVB_ADVERTISE_IPS` | §3.2, `.env` |
| 2 users fine, 3rd breaks **for one person only** | That user's network blocks outbound UDP; no TURN server means no TCP fallback | §3.2 — needs an external coturn on 443/tcp |
| Media works on LAN, not remote (or vice-versa) | Only one IP in `JVB_ADVERTISE_IPS` | Both IPs, comma-separated |
| **Page won't load at all** on the LAN, remote is fine | Router doesn't hairpin; LAN DNS hands out the public IP | §3.3 split DNS |
| Browser OK, iOS/Android app fails | Self-signed or staging cert / missing fullchain | §5 |
| No login prompt appears | `.env` change not applied | `docker compose down && docker compose up -d` (`restart` reuses old containers and ignores `.env` edits) |
| Choppy at 720p | Server upload saturated | `RESOLUTION=360` + `RESOLUTION_WIDTH=640` in `.env`, then `down && up` |
| §7 `colibri/stats` returns nothing | `COLIBRI_REST_ENABLED` unset (image default `false`) | `COLIBRI_REST_ENABLED=1` in `.env`, then `down && up` |

## Open items to confirm

- Actual hostname and which DNS provider holds it.
- `TZ` in `.env` is set to `Australia/Brisbane` — change if wrong.
- Whether anyone needs the iOS/Android app in v1 (works once §5 is on production certs; the app's server URL is just `https://meet.example.com`).
- Does any of the three users sit on a network that blocks outbound UDP? Decides whether v1 needs a TURN server (§3.2).
- Does the router do NAT loopback, or do we need split DNS on the LAN (§3.3)?
