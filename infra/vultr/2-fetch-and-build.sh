set -euo pipefail
id careos >/dev/null 2>&1 || useradd -m -s /bin/bash careos
rm -rf /opt/careos; git clone -q https://github.com/VedantKhairnar/careos.git /opt/careos
install -m 600 -o careos -g careos /root/careos.env /opt/careos/.env.local; shred -u /root/careos.env
chown -R careos:careos /opt/careos
cd /opt/careos; echo "cloned commit: $(git log -1 --format='%h %s')"
runuser -u careos -- bash -lc 'cd /opt/careos && pnpm install --frozen-lockfile 2>&1 | tail -3 && pnpm build 2>&1 | grep -E "Compiled|rror|Generating static pages using" | head -4'
ls -la /opt/careos/.env.local | awk '{print "settings file:", $1, $3}'
echo "== stage B done"
