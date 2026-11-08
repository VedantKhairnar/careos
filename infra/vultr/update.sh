#!/usr/bin/env bash
# Redeploy the latest pushed commit to the Vultr server.   Usage: infra/vultr/update.sh <server-ip>
set -euo pipefail
IP=${1:?usage: update.sh <server-ip>}
ssh -i ~/.ssh/careos_vultr -o BatchMode=yes "root@$IP" 'bash -s' <<'REMOTE'
set -euo pipefail
cd /opt/careos
runuser -u careos -- git pull --ff-only
runuser -u careos -- bash -lc 'cd /opt/careos && pnpm install --frozen-lockfile && pnpm build'
systemctl restart careos
sleep 4
echo "now running: $(runuser -u careos -- git log -1 --format='%h %s')"
curl -fsS http://127.0.0.1:3000/api/health; echo
REMOTE
