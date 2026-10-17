import importlib.util
from array import array
from pathlib import Path
import json
import shutil
import subprocess
import tempfile
import unittest

spec = importlib.util.spec_from_file_location(
    "prepare_audio", Path(__file__).resolve().parents[1] / "scripts/prepare-audio.py"
)
audio = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audio)


class AudioPreparationTests(unittest.TestCase):
    def test_preserves_short_lead_in_and_internal_pauses(self):
        self.assertEqual(audio.leading_trim("silence_start: 0\nsilence_end: 0.2"), 0)
        self.assertEqual(audio.leading_trim("silence_start: 3\nsilence_end: 9"), 0)
        self.assertEqual(audio.leading_trim("silence_start: 0"), 0)

    def test_trims_only_initial_silence_with_cushion(self):
        self.assertAlmostEqual(audio.leading_trim(
            "silence_start: 0\nsilence_end: 4.2\nsilence_start: 8\nsilence_end: 12"
        ), 4.12)

    def test_peak_ceiling_and_gain_cap_take_precedence(self):
        self.assertEqual(audio.gain_for({"input_i": -24, "input_tp": -3}, -18), 1)
        self.assertEqual(audio.gain_for({"input_i": -21, "input_tp": -9}, -18), 3)
        self.assertEqual(audio.gain_for({"input_i": -50, "input_tp": -30}, -18), 12)
        self.assertEqual(audio.gain_for({"input_i": -12, "input_tp": -1}, -18), -6)

    def test_leveling_is_optional_and_bounded(self):
        peak_limited = {"input_i": -28.3, "input_tp": -5.1}
        self.assertEqual(audio.leveling_plan(peak_limited, -24, False),
                         (audio.gain_for(peak_limited, -24), None))
        for stats in [{"input_i": -28, "input_tp": -10},
                      {"input_i": -50, "input_tp": -30}]:
            self.assertEqual(audio.leveling_plan(stats, -24, True),
                             (audio.gain_for(stats, -24), None))
        for stats in [peak_limited, {"input_i": -45, "input_tp": -1}]:
            gain, ceiling = audio.leveling_plan(stats, -24, True)
            self.assertIsNotNone(ceiling)
            self.assertLessEqual(gain, 12)
            self.assertLessEqual(stats["input_tp"] + gain - ceiling, 3.00001)

    def test_inspected_gain_override_keeps_peak_protection(self):
        self.assertEqual(audio.gain_for({"input_i": -41, "input_tp": -19.5}, -24, 18), 17)
        self.assertEqual(audio.gain_for({"input_i": -41, "input_tp": -10}, -24, 18), 8)
        gain, ceiling = audio.leveling_plan({"input_i": -41, "input_tp": -10}, -24, True, 18)
        self.assertLessEqual(-10 + gain - ceiling, 3.00001)
        for invalid in [-1, 25, float("nan"), float("inf")]:
            with self.assertRaisesRegex(ValueError, "Maximum gain"):
                audio.prepare("unused.wav", "unused.mp3", max_gain_db=invalid)

    @unittest.skipUnless(shutil.which("ffmpeg"), "Requires FFmpeg")
    def test_inspected_quiet_source_reaches_target_without_changing_duration(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "quiet.wav"
            output = Path(directory) / "prepared.mp3"
            audio.ffmpeg("-f", "lavfi", "-i", "sine=frequency=440:duration=3",
                         "-af", "volume=-20dB", source)
            original = source.read_bytes()
            report = audio.prepare(source, output, trim_seconds=0, max_gain_db=24)
            self.assertGreater(report["gain_db"], 12)
            self.assertAlmostEqual(report["after"]["input_i"], -24, delta=0.3)
            self.assertLessEqual(report["after"]["input_tp"], -1.9)
            self.assertEqual(report["processing"], "constant_gain")
            decoded = subprocess.check_output([
                "ffmpeg", "-v", "error", "-i", str(output), "-ar", "48000",
                "-ac", "1", "-f", "f32le", "-"
            ])
            self.assertAlmostEqual(len(decoded) / 4 / 48000, 3, delta=0.001)
            self.assertEqual(source.read_bytes(), original)

    @unittest.skipUnless(shutil.which("ffmpeg"), "Requires FFmpeg")
    def test_leveling_improves_outlier_without_adding_delay_or_losing_ending(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "transients.wav"
            output = Path(directory) / "leveled.mp3"
            # Soft sustained music with brief louder attacks, including one
            # at the very end to exercise the limiter's lookahead flushing.
            audio.ffmpeg("-f", "lavfi", "-i",
                         "aevalsrc=if(between(t\\,2\\,2.006)+gt(t\\,7.994)\\,0.42\\,0.04)*sin(2*PI*440*t):s=48000:d=8",
                         source)
            original = source.read_bytes()
            baseline = audio.prepare(source, Path(directory) / "baseline.mp3", trim_seconds=0)
            report = audio.prepare(source, output, trim_seconds=0, gentle_leveling=True)
            self.assertEqual(report["processing"], "gentle_peak_limiting")
            self.assertGreater(report["after"]["input_i"], baseline["after"]["input_i"] + 0.5)
            self.assertAlmostEqual(report["after"]["input_i"], -24, delta=0.4)
            self.assertLessEqual(report["after"]["input_tp"], -1.9)
            self.assertLessEqual(report["estimated_peak_reduction_db"], 3)
            decoded = array("f", subprocess.check_output([
                "ffmpeg", "-v", "error", "-i", str(output), "-ar", "48000",
                "-ac", "1", "-f", "f32le", "-"
            ]))
            self.assertAlmostEqual(len(decoded) / 48000, 8, delta=0.001)
            self.assertGreater(max(abs(x) for x in decoded[:240]), 0.04)
            self.assertGreater(max(abs(x) for x in decoded[-240:]), 0.3)
            self.assertEqual(source.read_bytes(), original)

    @unittest.skipUnless(shutil.which("ffmpeg") and shutil.which("ffprobe"), "Requires FFmpeg")
    def test_real_encoding_preserves_notes_internal_pause_and_original(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "source.wav"
            output = Path(directory) / "output.mp3"
            # Only the right channel plays; silence on the left cannot cause
            # an audible entry to be cut. The second gap must remain intact.
            audio.ffmpeg("-f", "lavfi", "-i",
                         "aevalsrc=0|if(between(t\,2\,3)+between(t\,4\,5)\,0.1*sin(2*PI*440*t)\,0):s=44100:d=5.5",
                         source)
            original = source.read_bytes()
            report = audio.prepare(source, output)
            self.assertAlmostEqual(report["trim_seconds"], 1.92, places=2)
            self.assertLessEqual(report["after"]["input_tp"], -1.9)
            self.assertAlmostEqual(report["after"]["input_i"], -24, delta=0.3)
            probe = subprocess.check_output([
                "ffprobe", "-v", "error", "-show_entries", "format=duration",
                "-of", "json", str(output)
            ], text=True)
            self.assertAlmostEqual(float(json.loads(probe)["format"]["duration"]), 3.58, delta=0.1)
            gaps = audio.ffmpeg("-i", output, "-af", "silencedetect=noise=-50dB:d=0.5", "-f", "null", "-")
            self.assertIn("silence_start: 1.", gaps)
            self.assertEqual(source.read_bytes(), original)
            with self.assertRaises(ValueError):
                audio.prepare(source, output)

    @unittest.skipUnless(shutil.which("ffmpeg"), "Requires FFmpeg")
    def test_initial_noise_blip_warns_and_inspected_threshold_trims_it(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "blip.wav"
            # A low-level opening blip, then silence, then a real musical entry.
            audio.ffmpeg("-f", "lavfi", "-i",
                         "aevalsrc=if(lt(t\\,0.12)\\,0.003*sin(2*PI*90*t)\\,if(gt(t\\,2)\\,0.1*sin(2*PI*440*t)\\,0)):s=44100:d=4",
                         source)
            conservative = audio.prepare(source, Path(directory) / "default.mp3")
            self.assertEqual(conservative["trim_seconds"], 0)
            self.assertTrue(conservative["warnings"])
            inspected = audio.prepare(source, Path(directory) / "inspected.mp3",
                                      silence_threshold_db=-40)
            self.assertAlmostEqual(inspected["trim_seconds"], 1.92, places=2)
            self.assertEqual(inspected["warnings"], [])
            self.assertLessEqual(inspected["after"]["input_tp"], -1.9)

    @unittest.skipUnless(shutil.which("ffmpeg"), "Requires FFmpeg")
    def test_explicit_inspected_cut_removes_loud_blip_without_changing_later_music(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "loud-blip.wav"
            audio.ffmpeg("-f", "lavfi", "-i",
                         "aevalsrc=if(lt(t\\,0.12)\\,0.7*sin(2*PI*90*t)\\,if(gt(t\\,2)\\,0.1*sin(2*PI*440*t)\\,0)):s=44100:d=4",
                         source)
            original = source.read_bytes()
            report = audio.prepare(source, Path(directory) / "cut.mp3", trim_seconds=1.92)
            self.assertEqual(report["trim_seconds"], 1.92)
            self.assertEqual(report["trim_method"], "explicit")
            self.assertAlmostEqual(report["after"]["input_i"], -24, delta=0.3)
            self.assertEqual(source.read_bytes(), original)
            for invalid in [-1, float("nan"), float("inf")]:
                with self.assertRaisesRegex(ValueError, "Explicit trim"):
                    audio.prepare(source, Path(directory) / "invalid.mp3", trim_seconds=invalid)

    def test_invalid_silence_threshold_is_rejected(self):
        for threshold in [-100, -10, float("nan"), float("inf")]:
            with self.assertRaisesRegex(ValueError, "Silence threshold"):
                audio.prepare("unused.wav", "unused.mp3", silence_threshold_db=threshold)

    @unittest.skipUnless(shutil.which("ffmpeg"), "Requires FFmpeg")
    def test_all_silent_file_is_rejected(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "silence.wav"
            output = Path(directory) / "output.mp3"
            audio.ffmpeg("-f", "lavfi", "-i", "anullsrc=r=44100:cl=stereo", "-t", "2", source)
            with self.assertRaisesRegex(ValueError, "silent"):
                audio.prepare(source, output)
            self.assertFalse(output.exists())


if __name__ == "__main__":
    unittest.main()
