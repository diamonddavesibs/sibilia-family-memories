#!/usr/bin/env python3
"""Build the Sibilia Family Memories site.

Reads events.json, takes photos from the old site folder (never changed),
writes web-sized copies and the HTML pages into the output folder.

    python build.py --source "M:/Sibilia.us/sibilia.us" --out dist

Needs Python 3 and Pillow (pip install pillow).
"""
import argparse
import html
import json
import shutil
from pathlib import Path

from PIL import Image, ImageOps

ROOT = Path(__file__).resolve().parent
COVER_SIZE = (800, 600)
HERO_SIZE = 640


def esc(s):
    return html.escape(str(s), quote=True)


def save_jpeg(src, dest, size, crop=False):
    dest.parent.mkdir(parents=True, exist_ok=True)
    with Image.open(src) as im:
        im = ImageOps.exif_transpose(im).convert("RGB")
        if crop:
            im = ImageOps.fit(im, size, Image.LANCZOS)
        else:
            im.thumbnail((size, size), Image.LANCZOS)
        im.save(dest, "JPEG", quality=82, optimize=True, progressive=True)


def event_label(ev):
    return f"{ev['title']} {ev['year']}" if ev.get("year") else ev["title"]


def card(ev):
    year = f'<span class="card-year">{esc(ev["year"])}</span>' if ev.get("year") else ""
    return f"""
      <a class="card" href="events/{esc(ev['id'])}/">
        <div class="card-photo"><img src="covers/{esc(ev['id'])}.jpg" alt="{esc(event_label(ev))}" loading="lazy" width="800" height="600"></div>
        <div class="card-body">
          {year}
          <h3>{esc(ev['title'])}</h3>
          <p>{esc(ev['photos'])} photos</p>
        </div>
      </a>"""


def sort_key(ev):
    return (ev.get("year") is None, ev.get("year") or 0, ev["title"])


def build_index(data, out):
    site = data["site"]
    hero = "".join(
        f'<img class="polaroid p{i}" src="hero/{i}.jpg" alt="" width="{HERO_SIZE}">'
        for i in range(len(data["hero"]))
    )
    nav = "".join(
        f'<a href="#{esc(c["id"])}">{esc(c["title"].replace("The Sibilia 21st Century ", ""))}</a>'
        for c in data["categories"]
        if any(e["category"] == c["id"] for e in data["events"])
    )
    sections = []
    for cat in data["categories"]:
        evs = sorted((e for e in data["events"] if e["category"] == cat["id"]), key=sort_key)
        if not evs:
            continue
        sections.append(f"""
    <section class="category" id="{esc(cat['id'])}">
      <h2>{esc(cat['title'])}</h2>
      <div class="grid">{''.join(card(e) for e in evs)}
      </div>
    </section>""")
    total = sum(e["photos"] for e in data["events"])
    page = (ROOT / "templates" / "index.html").read_text(encoding="utf-8")
    page = (page.replace("{{title}}", esc(site["title"]))
                .replace("{{tagline}}", esc(site["tagline"]))
                .replace("{{hero}}", hero)
                .replace("{{nav}}", nav)
                .replace("{{sections}}", "".join(sections))
                .replace("{{events_count}}", str(len(data["events"])))
                .replace("{{photos_count}}", f"{total:,}"))
    (out / "index.html").write_text(page, encoding="utf-8")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--source", required=True, help="the old sibilia.us folder")
    ap.add_argument("--out", default="dist")
    args = ap.parse_args()
    src, out = Path(args.source), Path(args.out)
    data = json.loads((ROOT / "events.json").read_text(encoding="utf-8"))

    out.mkdir(parents=True, exist_ok=True)
    shutil.copytree(ROOT / "assets", out / "assets", dirs_exist_ok=True)

    for i, rel in enumerate(data["hero"]):
        save_jpeg(src / rel, out / "hero" / f"{i}.jpg", HERO_SIZE)
    for ev in data["events"]:
        cover = src / ev["folder"] / ev["cover"]
        if cover.exists():
            save_jpeg(cover, out / "covers" / f"{ev['id']}.jpg", COVER_SIZE, crop=True)
        else:
            print(f"missing cover for {ev['id']}: {cover}")
    build_index(data, out)
    print(f"Built {len(data['events'])} events into {out}")


if __name__ == "__main__":
    main()
