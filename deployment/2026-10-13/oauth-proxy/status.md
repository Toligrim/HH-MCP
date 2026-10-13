# OAuth proxy deployment status — 2026-10-13

Deployment and controlled Cloudflare cutover completed. Public MCP requests now pass through `mcp-auth-proxy` on `127.0.0.1:3002`; HH-MCP remains unchanged on `127.0.0.1:3001` at SHA `98f9930a1bbeeed44572986c7d72b197cacc93e2`.

## Installed proxy

- Release `v2.10.2`, exact source commit `c8868adee557e793b73c7e8a3b3d37e080854c20`.
- Official AArch64 asset SHA-256: `924c5335e5f684eb22c681cca1daff86d96fa35f644950cbd8f4c8f3e290bc3d`.
- Service runs as `mcp-auth-proxy:mcp-auth-proxy`; listener `127.0.0.1:3002`; backend `http://127.0.0.1:3001`.
- State persists in `/var/lib/mcp-auth-proxy`; `PASSWORD_HASH` is bcrypt in `/etc/mcp-auth-proxy/mcp-auth-proxy.env` (`root:root 0600`). No plaintext password is stored in the unit or repository.
- `PROXY_FORWARD_AUTHORIZATION=false`; `NO_AUTO_TLS=true`; local backend health remains HTTP 200.

## OAuth and public access

- Protected-resource and authorization-server metadata are public and return HTTP 200.
- Public anonymous `initialize`, `tools/list`, and `search_vacancies` return HTTP 401.
- External scripted flow passed DCR, password login, consent, authorization code, state validation, PKCE S256, token exchange, and authenticated MCP requests. A transient random test password was used only during the flow; the original operator bcrypt hash was restored before authenticated MCP calls. Passwords and tokens were not printed or committed.
- Authenticated public `tools/list` returned 24 tools; `validate_token` is absent; `search_vacancies` and `get_vacancy` passed.
- The OAuth access token was absent from service logs and loopback traffic to HH-MCP; the proxy did not forward the Authorization header.
- OpenAI metadata review: DCR and PKCE S256 are advertised. The authorization server does not advertise RFC 9207 issuer response support, so ChatGPT should use a callback-ID-specific redirect; that redirect pattern was exercised with DCR. The actual ChatGPT UI connection remains a separate operator step, as requested.
- Public `/health` returns 401 through the auth proxy. Backend health remains available locally at `http://127.0.0.1:3001/health`; no bypass was added.

## Cloudflare and recovery

- Only `hh-mcp.kurva-cloud.ru` changed origin, from `http://127.0.0.1:3001` to `http://127.0.0.1:3002`.
- Pre-cutover backup: `/etc/cloudflared/config.yml.bak-mcp-auth-proxy-20261013T100301Z`, SHA-256 `c095db34b0f0ca765b5498b230a277c361161169c1e9b278cef9413c6fe5f1cc`.
- Post-cutover config SHA-256: `13ed80bed8c2e43e81856a0daad8f3f0a43c76797492b2ea27273fc25cf15d8f`; ingress validation passed and `cloudflared.service` is active.
- Rollback procedure is ready in `rollback.md`; it restores only the recorded config backup and preserves proxy state and keys.

All five required services are active: `hh-mcp`, `mcp-auth-proxy`, `cloudflared`, `sing-box-host`, and `fable`. Deployment evidence is committed and pushed to `ops/preflight-2026-10-13`. No merge or GitHub Actions run was performed.
