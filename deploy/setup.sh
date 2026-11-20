#!/usr/bin/env bash
# Run once on a fresh Ubuntu server (Oracle Cloud Always Free, Google Cloud e2-micro, any VPS):
#   curl -fsSL https://raw.githubusercontent.com/ponram06/redzone/main/deploy/setup.sh | bash
# Installs Docker, opens ports 80/443, downloads RedZone to ~/redzone. Then copy the secrets
# from your computer with deploy/upload.sh and start it with deploy/start.sh.
set -euo pipefail

if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sudo sh
  sudo usermod -aG docker "$USER"
fi
sudo apt-get install -y git >/dev/null

# Oracle's Ubuntu images block everything but SSH in iptables, on top of the cloud firewall.
if sudo iptables -L INPUT -n | grep -q "REJECT"; then
  for p in 80 443; do
    sudo iptables -C INPUT -p tcp --dport "$p" -j ACCEPT 2>/dev/null || sudo iptables -I INPUT 5 -p tcp --dport "$p" -j ACCEPT
  done
  sudo apt-get install -y iptables-persistent >/dev/null || true
  sudo netfilter-persistent save || true
fi

if [ -d ~/redzone/.git ]; then git -C ~/redzone pull --ff-only; else git clone https://github.com/ponram06/redzone.git ~/redzone; fi
mkdir -p ~/redzone/deploy/data
echo "Ready. Next, on your computer: deploy/upload.sh <user>@<server-ip>"
