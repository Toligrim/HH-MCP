# OAuth proxy rollback

Rollback is prepared before changing the `hh-mcp.kurva-cloud.ru` origin. It touches only that hostname's ingress entry and leaves HH-MCP on port 3001 unchanged.

1. Restore the timestamped Cloudflare config backup recorded in the deployment evidence. The current pre-cutover backup is `/etc/cloudflared/config.yml.bak-mcp-auth-proxy-20261013T100301Z` (SHA-256 `c095db34b0f0ca765b5498b230a277c361161169c1e9b278cef9413c6fe5f1cc`). Recheck its checksum before restoring:

   ```sh
   printf '%s  %s\n' 'c095db34b0f0ca765b5498b230a277c361161169c1e9b278cef9413c6fe5f1cc' '/etc/cloudflared/config.yml.bak-mcp-auth-proxy-20261013T100301Z' | sudo sha256sum -c -
   sudo cp -a /etc/cloudflared/config.yml.bak-mcp-auth-proxy-20261013T100301Z /etc/cloudflared/config.yml
   sudo cloudflared tunnel --config /etc/cloudflared/config.yml ingress validate
   sudo systemctl restart cloudflared.service
   sudo systemctl is-active cloudflared.service
   ```

2. Confirm the `hh-mcp.kurva-cloud.ru` ingress points to `http://127.0.0.1:3001` and the public MCP is restored.

3. Stop and disable only the auth proxy; retain `/var/lib/mcp-auth-proxy` and its keys for diagnosis:

   ```sh
   sudo systemctl disable --now mcp-auth-proxy.service
   ```

4. Confirm `hh-mcp.service` remains active on `127.0.0.1:3001`. Do not change `fable.service`, `sing-box-host.service`, DNS, tunnel credentials, or any other ingress.
