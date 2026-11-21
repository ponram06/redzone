# Hosting RedZone (free, always on)

One Ubuntu server runs RedZone 24/7: the app in Docker, behind Caddy, which gets the HTTPS
certificate by itself. Everything players see comes from the chain and from the data you copy over;
nothing is made up.

**The live site** (https://redzone.malaysiawest.cloudapp.azure.com) runs on an Azure for Students VM
(Ubuntu, Malaysia West) set up exactly this way, with the Azure DNS name passed as `DOMAIN`. The
steps below use Oracle Cloud's free tier, but any Ubuntu server with ports 80 and 443 open works.

## 1. Get a free server

Oracle Cloud Always Free (free for good, no sleeping, 4 ARM cores, 24 GB RAM):

1. Sign up at https://signup.cloud.oracle.com (a card is checked but not charged on Always Free).
2. **Compute → Instances → Create instance**:
   - Image: **Canonical Ubuntu 24.04**. Shape: **Ampere VM.Standard.A1.Flex**, 2 OCPU, 12 GB.
   - Networking: keep "Assign a public IPv4 address".
   - SSH keys: **Save private key** (keep the downloaded `.key` file).
3. Open the instance's **Subnet → Security list → Add ingress rules**: source `0.0.0.0/0`,
   TCP, destination ports `80,443`.

Google Cloud's free `e2-micro` (us-central1, us-east1 or us-west1) works the same way: allow
HTTP and HTTPS traffic when creating it.

## 2. Install

On the server (`ssh -i <key> ubuntu@<server-ip>`):

```bash
curl -fsSL https://raw.githubusercontent.com/ponram06/redzone/main/deploy/setup.sh | bash
```

## 3. Copy the secrets and data

On your computer, in Git Bash at the repo root. **Stop the RedZone backend on your computer
first**: the relayer must run in one place only.

```bash
deploy/upload.sh ubuntu@<server-ip> -i <key>
```

## 4. Start

On the server:

```bash
~/redzone/deploy/start.sh
```

The site is at `https://<ip-with-dashes>.sslip.io` (a free name that points at the IP). For your
own domain, point its A record at the server and run `DOMAIN=redzone.example ~/redzone/deploy/start.sh`.

**Updating**: push to GitHub, then run `~/redzone/deploy/start.sh` again. Logs:
`cd ~/redzone/deploy && docker compose logs -f redzone`. Back up `~/redzone/deploy/data`,
`server.env` and `referee-key.json`.
