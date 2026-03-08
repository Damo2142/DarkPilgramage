#!/usr/bin/env python3
"""
Whisper transcription worker for Dark Pilgrimage Co-DM.
Uses faster-whisper on CPU with int8 quantization.

Protocol:
  IN  (stdin):  { "cmd": "transcribe", "player": "marcus", "audio_b64": "...", "seq": 1 }
  OUT (stdout): { "cmd": "result", "player": "marcus", "text": "...", "seq": 1 }

Audio format: 16-bit PCM, 16kHz, mono, base64-encoded
"""

import sys
import json
import base64
import numpy as np
import os
import time

os.environ["KMP_DUPLICATE_LIB_OK"] = "TRUE"
import warnings
warnings.filterwarnings("ignore")

SAMPLE_RATE = 16000
MIN_AUDIO_SECONDS = float(os.environ.get("MIN_AUDIO_SECONDS", "4.0"))

def log(msg):
    print(f"[whisper-worker] {msg}", file=sys.stderr, flush=True)

def pcm_to_float(raw_bytes):
    """Convert raw PCM bytes to float32 array, handling odd byte counts"""
    if len(raw_bytes) % 2 != 0:
        raw_bytes = raw_bytes[:len(raw_bytes) - 1]
    return np.frombuffer(raw_bytes, dtype=np.int16).astype(np.float32) / 32768.0

def main():
    model_size = os.environ.get("WHISPER_MODEL", "base.en")
    threads = int(os.environ.get("WHISPER_THREADS", "4"))

    log(f"Starting whisper worker (faster-whisper, model: {model_size}, threads: {threads})...")

    from faster_whisper import WhisperModel

    model = WhisperModel(
        model_size,
        device="cpu",
        compute_type="int8",
        cpu_threads=threads
    )
    log(f"Model loaded: {model_size}")

    # Send ready signal
    print(json.dumps({"cmd": "ready", "model": model_size, "vad": True}), flush=True)
    log("Ready. Waiting for audio...")

    # Per-player audio buffers
    buffers = {}  # player -> list of raw PCM bytes

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        try:
            msg = json.loads(line)
        except json.JSONDecodeError:
            log(f"Bad JSON: {line[:100]}")
            continue

        cmd = msg.get("cmd")

        if cmd == "transcribe":
            player = msg.get("player", "unknown")
            audio_b64 = msg.get("audio_b64", "")
            seq = msg.get("seq", 0)

            if not audio_b64:
                continue

            try:
                raw_pcm = base64.b64decode(audio_b64)
            except Exception as e:
                log(f"Base64 decode error from {player}: {e}")
                continue

            # Accumulate
            if player not in buffers:
                buffers[player] = []
            buffers[player].append(raw_pcm)

            total_bytes = sum(len(c) for c in buffers[player])
            total_seconds = total_bytes / 2 / SAMPLE_RATE

            if total_seconds < MIN_AUDIO_SECONDS:
                continue

            # Combine and convert to float32
            combined = b"".join(buffers[player])
            buffers[player] = []

            audio = pcm_to_float(combined)

            # Transcribe
            start_time = time.time()
            try:
                segments, info = model.transcribe(
                    audio,
                    language="en",
                    beam_size=3,
                    best_of=3,
                    vad_filter=True,
                    vad_parameters=dict(
                        min_silence_duration_ms=300,
                        speech_pad_ms=200
                    )
                )

                results = []
                total_logprob = 0
                count = 0
                for segment in segments:
                    text = segment.text.strip()
                    if text:
                        # Filter whisper artifacts
                        lower = text.lower()
                        if any(a in lower for a in [
                            "[blank_audio]", "(silence)", "[music]",
                            "(inaudible)", "[noise]", "thank you",
                            "thanks for watching", "subscribe"
                        ]):
                            continue
                        results.append(text)
                        total_logprob += segment.avg_logprob
                        count += 1

                elapsed = time.time() - start_time
                full_text = " ".join(results).strip()

                if full_text:
                    confidence = min(1.0, max(0.0, 1.0 + (total_logprob / count))) if count > 0 else 0.5
                    output = json.dumps({
                        "cmd": "result",
                        "player": player,
                        "text": full_text,
                        "confidence": round(confidence, 3),
                        "language": "en",
                        "seq": seq,
                        "processing_ms": int(elapsed * 1000),
                        "audio_duration_ms": int(total_seconds * 1000)
                    })
                    print(output, flush=True)
                    log(f"[{player}] ({int(elapsed*1000)}ms) {full_text[:80]}")
                else:
                    print(json.dumps({"cmd": "empty", "player": player, "seq": seq}), flush=True)

            except Exception as e:
                log(f"Transcription error: {e}")
                print(json.dumps({"cmd": "empty", "player": player, "seq": seq}), flush=True)

        elif cmd == "flush":
            player = msg.get("player", "unknown")
            if player in buffers and buffers[player]:
                combined = b"".join(buffers[player])
                buffers[player] = []

                total_seconds = len(combined) / 2 / SAMPLE_RATE
                if total_seconds >= 1.0:
                    audio = pcm_to_float(combined)
                    try:
                        segments, _ = model.transcribe(audio, language="en", beam_size=1, vad_filter=True)
                        text = " ".join(s.text.strip() for s in segments if s.text.strip())
                        if text:
                            print(json.dumps({
                                "cmd": "result",
                                "player": player,
                                "text": text,
                                "confidence": 0.7,
                                "seq": msg.get("seq", 0)
                            }), flush=True)
                    except Exception as e:
                        log(f"Flush transcription error: {e}")

        elif cmd == "ping":
            print(json.dumps({"cmd": "pong"}), flush=True)

        elif cmd == "shutdown":
            log("Shutdown requested")
            break

    log("Worker exiting")

if __name__ == "__main__":
    main()