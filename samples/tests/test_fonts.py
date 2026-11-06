"""Fonts must resolve the same way on Linux, macOS and Windows: bundled first, never only a Linux system path."""
from __future__ import annotations

import sys
from pathlib import Path

import pytest
from PIL import ImageFont

REPO = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(REPO))

from samples.generator import render_id as R  # noqa: E402

NEEDED = ["LiberationSans-Regular.ttf", "LiberationSans-Bold.ttf", "LiberationMono-Bold.ttf"]


def used_font_names() -> set[str]:
    import re
    names = set()
    for p in (REPO / "samples" / "generator").glob("*.py"):
        names |= set(re.findall(r'"(Liberation[A-Za-z]+-[A-Za-z]+\.ttf)"', p.read_text(encoding="utf-8")))
    return names


def test_every_font_the_generator_uses_is_bundled():
    assert used_font_names() <= set(NEEDED) | {p.name for p in R.BUNDLED_FONT_DIR.glob("*.ttf")}
    for n in NEEDED:
        assert (R.BUNDLED_FONT_DIR / n).is_file(), n
        assert ImageFont.truetype(str(R.BUNDLED_FONT_DIR / n), 20).getlength("SAMPLE 0123") > 20


def test_license_ships_with_the_fonts():
    text = (R.BUNDLED_FONT_DIR / "LICENSE-Liberation-OFL.txt").read_text(encoding="utf-8")
    assert "SIL OPEN FONT LICENSE" in text.upper()


@pytest.mark.parametrize("name", NEEDED)
def test_found_with_no_system_fonts_and_no_env(monkeypatch, name):
    monkeypatch.delenv("TRACEDOCS_FONT_DIR", raising=False)
    monkeypatch.setattr(R, "SYSTEM_FONT_DIRS", ())
    assert R.find_font(name) == R.BUNDLED_FONT_DIR / name


def test_bundled_fonts_win_over_system_fonts(monkeypatch, tmp_path):
    monkeypatch.delenv("TRACEDOCS_FONT_DIR", raising=False)
    (tmp_path / NEEDED[0]).write_bytes(b"not a font")
    monkeypatch.setattr(R, "SYSTEM_FONT_DIRS", (tmp_path,))
    assert R.find_font(NEEDED[0]).parent == R.BUNDLED_FONT_DIR, "output must not depend on whichever fonts a machine has"


def test_explicit_override_wins(monkeypatch, tmp_path):
    (tmp_path / NEEDED[0]).write_bytes((R.BUNDLED_FONT_DIR / NEEDED[0]).read_bytes())
    monkeypatch.setenv("TRACEDOCS_FONT_DIR", str(tmp_path))
    assert R.find_font(NEEDED[0]).parent == tmp_path


def test_missing_font_is_a_clear_error_not_a_system_exit(monkeypatch):
    monkeypatch.delenv("TRACEDOCS_FONT_DIR", raising=False)
    with pytest.raises(FileNotFoundError, match="NoSuchFont.ttf.*samples/generator/fonts"):
        R.find_font("NoSuchFont.ttf")
