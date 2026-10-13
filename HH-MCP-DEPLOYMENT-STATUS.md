# HH-MCP deployment status — blocked before installation

Date: 2026-10-13
Workspace: `/home/toligrim/projects/HH-MCP`

## Host

- Hostname: `shuvalova`
- OS: Ubuntu 24.04.4 LTS
- Architecture: `aarch64` (Raspberry Pi kernel)
- Free space: 80 GB
- Node.js: `v22.23.1`; npm: `10.9.8`; git: `2.43.0`
- cloudflared: `2026.9.1` (reports a newer version is available; no upgrade attempted)

## Source

- Repository: `https://github.com/AndreyTepaykin/hh-mcp`
- Requested SHA: `98f9930a1bbeeed44572986c7d72b197cacc93e2`
- GitHub API live SHA: `98f9930a1bbeeed44572986c7d72b197cacc93e2`
- Workspace checkout SHA: `98f9930a1bbeeed44572986c7d72b197cacc93e2` (detached)
- Version: `3.1.0`
- Deployed SHA: **NONE**

## Previous state

- Previous HH-MCP SHA: `NONE`
- `/opt/hh-mcp`: absent
- `hh-mcp.service`: not found
- `/etc/hh-mcp/hh-mcp.env`: absent
- TCP 3000 was already occupied by `fable.service`, bound to `*:3000`. It was left untouched.
- cloudflared before and after checks: enabled, active/running
- Active config: `/etc/cloudflared/config.yml` (root-owned, mode 600)
- Tunnel UUID in config: `3e76f95d-7a53-4940-a28a-2cb68907f680`; tunnel name lookup timed out against the Cloudflare API.
- Existing ingress hostnames: `stt`, `led`, `docs`, `driver`, `research`, `sec`, `soc`, `letopis-mcp`, `svmcp`, `courier`, `mcp-probe` under `kurva-cloud.ru`, plus the existing 404 catch-all.
- Existing config validation: PASS. No ingress or DNS record was added; no cloudflared restart was done.

## Candidate checks

- `npm ci`: PASS
- `npm run typecheck`: PASS
- `npm run lint`: PASS
- `npm test`: PASS — 6 files, 134 tests
- `npm run build`: PASS

Logs are in `source/validation/`.

## Local protocol preflight

A temporary source process listened only on `127.0.0.1:3001` and was stopped after the checks.

- GET `/health`: PASS, HTTP 200, version `3.1.0`
- MCP initialize: PASS
- MCP tools/list: PASS with the proposed exclusions below; 24 tools were returned
- `search_vacancies`: FAIL. HH API returned HTTP 403, `errors[].type=forbidden` (request ID `179184310377653333d71d0142e01003`). A direct anonymous request using the candidate default User-Agent also returned 403 (request ID `17918431215436681359d9e692cfb000`).
- `get_vacancy`: NOT RUN because no vacancy was returned by search
- No `HH_ACCESS_TOKEN` was set or used. No mass search was performed.

The selected tool groups alone expose employer-token tools as well. The following `HH_TOOLS_EXCLUDE` was used for the successful tools/list surface check; it was not installed as a production environment file:

`get_vacancy_stats,get_vacancy_visitors,get_vacancy_conditions,list_employer_managers,get_employer_manager,get_manager_resume_limits,get_manager_negotiations_statistics,list_active_vacancies,list_archived_vacancies,list_hidden_vacancies,get_message_template,list_mail_templates,get_employer_vacancy_areas,get_employer_departments,list_employer_addresses,suggest_resume_search_keyword`

## Blockers

1. The required production bind `127.0.0.1:3000` conflicts with the existing `fable.service` listener on `*:3000`. No service was stopped or changed. A request was sent asking whether to use `127.0.0.1:3001` for HH-MCP.
2. The actual anonymous vacancy search failed with HTTP 403 from `api.hh.ru`; thus the required real vacancy smoke test and `get_vacancy` check have not passed. The HH API documentation says access tokens are needed for most API requests, but the local response does not establish the exact cause for this search endpoint.
3. The deployed MCP endpoint would have no application authentication. No endpoint was published, and Cloudflare Access/WAF/rate limiting was not changed or verified.
4. `npm audit --omit=dev` reported 9 production dependency advisories (1 critical, 4 high, 3 moderate, 1 low). No dependencies or lockfile were changed; reachability of every advisory in the runtime path was not established.

## Deployment state and rollback

- Deployment: **NOT performed**; `/opt`, `/etc/hh-mcp`, systemd, Cloudflare config and DNS were not changed.
- External `/health`, MCP initialize/list/search, and TLS: NOT RUN (no route was created).
- Port 3001: no remaining listener.
- Secret exposure: PASS; no credential or token values were printed.
- Rollback prepared: NO — no deployment mutation was made, so no config backup was created.
- If deployment later proceeds: stop/disable only `hh-mcp.service`; remove only the newly added HH-MCP ingress and DNS record; restore the timestamped pre-change `/etc/cloudflared/config.yml` backup; validate it; restart cloudflared; confirm all pre-existing routes remain healthy.
