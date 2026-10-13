# Local OAuth proxy checks — 2026-10-13

## Installed service

- Release: `v2.10.2`; release commit: `c8868adee557e793b73c7e8a3b3d37e080854c20`.
- Installed binary: `/usr/local/bin/mcp-auth-proxy`.
- SHA-256: `924c5335e5f684eb22c681cca1daff86d96fa35f644950cbd8f4c8f3e290bc3d`.
- `mcp-auth-proxy.service`: enabled and active as `mcp-auth-proxy:mcp-auth-proxy`.
- Service listener: only `127.0.0.1:3002`; no wildcard listener on 3002 and no proxy TLS listener on 443.
- Backend: `http://127.0.0.1:3001`; `/mcp` path is preserved, confirmed by authenticated initialize/tools/call requests through the proxy.
- Environment file: root-owned `0600`; config values use the requested external URL, loopback bind, `NO_AUTO_TLS=true`, local backend, and `PROXY_FORWARD_AUTHORIZATION=false`.
- After the operator ran the hidden-input password helper, the production `PASSWORD_HASH` was present, bcrypt cost 12, with no plaintext `PASSWORD` setting. The original operator hash was restored after scripted external flow tests.
- State directory: `mcp-auth-proxy:mcp-auth-proxy`, `0700`; `db`, `secret`, and `private_key.pem` are `0600`.
- Cookie HMAC secret and JWT private key content hashes were unchanged across a service restart. An access token issued before a restart remained valid after restart, and authenticated `tools/list` still returned 24 tools; the local BoltDB state persisted.
- Built-in `GET /healthz`: HTTP 200. This is the proxy's own v2.10.2 endpoint; no backend `/health` bypass was added.
- `systemd-analyze verify` accepted the new unit. It also printed two unrelated pre-existing dependency-name warnings for `freelance-office.service` and `freelance-radar.service`.

## Discovery and anonymous requests

- `POST /mcp` with anonymous `initialize`, `tools/list`, and `search_vacancies`: HTTP 401 for all three.
- The 401 response has no `WWW-Authenticate` or `Link` header.
- `GET /.well-known/oauth-protected-resource`: HTTP 200; returned `resource` `https://hh-mcp.kurva-cloud.ru/` and the same value in `authorization_servers`.
- Following the advertised authorization-server identifier, `GET /.well-known/oauth-authorization-server`: HTTP 200.
- Actual advertised endpoints: `/.idp/auth`, `/.idp/token`, `/.idp/register`.
- AS metadata advertises `code_challenge_methods_supported: ["S256"]`, token endpoint methods including `none`, and authorization-code plus refresh-token grants.
- Metadata omits `authorization_response_iss_parameter_supported` and `client_id_metadata_document_supported`. DCR is advertised and the authorization endpoint supports the callback-ID-specific redirect pattern.
- Metadata returned public endpoint URLs and no password/hash, HMAC secret, private key, or OAuth token values.
- ChatGPT metadata review used [OpenAI's MCP authentication requirements](https://developers.openai.com/plugins/build/auth): protected-resource metadata, authorization-server metadata, DCR, public-client token method, PKCE S256, and exact `resource` round-trip were exercised. OpenAI documents the callback-ID-specific URI for authorization servers that do not advertise RFC 9207 issuer response support; a DCR flow using that URI pattern passed. The actual ChatGPT UI connection remains separate and was not run.
- The 401 response has no `WWW-Authenticate` or `Link` header. The public protected-resource well-known endpoint returns HTTP 200; OpenAI's documented discovery path permits that endpoint directly.

## Scripted OAuth 2.1 flow

Two initial local smoke runs generated temporary random test passwords in memory, stored only each bcrypt hash in the root-only environment file during the run, and restored the original no-hash file. A later public OAuth smoke used a separate transient random password hash, preserved the operator's original env file in a root-only temporary backup, and restored the exact production hash before authenticated MCP calls. Test passwords and tokens were not printed or committed.

- DCR registration of a public client with `token_endpoint_auth_method=none`: HTTP 201.
- Authorization code flow: PASS; submitted a PKCE S256 challenge and validated returned state.
- Password login: PASS against the temporary test hash.
- Token exchange: HTTP 200; access and refresh tokens issued.
- Authenticated proxy initialize: HTTP 200.
- Authenticated `tools/list`: HTTP 200, count 24; `validate_token` absent.
- Authenticated `search_vacancies`: PASS, 3 results.
- Authenticated `get_vacancy`: PASS.
- Loopback capture of the proxy-to-HH-MCP request saw no `Authorization` bearer header and did not contain the OAuth access token.
- Search of recent proxy and HH-MCP journals did not find the OAuth access token.
- The test OAuth client/token records remain in the protected local BoltDB. They were not exported or committed; the signing keys and database were retained.

## Public cutover acceptance

- Cloudflare origin changed only for `hh-mcp.kurva-cloud.ru`, from `http://127.0.0.1:3001` to `http://127.0.0.1:3002`; ingress validation passed before cloudflared restart.
- Public `/.well-known/oauth-protected-resource` and `/.well-known/oauth-authorization-server`: HTTP 200; DCR, authorization-code flow, `token_endpoint_auth_method=none`, and PKCE S256 are advertised.
- Public anonymous `initialize`, `tools/list`, and `search_vacancies`: HTTP 401. Public `/health`: HTTP 401 as expected; local backend `/health`: HTTP 200.
- External scripted flow passed client registration, password login, authorization consent, code/state validation, PKCE S256, token exchange, and authenticated initialize. A callback-ID-specific URI under `https://chatgpt.com/connector/oauth/` was tested with DCR.
- After restoring the operator bcrypt hash and restarting the proxy, the issued access token remained valid. Authenticated `tools/list` returned 24 tools; `validate_token` was absent; `search_vacancies` and `get_vacancy` passed.
- Loopback capture to HH-MCP contained no OAuth bearer header or access-token value. Recent proxy and HH-MCP journals contained no access-token value.

## Final state

- `PASSWORD_HASH` is configured as bcrypt in the root-only env file; no plaintext password is stored.
- Cloudflare now routes the public hostname through the loopback-only auth proxy.
- The five required services are active. HH-MCP remains untouched on port 3001; `sing-box-host.service` and `fable.service` were not changed.
