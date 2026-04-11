#!/bin/bash
# Co-DM watchdog — auto-restarts the server if /health stops responding.
# Started in the background by start.sh; logs to ~/dark-pilgrimage/watchdog.log
#
# Strategy: probe https://localhost:3200/health every 10s. After 3 consecutive
# failures (~30s) attempt a restart. If the container is the running form,
# `docker compose restart` is preferred so we don't double-launch.

LOG=~/dark-pilgrimage/watchdog.log
HEALTH_URL=https://localhost:3200/health
FAIL_COUNT=0
FAIL_THRESHOLD=3

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $*" >> "$LOG"; }

restart_server() {
  log "Server unhealthy after $FAIL_COUNT failed probes — attempting restart"
  if command -v docker >/dev/null 2>&1 && docker compose -f ~/dark-pilgrimage/co-dm/docker-compose.yml ps 2>/dev/null | grep -q "co-dm"; then
    log "Docker container detected — running 'docker compose restart'"
    (cd ~/dark-pilgrimage/co-dm && docker compose restart >> "$LOG" 2>&1)
  elif [ -x ~/dark-pilgrimage/start.sh ]; then
    log "No Docker container — relaunching via start.sh"
    pkill -f "node server.js" 2>/dev/null
    sleep 2
    nohup ~/dark-pilgrimage/start.sh > ~/dark-pilgrimage/server.log 2>&1 &
  else
    log "No restart strategy available — investigate manually"
  fi
  sleep 30
  FAIL_COUNT=0
}

log "Watchdog started (pid $$) — probing $HEALTH_URL every 10s"

while true; do
  if curl -sk --max-time 5 "$HEALTH_URL" > /dev/null 2>&1; then
    if [ $FAIL_COUNT -ne 0 ]; then
      log "Server recovered after $FAIL_COUNT failed probes"
    fi
    FAIL_COUNT=0
  else
    FAIL_COUNT=$((FAIL_COUNT + 1))
    log "Probe failed ($FAIL_COUNT/$FAIL_THRESHOLD)"
    if [ $FAIL_COUNT -ge $FAIL_THRESHOLD ]; then
      restart_server
    fi
  fi
  sleep 10
done
