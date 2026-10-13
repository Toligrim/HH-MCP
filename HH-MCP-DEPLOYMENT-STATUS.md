# HH-MCP deployment report — 2026-10-13

## Source and deployment

- Upstream: `https://github.com/AndreyTepaykin/hh-mcp`
- Requested candidate SHA: `98f9930a1bbeeed44572986c7d72b197cacc93e2`
- Actual deployed SHA (`git -C /opt/hh-mcp rev-parse HEAD`): `98f9930a1bbeeed44572986c7d72b197cacc93e2`
- Previous `/opt/hh-mcp` deployment: none; the path was absent before installation.
- Installation path: `/opt/hh-mcp`
- No application logic or dependency lockfile changes were made. No GitHub Actions workflow ran. Nothing was merged.

## Host and systemd

- Host: `shuvalova`, Ubuntu 24.04.4 LTS, aarch64; Node.js `v22.23.1`.
- Service: `hh-mcp.service` active and enabled; runtime `hh-mcp:hh-mcp`.
- Listener: `127.0.0.1:3001` only. No `0.0.0.0:3001` or `[::]:3001` listener.
- `fable.service` remained active on `*:3000`; it was not changed.
- Environment file: `/etc/hh-mcp/hh-mcp.env`, root:root `0600`; directory root:root `0755`. `HH_ALLOWED_ORIGINS` is unset.
- Secret check: token present; token absent from unit text, process arguments, and `hh-mcp.service` journal output. Secret exposure: PASS.

## HH direct egress and authentication

- sing-box: `1.13.14`, unit `sing-box-host.service`, config `/etc/sing-box/host.json`; active after restart and config validation.
- `wlan0` state: up.
- Domain rule: `api.hh.ru` TCP/443 through `direct-hh`; direct outbound is bound to `wlan0`. A TCP/443 sniff rule lets the TUN inbound route the hostname without fixed API IPs.
- No static `api.hh.ru` IP route is present in sing-box config. The existing general `direct` and VLESS routing remain intact. The previous `hh-direct.timer` was disabled and its current HH host route removed; rollback restores the prior timer/routing.
- The route persisted through sing-box restart. Journal evidence recorded `outbound/direct[direct-hh]`; the kernel route enters `tun-vless` for sing-box inspection. The existing proxy path and direct `wlan0` path both returned HTTP 204 to a connectivity probe.
- Public egress comparison: proxy vs direct through `wlan0` was DIFFERENT.
- `GET https://api.hh.ru/me`, with the candidate HH User-Agent and Bearer token loaded from the root-only env file: HTTP 200.
- MCP `validate_token`: PASS.

## MCP tool surface

`HH_TOOLS` is an explicit 25-name allow-list. MCP `tools/list` returned exactly these names; no resume, ATS, negotiation, manager, batch, or other employer-management tools were exposed:

`search_vacancies`, `get_vacancy`, `get_similar_vacancies`, `get_related_vacancies`, `search_employers`, `get_employer`, `get_employer_vacancies`, `get_areas`, `get_areas_subtree`, `get_professional_roles`, `get_industries`, `get_metro`, `get_dictionaries`, `suggest_positions`, `suggest_professional_roles`, `suggest_companies`, `suggest_areas`, `suggest_vacancy_search_keyword`, `suggest_skill_set`, `get_countries`, `get_languages`, `get_skills`, `get_districts`, `get_salary_statistics`, `validate_token`.

All exposed operations are read-only. The candidate's `validate_token` response includes the token owner's profile name and email when present. Because the requested endpoint is public and Cloudflare Access is off, an unauthenticated caller can invoke that tool and see those profile fields.

## Candidate checks and audit

All requested checks were run against the exact installed candidate. Detailed npm logs and the raw audit JSON are under `deployment/2026-10-13/evidence/`.

- `npm ci`: PASS
- `npm ci --omit=dev`: PASS
- `npm run typecheck`: PASS
- `npm run lint`: PASS
- `npm test`: PASS — 6 files, 134 tests
- `npm run build`: PASS
- `npm audit --omit=dev --json`: 9 findings — 1 critical, 4 high, 3 moderate, 1 low. No `npm audit fix` was run.

High/critical dependency review for this runtime:

| Package in lockfile | Severity / path | Fixed version | Reachability in this deployment |
| --- | --- | --- | --- |
| `@modelcontextprotocol/sdk@1.28.0` | High, direct | `1.31.0` | Advisory concerns SDK OAuth clients sending credentials to an attacker-chosen authorization server. This service uses server-side MCP transports, not the OAuth client path. [GHSA-6qxp-vccf-f47h](https://github.com/advisories/GHSA-6qxp-vccf-f47h) |
| `fast-uri@3.1.0` | High, transitive via SDK/Ajv | `3.1.8` | Public tool schemas are fixed in the candidate; the allow-listed tool inputs have no URI-format fields or caller-supplied schema references. The vulnerable URI parsing path was not found reachable from MCP input. [GHSA-hrr3-gc8f-f4qj](https://github.com/advisories/GHSA-hrr3-gc8f-f4qj) |
| `hono@4.12.9` | High, transitive via SDK and `@hono/node-server` | `4.13.7` | The HTTP adapter is used, but affected helpers such as `parseBody`, `serveStatic`, JSX, and CORS middleware are not registered or invoked by this service. MCP JSON is parsed by the candidate's bounded native HTTP body reader. [GHSA-g6gw-c38x-mqfc](https://github.com/advisories/GHSA-g6gw-c38x-mqfc) |
| `ip-address@10.1.0` | High, transitive via `express-rate-limit` | `10.7.1` | The candidate HTTP server and SDK transport do not import or use `express-rate-limit` or `ip-address`. No request path to the affected parser was found. [GHSA-h3mg-xc3c-68pw](https://github.com/advisories/GHSA-h3mg-xc3c-68pw) |
| `proxy-addr@2.0.7` | Critical, transitive via Express | `2.0.8` | The candidate uses `node:http` and the SDK Hono adapter; it does not import the SDK's Express adapter or Express. No request path to `proxy-addr` was found. [GHSA-jqcg-44mw-7w3h](https://github.com/advisories/GHSA-jqcg-44mw-7w3h) |

This is a static runtime-path review of the exact candidate and its installed production tree. No critical/high advisory was found reachable through the deployed MCP HTTP endpoint; the locked dependencies were left unchanged.

## Local acceptance

A temporary instance was used first, then the production systemd unit was tested again. Both runs used a real Streamable HTTP MCP client.

- `GET http://127.0.0.1:3001/health`: PASS, HTTP 200.
- MCP initialize: PASS.
- MCP `tools/list`: PASS, exact 25-name allow-list.
- `validate_token`: PASS.
- `search_vacancies` with `text="technical support"`, `per_page=3`: PASS, three real HH results.
- `get_vacancy` using one returned ID: PASS.

## Cloudflare and external acceptance

- Existing tunnel reused: ID `3e76f95d-7a53-4940-a28a-2cb68907f680`, name `ledger-miniapp`; no tunnel was created.
- Active config: `/etc/cloudflared/config.yml`.
- Timestamped pre-change backup: `/etc/cloudflared/config.yml.bak-hh-mcp-20261013T073641Z`.
- Added only `hh-mcp.kurva-cloud.ru -> http://127.0.0.1:3001` before the catch-all. The old ingress list is structurally identical to the backup after removing that one rule.
- `cloudflared tunnel ingress validate`: PASS; service active and enabled.
- DNS route: created for the exact hostname on the existing tunnel; no prior DNS answer existed and no overwrite option was used.
- External HTTPS health: PASS, HTTP 200 with normal TLS certificate validation.
- External Streamable HTTP MCP client: initialize PASS; tools/list PASS; validate_token PASS; search_vacancies PASS with three results; get_vacancy PASS.
- Existing ingress spot-check after restart: 10/11 public `/` requests matched the local origin's status. `letopis-mcp.kurva-cloud.ru/` returned edge HTTP 403 while its local origin returned 404; its route/config was preserved, but that external root behavior remains unverified.
- Cloudflare Access was not enabled. Rate limiting on `/mcp` was not configured or verified because no safe setting was confirmed for all intended MCP clients.

## Security and rollback

The MCP endpoint is publicly reachable without interactive Cloudflare Access. The tool surface is read-only and allow-listed. In addition to the public `validate_token` profile disclosure described above, anonymous callers can use the allowed HH read endpoints with the configured application token's access level.

Rollback artifacts:

- Cloudflare: `/etc/cloudflared/config.yml.bak-hh-mcp-20261013T073641Z`
- sing-box: `/etc/sing-box/host.json.bak-hh-mcp-20261013T071611Z`

Rollback is ready. Stop and disable only `hh-mcp.service`; remove only the `hh-mcp.kurva-cloud.ru` DNS record in the Cloudflare DNS dashboard; restore the Cloudflare backup, validate it, restart cloudflared, and check the existing routes. Restore the sing-box backup, run `sing-box check`, restart `sing-box-host`, then re-enable `hh-direct.timer` and verify the original route. Do not delete any other hostname or DNS record. Full sequence is in `deployment/2026-10-13/rollback.md`.
