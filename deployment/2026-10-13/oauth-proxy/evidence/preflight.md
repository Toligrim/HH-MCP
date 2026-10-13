# OAuth proxy deployment preflight — 2026-10-13

All checks below were read-only and completed before host configuration changes.

## Source and existing deployment

- Ops branch: `ops/preflight-2026-10-13`.
- Ops local and live GitHub HEAD: `d894e943c0044cf3c7ca1203da5e3d70f2085530`.
- Deployed `/opt/hh-mcp` Git SHA: `98f9930a1bbeeed44572986c7d72b197cacc93e2` (clean detached checkout).
- `hh-mcp.service`: active; `User=hh-mcp`; `WorkingDirectory=/opt/hh-mcp`.
- `cloudflared.service`: active.
- `sing-box-host.service`: active.
- `fable.service`: active.
- Listener: HH-MCP only `127.0.0.1:3001`; fable remains `*:3000`; no listener on 3002.
- `http://127.0.0.1:3001/health`: HTTP 200.
- Local MCP initialize: HTTP 200; `tools/list`: 24; `validate_token` absent.
- Local `search_vacancies`: success, 3 results; `get_vacancy`: success.
- External `https://hh-mcp.kurva-cloud.ru/health`: HTTP 200 with certificate verification success.
- External MCP initialize: HTTP 200; `tools/list`: 24; `validate_token` absent.
- External `search_vacancies`: success, 3 results; `get_vacancy`: success.

## Cloudflare before state

- Config: `/etc/cloudflared/config.yml`.
- SHA-256: `c095db34b0f0ca765b5498b230a277c361161169c1e9b278cef9413c6fe5f1cc`.
- Current `hh-mcp.kurva-cloud.ru` origin: `http://127.0.0.1:3001`.
- `cloudflared tunnel --config /etc/cloudflared/config.yml ingress validate`: PASS (`OK`).
- Sanitized current fragment: `../cloudflare/hh-mcp-ingress-before.yml`.

## HH direct routing baseline

- Active sing-box config has `api.hh.ru` TCP/443 on inbound `tun-in` routed through outbound `direct-hh`.
- `direct-hh` is type `direct` and binds `wlan0`.
- Journal showed an `outbound/direct[direct-hh]` connection to `94.124.200.0:443` during the existing HH-MCP smoke tests.
- No sing-box route or service changes were made.

## Auth proxy candidate

- GitHub release/tag: `v2.10.2`, stable release, tag target `c8868adee557e793b73c7e8a3b3d37e080854c20`.
- Official release asset: `mcp-auth-proxy-linux-arm64`.
- Expected SHA-256: `924c5335e5f684eb22c681cca1daff86d96fa35f644950cbd8f4c8f3e290bc3d`.
- Downloaded SHA-256: `924c5335e5f684eb22c681cca1daff86d96fa35f644950cbd8f4c8f3e290bc3d` (exact match).
- Host architecture: `aarch64`; candidate is a statically linked AArch64 ELF.
- Build metadata: `github.com/sigbit/mcp-auth-proxy/v2`, version `v2.10.2`.
- System Python bcrypt module is available to root; no additional package is needed for local password setup.

## Secret boundary

No password was supplied in chat or stored in this repository. The local operator command is `sudo /usr/local/sbin/mcp-auth-proxy-set-password`; it reads both entries with shell `read -s`, enforces a minimum of 20 characters, writes only a bcrypt hash, and restarts the service. A real hash must be set before Cloudflare cutover.
