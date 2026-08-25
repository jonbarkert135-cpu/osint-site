#!/usr/bin/env bash
# Raven — Part 2 §33 host survey.
# Run ON the deployment VPS. Prints one `key: value` line per capability so the
# output can be pasted straight into RAVEN-SPEC/29_RUNTIME_ENVIRONMENT.md §7.2.
set -uo pipefail

ask() { printf '%-24s %s\n' "$1:" "${2:-unknown}"; }
has() { command -v "$1" >/dev/null 2>&1 && echo yes || echo no; }

ask "surveyed_at" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
ask "operating_system" "$( (. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME") || uname -s)"
ask "kernel" "$(uname -r)"
ask "cpu_architecture" "$(uname -m)"
ask "cpu_cores" "$(nproc 2>/dev/null)"
ask "ram_total_mb" "$(awk '/MemTotal/{printf "%d", $2/1024}' /proc/meminfo 2>/dev/null)"
ask "disk_root" "$(df -h / 2>/dev/null | awk 'NR==2{print $2" total, "$4" free"}')"
ask "is_root" "$([ "$(id -u)" -eq 0 ] && echo yes || echo no)"
ask "systemd" "$([ -d /run/systemd/system ] && echo yes || echo no)"
ask "docker" "$(has docker)"
ask "docker_version" "$(docker --version 2>/dev/null | sed 's/,.*//')"
ask "compose" "$(docker compose version --short 2>/dev/null)"
ask "podman" "$(has podman)"
ask "cron" "$(has crontab)"
ask "node_version" "$(node --version 2>/dev/null)"
ask "reverse_proxy" "$( { has nginx; } | grep -q yes && echo nginx || { command -v caddy >/dev/null && echo caddy || echo none; } )"
ask "egress" "$(curl -s -o /dev/null -m 8 -w '%{http_code}' https://api.github.com 2>/dev/null)"
ask "listening_ports" "$( (ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null) | awk 'NR>1{print $4}' | tr '\n' ' ')"
ask "max_open_files" "$(ulimit -n)"
ask "max_user_processes" "$(ulimit -u)"
