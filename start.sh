#!/bin/bash
export GEMINI_API_KEY=AIzaSyDqt2d0V3HtBIWUyI5MgcrSXEj7jLBy4ek
export ELEVENLABS_API_KEY=sk_8d958d18f23dce4eedfaefebb7b0bbb5d9e0d9b2b8c20c6a
export DDB_COBALT_TOKEN="eyJhbGciOiJkaXliLCJlbmMiOiJBMTI4Q0JDLUhTMjU2In0..RAdzbU0QhZx6iBNyhcB-Hw.5U2Njebk9IkeV-XibcLyDIwPE8mqdzXLFns_Q0DfX2CXsvp72UFkX047-TUxcMpi.Av-CDgS_m04vqNRPZE9WYA"
export MAX_VOICE_ID=766NdLzxBMJanRvWXtkt
export VOICE_M1=HE0g1qPuEgQIhQacIWKd
export VOICE_M2=yhf80q1381zd2JJQ4tM7
export VOICE_M3=JjsQrIrIBD6TZ656NQfi
export VOICE_F1=1Z7qQDyqapTm8qBfJx6e
export VOICE_F2=nDJIICjR9zfJExIFeSCN
export VOICE_F3=SpA6eNczAK7oucJPiPpw
export WHISPER_MODEL=base.en
export WHISPER_THREADS=4
cd ~/dark-pilgrimage/co-dm

# FIX-B9 — start watchdog in the background if not already running.
# It probes /health every 10s and restarts the server after 3 failed probes.
if ! pgrep -f "watchdog.sh" > /dev/null; then
  ~/dark-pilgrimage/watchdog.sh >> ~/dark-pilgrimage/watchdog.log 2>&1 &
  echo "[start.sh] Watchdog launched (pid $!)"
fi

node server.js config/session-0.json
