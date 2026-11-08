set -euo pipefail
export DEBIAN_FRONTEND=noninteractive
echo "== system update"; apt-get update -qq; apt-get upgrade -y -qq >/dev/null
apt-get install -y -qq curl git ca-certificates gnupg ufw xz-utils debian-keyring debian-archive-keyring apt-transport-https >/dev/null
echo "== Node 22 from nodejs.org, checksum verified"
cd /tmp; BASE=https://nodejs.org/dist/latest-v22.x
curl -fsSL $BASE/SHASUMS256.txt -o SHASUMS256.txt
FILE=$(grep -o 'node-v22[0-9.]*-linux-x64.tar.xz' SHASUMS256.txt | head -1)
curl -fsSL $BASE/$FILE -o $FILE
grep " $FILE\$" SHASUMS256.txt | sha256sum -c -
tar -xJf $FILE -C /usr/local --strip-components=1
node -v
corepack enable; corepack prepare pnpm@10.23.0 --activate >/dev/null; pnpm -v
echo "== Caddy from the official apt repository"
curl -fsSL 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -fsSL 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' -o /etc/apt/sources.list.d/caddy-stable.list
apt-get update -qq; apt-get install -y -qq caddy >/dev/null; caddy version
echo "== stage A done"
