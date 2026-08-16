# PVE Atlas

PVE Atlas is a read-only Proxmox VE topology and health dashboard. It merges a declared topology with live PVE API observations, can collect curated Docker metadata over restricted SSH, persists alert transitions, and can publish notifications to ntfy.

## Quick start

Requirements: Docker Engine with Compose, a dedicated PVE API token with the built-in `PVEAuditor` role at `/`, and an administrator credential hash.

1. Copy `.env.example` to `.env` and fill in the PVE API and Atlas administrator values.
2. Edit `config/declared-topology.json` for your nodes, guests, storage, networks, projects, endpoints, and relations.
3. If Docker collection is enabled, place a restricted collector key and pinned `known_hosts` file under `secrets/`.
4. Run `docker compose up -d --build`.
5. Verify `curl http://127.0.0.1:8080/healthz`, then open port 8080 through a TLS-terminating reverse proxy.

Generate an administrator hash on a trusted machine:

```bash
python3 - <<'PY'
import getpass, hashlib, secrets
password = getpass.getpass("New PVE Atlas administrator credential: ")
if len(password) < 16:
    raise SystemExit("Use at least 16 characters")
salt = secrets.token_hex(16)
digest = hashlib.scrypt(password.encode(), salt=salt.encode(), n=16384, r=8, p=1, dklen=32)
print(f"scrypt${salt}${digest.hex()}")
PY
```

## Topology declaration

Entity kinds are `node`, `storage`, `network`, `guest`, `project`, `container`, `volume`, `endpoint`, and `backup-job`. Entity IDs used for live matching must follow these forms:

- PVE node: `node:<node-name>`
- PVE guest: `guest:<vmid>`
- PVE storage: `storage:<storage-name>`

Docker collection discovers targets from declared guests whose metadata contains `vmid`, `address`, and `application`. It skips applications named `pve_atlas` and `tailscale`.

## Security notes

- Do not commit `.env`, collector private keys, host-specific topology, or SQLite data.
- Give the PVE token audit-only permissions; never reuse an automation token.
- Pin collector host keys and keep strict host-key checking enabled.
- The collector SSH account should be restricted to a forced command that returns only curated container metadata.
- Keep `PVE_TLS_INSECURE=false`; mount a private CA and set `PVE_CA_CERT` when the PVE endpoint uses an internal CA.
- Expose Atlas through HTTPS. Keep `ATLAS_SECURE_COOKIES=true` in production.

## Development

```bash
npm ci
npm test
npm run typecheck
npm run build
```
