set -euo pipefail
: "${HOST:?set HOST, e.g. HOST=203-0-113-5.sslip.io}"
cat > /etc/systemd/system/careos.service <<UNIT
[Unit]
Description=Care ON web app
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=careos
Group=careos
WorkingDirectory=/opt/careos
Environment=NODE_ENV=production
ExecStart=/usr/local/bin/node /opt/careos/node_modules/next/dist/bin/next start -H 127.0.0.1 -p 3000
Restart=always
RestartSec=3
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full

[Install]
WantedBy=multi-user.target
UNIT
cat > /etc/caddy/Caddyfile <<CADDY
$HOST {
	encode gzip
	header {
		Strict-Transport-Security "max-age=31536000"
		X-Content-Type-Options nosniff
		X-Frame-Options SAMEORIGIN
		Referrer-Policy strict-origin-when-cross-origin
	}
	reverse_proxy 127.0.0.1:3000
}
CADDY
systemctl daemon-reload
systemctl enable --now careos >/dev/null 2>&1
caddy validate --config /etc/caddy/Caddyfile >/dev/null 2>&1 && echo "caddy config valid"
systemctl restart caddy
echo "== host firewall"
ufw --force reset >/dev/null; ufw default deny incoming >/dev/null; ufw default allow outgoing >/dev/null
ufw allow 22/tcp >/dev/null; ufw allow 80/tcp >/dev/null; ufw allow 443/tcp >/dev/null; ufw --force enable >/dev/null; ufw status | sed -n '1,8p'
echo "== ssh: keys only"
printf 'PasswordAuthentication no\nKbdInteractiveAuthentication no\nPermitRootLogin prohibit-password\n' > /etc/ssh/sshd_config.d/99-careos.conf
sshd -t && systemctl reload ssh && echo "ssh hardened"
sleep 4
systemctl is-active careos caddy
curl -s -o /dev/null -w "app directly on localhost:3000 -> HTTP %{http_code}\n" http://127.0.0.1:3000/api/health
