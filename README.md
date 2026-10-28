# HH-MCP operations record

This ops branch records deployment of the exact upstream candidate `98f9930a1bbeeed44572986c7d72b197cacc93e2` to the Raspberry Pi host on 2026-10-13. The application source was not modified. No GitHub Actions workflow ran, and nothing was merged.

## Deployment artifacts

- `HH-MCP-DEPLOYMENT-STATUS.md` — final deployment report, acceptance evidence, audit reachability review, and rollback steps.
- `deployment/2026-10-13/` — sanitized systemd, env example, Cloudflare and sing-box fragments, run summary, and npm logs/audit JSON.
- `deployment/2026-10-13/security-followup.md` — production evidence for removing `validate_token` from the public MCP tool surface.
- `candidate-source/`, `build-output/`, and `SOURCE-CANDIDATE.txt` — the previously reviewed exact candidate snapshot.

The production application is installed at `/opt/hh-mcp`, listens only on `127.0.0.1:3001`, and is exposed through the existing Cloudflare Tunnel as `https://hh-mcp.kurva-cloud.ru`. HH application credentials are stored only in `/etc/hh-mcp/hh-mcp.env`; no token or cloud credentials are included here.

The current search-engine development candidate is in [`candidate-source/`](./candidate-source/); its local collection and checkpoint recovery guide is [`candidate-source/docs/search-engine.md`](./candidate-source/docs/search-engine.md). The historical `build-output/` artifact and `SOURCE-CANDIDATE.txt` above remain the deployment baseline.
