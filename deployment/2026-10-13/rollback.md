# HH-MCP rollback — 2026-10-13

Run on `shuvalova` as an administrator. These steps remove only the HH-MCP exposure and restore the pre-deployment sing-box configuration.

1. Stop and disable HH-MCP:

   ```sh
   sudo systemctl disable --now hh-mcp.service
   ```

2. In the Cloudflare dashboard, delete only the DNS record whose hostname is `hh-mcp.kurva-cloud.ru`. Leave every other record and tunnel route untouched.

3. Restore the Cloudflare config backup, validate, and restart the existing connector:

   ```sh
   sudo cp -a /etc/cloudflared/config.yml.bak-hh-mcp-20261013T073641Z /etc/cloudflared/config.yml
   sudo cloudflared tunnel --config /etc/cloudflared/config.yml ingress validate
   sudo systemctl restart cloudflared.service
   sudo systemctl is-active cloudflared.service
   ```

   Recheck the pre-existing public ingress hostnames.

4. Restore sing-box and the previous HH timer:

   ```sh
   sudo cp -a /etc/sing-box/host.json.bak-hh-mcp-20261013T071611Z /etc/sing-box/host.json
   sudo /usr/local/bin/sing-box check -c /etc/sing-box/host.json
   sudo systemctl restart sing-box-host.service
   sudo systemctl enable --now hh-direct.timer
   sudo systemctl start hh-direct.service
   sudo systemctl is-active sing-box-host.service
   sudo systemctl is-enabled hh-direct.timer
   ```

5. Verify the original proxy flow and HH route. Do not stop or edit `fable.service`.
