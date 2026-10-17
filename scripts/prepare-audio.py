#!/usr/bin/env python3
"""Prepare a local MP3 without changing its source or publishing anything."""

import argparse
import json
import math
from pathlib import Path
import re
import shutil
import subprocess
import tempfile


def ffmpeg(*args):
    result = subprocess.run(
        ["ffmpeg", "-nostdin", "-hide_banner", "-threads", "1", *map(str, args)],
        capture_output=True, text=True, check=True,
    )
    return result.stderr


def leading_trim(log):
    # silencedetect checks all channels together. Only trim a silent interval
    # that begins at zero; an intentional pause after a note is never removed.
    events = re.findall(r"silence_(start|end): ([\d.eE+-]+)", log)
    if len(events) < 2 or events[0][0] != "start":
        return 0.0
    if float(events[0][1]) > 0.001 or events[1][0] != "end":
        return 0.0
    end = float(events[1][1])
    return max(0.0, end - 0.08) if end >= 0.3 else 0.0


def measure(source, trim=0):
    log = ffmpeg(
        "-i", source, "-map", "0:a:0", "-vn", "-af",
        f"atrim=start={trim:.6f},asetpts=PTS-STARTPTS,"
        "ebur128=peak=true:framelog=verbose",
        "-f", "null", "-",
    )
    summary = log.rsplit("Summary:", 1)[-1]
    fields = {
        "input_i": r"I:\s+([-\w.]+) LUFS",
        "input_tp": r"Peak:\s+([-\w.]+) dBFS",
        "input_lra": r"LRA:\s+([-\w.]+) LU",
    }
    matches = {key: re.search(pattern, summary) for key, pattern in fields.items()}
    if not all(matches.values()):
        raise ValueError("FFmpeg did not report loudness")
    result = {key: float(match[1]) for key, match in matches.items()}
    if not all(math.isfinite(value) for value in result.values()):
        raise ValueError("Audio is silent or cannot be measured safely")
    return result


def gain_for(stats, target, max_gain_db=12.0):
    # A single constant gain preserves musical dynamics. Peak headroom wins
    # over the target; never fall back to loudnorm's dynamic compression.
    return min(target - stats["input_i"], -2.0 - stats["input_tp"], max_gain_db)


def leveling_plan(stats, target, enabled, max_gain_db=12.0):
    baseline = gain_for(stats, target, max_gain_db)
    ceiling = -2.2  # Extra codec headroom; still verify the encoded true peak.
    gain = min(target - stats["input_i"], max_gain_db,
               ceiling - stats["input_tp"] + 3.0)
    # Only process peak-limited outliers. Tracks already matching the target,
    # or limited by the configured gain cap, keep the constant-gain path.
    apply = enabled and stats["input_i"] + baseline < target - 0.5 and gain > baseline + 0.5
    return (gain, ceiling) if apply else (baseline, None)


def render_filter(trim, gain, limiter_ceiling=None):
    filters = f"atrim=start={trim:.6f},asetpts=PTS-STARTPTS,volume={gain:.6f}dB"
    if limiter_ceiling is not None:
        limit = 10 ** (limiter_ceiling / 20)
        # Oversample before lookahead limiting; compensate delay and flush the
        # lookahead buffer so neither opening timing nor the ending is lost.
        filters += (f",aresample=192000,alimiter=limit={limit:.9f}:attack=5:release=100"
                    ":level=false:latency=true,aresample=48000")
    return filters


def prepare(source, output, target=-24.0, silence_threshold_db=-60.0, trim_seconds=None, gentle_leveling=False, max_gain_db=12.0):
    source, output = Path(source).resolve(), Path(output).resolve()
    if not math.isfinite(target) or not -30 <= target <= -14:
        raise ValueError("Target must be between -30 and -14 LUFS")
    if not math.isfinite(max_gain_db) or not 0 <= max_gain_db <= 24:
        raise ValueError("Maximum gain must be between 0 and 24 dB")
    if not math.isfinite(silence_threshold_db) or not -90 <= silence_threshold_db <= -20:
        raise ValueError("Silence threshold must be between -90 and -20 dB")
    if trim_seconds is not None and (not math.isfinite(trim_seconds) or trim_seconds < 0):
        raise ValueError("Explicit trim must be a finite non-negative number of seconds")
    if source == output or output.exists():
        raise ValueError("Output must be a new file; originals are never overwritten")
    if output.suffix.lower() != ".mp3":
        raise ValueError("Output must have an .mp3 extension")
    if not source.is_file():
        raise ValueError("Source file does not exist")
    # Analyze the whole file, so an unusually long blank introduction is also
    # handled. A conservative -60 dB threshold protects soft classical entries.
    silence = ffmpeg("-i", source, "-map", "0:a:0", "-vn", "-af",
                     f"silencedetect=noise={silence_threshold_db}dB:d=0.15", "-f", "null", "-")
    trim = leading_trim(silence) if trim_seconds is None else trim_seconds
    warnings = []
    events = re.findall(r"silence_(start|end): ([\d.eE+-]+)", silence)
    if (trim_seconds is None and trim == 0 and len(events) >= 2 and events[0][0] == "start"
            and events[1][0] == "end" and float(events[0][1]) <= 0.5
            and float(events[1][1]) - float(events[0][1]) >= 1):
        warnings.append("Long opening silence follows a short sound; inspect for an initial noise blip before choosing a higher silence threshold.")
    before = measure(source, trim)
    gain, limiter_ceiling = leveling_plan(before, target, gentle_leveling, max_gain_db)
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="audio-prepare-", dir=output.parent) as directory:
        temporary = Path(directory) / "prepared.mp3"
        for _ in range(3):
            ffmpeg("-y", "-i", source, "-map", "0:a:0", "-vn", "-map_metadata", "0",
                   "-af", render_filter(trim, gain, limiter_ceiling),
                   "-c:a", "libmp3lame", "-q:a", "0", temporary)
            after = measure(temporary)
            # Recheck the encoded MP3, since lossy encoding can raise true peaks.
            if after["input_tp"] <= -1.9:
                break
            correction = after["input_tp"] + 2.1
            if limiter_ceiling is None:
                gain -= correction
            else:
                limiter_ceiling -= correction
                gain = min(gain, limiter_ceiling - before["input_tp"] + 3.0)
        else:
            raise ValueError("Encoded output could not meet the true-peak ceiling")
        # Exclusive creation also prevents accidentally replacing an output
        # created by another process while FFmpeg was running.
        with output.open("xb") as destination, temporary.open("rb") as prepared:
            shutil.copyfileobj(prepared, destination)
    return {
        "source": str(source), "output": str(output),
        "trim_seconds": round(trim, 6), "trim_method": "detected" if trim_seconds is None else "explicit",
        "gain_db": round(gain, 3),
        "max_gain_db": max_gain_db,
        "target_lufs": target, "silence_threshold_db": silence_threshold_db,
        "warnings": warnings, "before": before, "after": after,
        "peak_limited": after["input_i"] < target - 0.5,
        "gentle_leveling_requested": gentle_leveling,
        "processing": "gentle_peak_limiting" if limiter_ceiling is not None else "constant_gain",
        "limiter_ceiling_dbfs": limiter_ceiling,
        "estimated_peak_reduction_db": round(max(0, before["input_tp"] + gain - limiter_ceiling), 3) if limiter_ceiling is not None else 0,
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--file", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--target-lufs", type=float, default=-24.0)
    parser.add_argument("--max-gain-db", type=float, default=12.0,
                        help="Maximum boost (0 to 24 dB); raise only for an inspected quiet source. Peak protection remains active.")
    parser.add_argument("--silence-threshold-db", type=float, default=-60.0,
                        help="Silence threshold in dB (-90 to -20); raise only after inspecting the opening")
    parser.add_argument("--trim-seconds", type=float,
                        help="Exact inspected cut from the start, including any desired cushion; overrides silence detection")
    parser.add_argument("--gentle-leveling", action="store_true",
                        help="Use up to 3 dB of peak limiting only when constant gain misses the loudness target")
    args = parser.parse_args()
    try:
        print(json.dumps(prepare(args.file, args.output, args.target_lufs, args.silence_threshold_db, args.trim_seconds, args.gentle_leveling, args.max_gain_db), indent=2))
    except (ValueError, OSError, subprocess.CalledProcessError) as error:
        parser.exit(1, f"Audio preparation failed: {error}\n")
