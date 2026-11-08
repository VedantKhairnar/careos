# Deploying Care ON on Vultr

What runs: one Vultr Cloud Compute server (Ubuntu 24.04, 2 vCPU / 4 GB, New Jersey). Caddy terminates HTTPS with an
automatic Let's Encrypt certificate and proxies to the app on `127.0.0.1:3000`, which runs as an unprivileged user
under systemd. The database is Tiger Data (reached over verified TLS), so the server holds no data of its own.

The public hostname is `<ip-with-dashes>.sslip.io`, which needs no domain. Point a real domain (for example from
GoDaddy) at the server's IP and change the hostname in `/etc/caddy/Caddyfile` and `APP_BASE_URL`.

## Create it (Vultr API or console)
1. Upload an SSH public key.
2. Create a firewall group: TCP 80 and 443 from anywhere, TCP 22 from your own IP only.
3. Create the instance with that key and firewall; no backups, no IPv6.

## Set it up (run from your machine, in order; these are the exact scripts that were used)
```
ssh root@IP 'bash -s' < infra/vultr/1-install-runtime.sh        # Node 22 (checksum verified), pnpm, Caddy
scp settings.env root@IP:/root/careos.env                          # see below; never commit this file
ssh root@IP 'bash -s' < infra/vultr/2-fetch-and-build.sh        # app user, clone, settings, install, build
ssh root@IP "HOST=203-0-113-5.sslip.io bash -s" < infra/vultr/3-service-https-firewall.sh   # HOST is passed to the server here
```
`settings.env` needs: `APPLICATION_SECRET` (random, 32+ bytes), `APP_BASE_URL` (the https URL), `DEMO_MODE=true`,
`GEMINI_API_KEY`, `DATABASE_URL`. Do NOT put the Vultr API key on the server; it is not needed there.

## Update
`infra/vultr/update.sh <server-ip>` pulls the latest commit, rebuilds and restarts, then prints the health check.

## Check it
`curl https://HOST/api/health` returns `{"data":{"status":"ok","database":"connected",...}}` (503 if the database is unreachable).

## Know before you rely on it
- `DEMO_MODE=true` is on, so anyone with the URL can use the role switcher, load or clear the fictional demo data, and use
  the AI assistants (which spend Gemini quota). Fine for a demonstration with fictional data; do not put real patient data here.
- Both scripts 1 and 2 use `set -e` and stop at the first error. Script 3 replaces the firewall rules and SSH settings on the host.
- To remove everything: delete the instance, firewall group and SSH key in Vultr.
