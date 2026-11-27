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
import re
import shutil
from pathlib import Path

from PIL import Image, ImageOps

ROOT = Path(__file__).resolve().parent
COVER_SIZE = (800, 600)
HERO_SIZE = 640
PHOTO_SIZE = 1600
THUMB_SIZE = (400, 300)
PHOTO_EXT = (".jpg", ".jpeg", ".png")
# Old page titles that are not real captions.
GENERIC_TITLE = re.compile(
    r"^(new page|untitled|page title|this is the page|\d+[-_ ]?\d*|"
    r"(4th|fourth) of july.*|bobby & jenny.*|rose's 40th.*|helen|"
    r"thanksgiving.*|halloween.*|.*picnic.*|baltimore.*|uncle eddie|helen pix\d*)$",
    re.I,
)


def esc(s):
    return html.escape(str(s), quote=True)


def natural_key(name):
    return [int(t) if t.isdigit() else t.lower() for t in re.split(r"(\d+)", name)]


def save_jpeg(src, dest, size, crop=False):
    dest.parent.mkdir(parents=True, exist_ok=True)
    if dest.exists() and dest.stat().st_mtime >= src.stat().st_mtime:
        return
    with Image.open(src) as im:
        im = ImageOps.exif_transpose(im).convert("RGB")
        if crop:
            im = ImageOps.fit(im, size, Image.LANCZOS)
        else:
            im.thumbnail((size, size), Image.LANCZOS)
        im.save(dest, "JPEG", quality=82, optimize=True, progressive=True)


def find_photos(folder, min_size):
    """Full-size photos directly in the folder, in natural order."""
    photos = []
    for f in sorted(folder.iterdir(), key=lambda p: natural_key(p.name)):
        if not f.is_file() or f.suffix.lower() not in PHOTO_EXT:
            continue
        try:
            with Image.open(f) as im:
                if max(im.size) < min_size or min(im.size) < min_size * 0.5:
                    continue
        except Exception:
            continue
        photos.append(f)
    return photos


def find_captions(folder):
    """Captions from the old one-photo-per-page HTML files: {image name: title}."""
    captions = {}
    for page in folder.glob("*.htm*"):
        text = page.read_text(encoding="latin-1", errors="ignore")
        imgs = re.findall(r'<img[^>]+src="([^"]+)"', text, re.I)
        title = re.search(r"<title>([^<]*)", text, re.I)
        if len(imgs) != 1 or not title:
            continue
        cap = html.unescape(title.group(1)).replace("\xa0", " ").strip()
        cap = re.sub(r"\s+", " ", cap)
        cap = re.sub(r",(?=\S)", ", ", cap)
        if cap and not GENERIC_TITLE.match(cap):
            captions[Path(imgs[0]).name.lower()] = cap
    return captions


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


def build_event(ev, src, out, data):
    folder = src / ev["folder"]
    if not folder.is_dir():
        print(f"missing folder for {ev['id']}: {folder}")
        return
    photos = find_photos(folder, ev.get("minSize", 400))
    captions = find_captions(folder)
    dest = out / "events" / ev["id"]
    items = []
    for i, f in enumerate(photos, 1):
        name = f"{i:03d}.jpg"
        save_jpeg(f, dest / "photos" / name, PHOTO_SIZE)
        save_jpeg(f, dest / "thumbs" / name, THUMB_SIZE, crop=True)
        cap = captions.get(f.name.lower(), "")
        items.append((name, cap))
    ev["photos"] = len(items)

    tiles = "".join(
        f'''
      <a class="tile" href="photos/{n}" data-caption="{esc(c)}"><img src="thumbs/{n}" alt="{esc(c or event_label(ev))}" loading="lazy" width="400" height="300"></a>'''
        for n, c in items
    )
    year = f'<p class="event-year">{esc(ev["year"])}</p>' if ev.get("year") else ""
    page = (ROOT / "templates" / "event.html").read_text(encoding="utf-8")
    page = (page.replace("{{site_title}}", esc(data["site"]["title"]))
                .replace("{{title}}", esc(ev["title"]))
                .replace("{{label}}", esc(event_label(ev)))
                .replace("{{year}}", year)
                .replace("{{count}}", str(len(items)))
                .replace("{{tiles}}", tiles))
    (dest / "index.html").write_text(page, encoding="utf-8")


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
    # Remove pages for events that were taken out of events.json.
    keep = {ev["id"] for ev in data["events"]}
    events_dir = out / "events"
    if events_dir.is_dir():
        for old in events_dir.iterdir():
            if old.is_dir() and old.name not in keep:
                shutil.rmtree(old)
                print(f"removed old event {old.name}")
    for ev in data["events"]:
        build_event(ev, src, out, data)
    build_index(data, out)
    print(f"Built {len(data['events'])} events into {out}")


if __name__ == "__main__":
    main()
