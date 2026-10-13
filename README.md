# HH-MCP ops preflight package

This branch contains the reviewed deployment candidate source snapshot and the Raspberry Pi deployment preflight evidence collected on 2026-10-13.

## Contents

- `HH-MCP-DEPLOYMENT-STATUS.md` — detailed host, source, service, tunnel, test, security, blocker, and rollback status.
- `candidate-source/` — tracked repository files exported from the exact candidate SHA recorded in `SOURCE-CANDIDATE.txt`.
- `logs/` — npm install, typecheck, lint, test, build, and temporary local server logs.
- `build-output/dist/` — output produced by the candidate's `npm run build`.

The preflight did not install or publish a production service. The report records the blockers and the checks that passed or failed. Generated `node_modules` and Git object metadata are omitted; dependencies can be recreated with `npm ci` from the included lockfile.

The source snapshot is nested under `candidate-source/`, so its upstream `.github/workflows` file is not a workflow at this repository's root. This upload does not run GitHub Actions.
