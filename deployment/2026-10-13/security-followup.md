# Security follow-up — 2026-10-13

- Deployed application SHA remains `98f9930a1bbeeed44572986c7d72b197cacc93e2`; application source was not changed.
- Ops branch `ops/preflight-2026-10-13` HEAD before evidence: `65114f8af3b8d2ab434dfc8915baca7d139e7a68`.
- Public MCP surface changed from 25 tools to 24 by removing only `validate_token` from `/etc/hh-mcp/hh-mcp.env` `HH_TOOLS`. Env syntax and root-only `0600` permissions passed; the HH access token was unchanged.
- Local and external Streamable HTTP MCP clients (`http://127.0.0.1:3001/mcp`, `https://hh-mcp.kurva-cloud.ru/mcp`): initialize PASS; tools/list PASS (24, exact expected allow-list on both); `validate_token` absent; `search_vacancies` PASS (`text="technical support"`, `per_page=3`, `raw=true`); `get_vacancy` PASS for one search result. External `/health` returned HTTP 200. One initial curl connection attempt failed transiently; subsequent Node fetch and curl retries returned 200.
- `hh-mcp.service`: active after restart. Listener remains only `127.0.0.1:3001`.
- `fable.service`, `sing-box-host.service`, and `cloudflared.service`: active and untouched; activation timestamps were unchanged across the follow-up.
- No Cloudflare, DNS, sing-box, or tunnel configuration changed. No GitHub Actions ran; nothing was merged. No secrets were recorded in this evidence.
