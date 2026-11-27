# Sibilia Family Memories

The family photo site for sibilia.us: Fourth of July picnics, golf outings, parties and more.

## How it works

- `events.json` lists every event: its title, year, section, the folder its photos come from, and its cover photo. Adding an event means adding one entry here.
- `build.py` reads the photos from the old site folder (it never changes them), makes web-sized copies, and writes the finished site to `dist/`.
- `templates/` and `assets/` hold the page layout and styling.

Photos are not stored in this repository. The originals stay on the family computer.

## Building

Needs Python 3 and Pillow (`pip install pillow`).

```
python build.py --source "M:/Sibilia.us/sibilia.us" --out dist
```

Open `dist/index.html` in a browser to preview. Upload the contents of `dist/` to DreamHost to publish.
