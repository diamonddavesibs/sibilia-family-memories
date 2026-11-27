# Sibilia Family Memories

The family photo site for sibilia.us: Fourth of July picnics, parties, family picnics and more.

## How it works

- `events.json` lists every event: its title, year, section, the folder its photos come from, and its cover photo. Adding an event means adding one entry here.
- `build.py` reads the photos from the old site folder (it never changes them), makes web-sized copies and thumbnails, picks up the old photo captions, and writes the finished site to `dist/`: the landing page plus one gallery page per event, with a full-size photo viewer you can swipe through.
- `templates/` and `assets/` hold the page layout and styling.

Photos are not stored in this repository. The originals stay on the family computer.

## Building

Needs Python 3 and Pillow (`pip install pillow`).

```
python build.py --source "M:/Sibilia.us/sibilia.us" --out dist
```

Open `dist/index.html` in a browser to preview. Upload the contents of `dist/` to DreamHost to publish.

## Family uploads

Family members can share albums through a separate upload page (see `upload-portal/`). After David approves an album there, bring it onto the site before building:

```
pip install pillow-heif boto3
python import_uploads.py   (on Windows: double-click import-uploads.bat)
python build.py --source "M:/Sibilia.us/sibilia.us" --out dist
```

`import_uploads.py` virus-scans each photo (ESET or Microsoft Defender on Windows, ClamAV elsewhere), re-saves it as a clean JPEG, and keeps the clean copies in `M:/Sibilia.us/family-uploads` (outside git, like the other photos). Its settings live in `uploads.env`, which is never committed. Albums appear in a "Shared by the Family" section. Set `site.uploadUrl` in `events.json` to add a footer link to the upload page.
