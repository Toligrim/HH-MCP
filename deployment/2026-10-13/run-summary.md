# Deployment acceptance evidence — 2026-10-13

- Deployed candidate SHA: `98f9930a1bbeeed44572986c7d72b197cacc93e2` (exact).
- npm install, typecheck, lint, 134 tests, build, and production-only install: PASS. Raw logs are adjacent; `npm-audit.json` records 9 production-tree findings.
- HH `/me`: HTTP 200. MCP token validation: PASS.
- Local production endpoint: `/health`, initialize, exact `tools/list`, search of `technical support` (three HH results), and `get_vacancy`: PASS.
- External HTTPS `/health`: HTTP 200 and TLS validation PASS.
- External MCP Streamable HTTP: initialize, tools/list, validate_token, search (three HH results), and get_vacancy: PASS.
- HH domain route: `api.hh.ru` -> `direct-hh` bound to `wlan0`; sing-box 1.13.14 config check PASS; direct outbound observed in journal; proxy and direct egress comparison DIFFERENT.
- Cloudflare: existing tunnel reused; ingress validate PASS; `cloudflared` active; old ingress rules unchanged.
- Listener: only `127.0.0.1:3001` for HH-MCP. `fable.service` remains active on port 3000.
- Token: configured in root-only `/etc/hh-mcp/hh-mcp.env`; no value appears in the unit, process args, or service journal.
