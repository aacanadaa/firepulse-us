#!/usr/bin/env bash
# One-shot setup for the FirePulse API on a fresh Debian/Ubuntu VM.
# Usage: sudo bash bootstrap.sh   (expects deploy/gce/.env to exist already)
set -euo pipefail
REPO_DIR=/opt/firepulse-us

# 2 GB swap: building the API image on 1 GB RAM otherwise OOMs.
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  grep -q /swapfile /etc/fstab || echo '/swapfile none swap sw 0 0' >> /etc/fstab
  sysctl -w vm.swappiness=20
  echo 'vm.swappiness=20' > /etc/sysctl.d/99-swap.conf
fi

if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker

# Keep container logs from filling a 10 GB disk.
if [ ! -f /etc/docker/daemon.json ]; then
  echo '{"log-driver":"json-file","log-opts":{"max-size":"10m","max-file":"3"}}' > /etc/docker/daemon.json
  systemctl restart docker
fi

if ! command -v git >/dev/null; then apt-get update -y && apt-get install -y git; fi
if [ ! -d "$REPO_DIR/.git" ]; then
  git clone https://github.com/aacanadaa/firepulse-us.git "$REPO_DIR"
fi

cd "$REPO_DIR/deploy/gce"
docker compose up -d --build
docker builder prune -af
docker compose ps
