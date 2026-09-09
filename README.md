# jitsi-you

Self-hosted [Jitsi Meet](https://jitsi.org) for a 3-person team. Local server first (Docker Compose, behind NAT, Let's Encrypt), AWS later once bandwidth is measured.

| File | Purpose |
|---|---|
| [`jitsi-v1-setup-guide.md`](jitsi-v1-setup-guide.md) | Step-by-step install, cert cut-over, user accounts, test plan, bandwidth measurement, AWS notes |
| [`jitsi.env`](jitsi.env) | Template `.env` for the `docker-jitsi-meet` release — placeholders only, no secrets |
| [`custom-config.js`](custom-config.js) | Web overrides with no `.env` equivalent: `channelLastN=3`, no third-party requests, no insecure-room-name warning. Resolution and P2P live in `jitsi.env` |

## Quick start

```bash
wget $(wget -q -O - https://api.github.com/repos/jitsi/docker-jitsi-meet/releases/latest | grep zip | cut -d\" -f4)
unzip stable-* && cd jitsi-docker-jitsi-meet-*
cp ../jitsi.env .env && nano .env      # fill hostname, email, LAN IP, public IP
./gen-passwords.sh
# create config dirs — see guide §4.4
# check LAN clients can reach the hostname — see guide §3.3
cp ../custom-config.js ~/.jitsi-meet-cfg/web/
docker compose up -d
```

Then follow the guide from §5 (staging → production cert) onward.

**Never commit the real `.env`** — it holds generated service passwords. `.gitignore` covers it.

Docs: [Jitsi Handbook — Docker self-hosting](https://jitsi.github.io/handbook/docs/devops-guide/devops-guide-docker)
