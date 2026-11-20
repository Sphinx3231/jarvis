# Jarvis relay

The relay lets your phone reach your PC's Jarvis from **any network** without opening anything on
the PC to the internet. Both the PC and the phone connect *out* to the relay over a WebSocket; the
relay forwards their messages to each other.

**What the relay can and can't do**

- It **can't read** anything: every message is end-to-end encrypted (P-256 ECDH → HKDF-SHA256 →
  AES-256-GCM) between the PC and the phone. It sees device ids, message sizes and timing.
- It **can't impersonate** a device: each connection proves it holds its device key
  (ECDSA challenge-response; a device id is the SHA-256 of its public key).
- It **can't grant access**: only phones the PC has paired (the PC sends its own allow-list) can
  message that PC, and the PC still checks every command against the phone's permissions and its
  own approvals. A compromised relay can at worst drop or delay messages.
- It keeps **no history and no database**. Restarting it is harmless: PC and phones reconnect by
  themselves and stay paired.

## Run it

You need a machine with a public address (a small VPS is plenty) **and TLS** — the app refuses
unencrypted `ws://` except on a local network.

### Option A — Docker + Caddy (automatic HTTPS)

On a server with a DNS name (e.g. `relay.example.com`) pointing at it:

```sh
git clone <this repo> jarvis && cd jarvis
docker build -f relay/Dockerfile -t jarvis-relay .
docker run -d --name jarvis-relay --restart unless-stopped -p 127.0.0.1:8787:8787 -e TRUST_PROXY=1 jarvis-relay
```

`/etc/caddy/Caddyfile`:

```
relay.example.com {
    reverse_proxy 127.0.0.1:8787
}
```

`sudo systemctl reload caddy` — Caddy gets the certificate. Your relay URL is
**`wss://relay.example.com/v1`**. Check it: `curl https://relay.example.com/healthz`.

### Option B — plain Node (no Docker)

Node 22.18 or newer:

```sh
cd jarvis/relay && npm install --omit=dev && cd ..
PORT=8787 TRUST_PROXY=1 node relay/main.ts
```

Run it under systemd (or similar) so it restarts, and put Caddy/nginx with TLS in front as above.

### Option C — a platform with managed TLS

Any host that runs a Dockerfile and supports WebSockets (Fly.io, Render, Railway, …): deploy with
`relay/Dockerfile` from the repository root, expose port 8787, set `TRUST_PROXY=1`. The relay URL
is `wss://<your-app-host>/v1`.

## Connect Jarvis

1. On the PC: **Jarvis → Settings → Jarvis Mobile**, paste the relay URL, turn on
   **Connect to the relay**. The badge turns *connected*.
2. Press **Pair a phone** and scan the QR code with the Jarvis Android app (Devices → Scan QR code).

The phone stays paired — through restarts of the PC, Jarvis, the relay or the phone — until you
press **Unpair** in the app or on the PC.

## Settings

| Variable      | Default   | Meaning |
|---------------|-----------|---------|
| `PORT`        | `8787`    | Listening port (WebSocket path `/v1`, health check `/healthz`). |
| `HOST`        | `0.0.0.0` | Listening address. Use `127.0.0.1` when a local reverse proxy fronts it. |
| `TRUST_PROXY` | off       | `1` = take the client address from `X-Forwarded-For` (only behind your own proxy). |

Built-in limits: 256 KB per message, per-connection rate limiting, 10 failed authentications per
address per 5 minutes, pairing codes valid once for 5 minutes.
