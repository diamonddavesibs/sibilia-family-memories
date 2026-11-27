#!/usr/bin/env python3
"""Bring approved family uploads onto the site.

Downloads every album David approved on the upload page, checks and cleans
each photo, and adds the album to family-uploads/events.json so the next
build.py run gives it a card and a gallery.

    python import_uploads.py --uploads "M:/Sibilia.us/family-uploads"
    python build.py --source "M:/Sibilia.us/sibilia.us" --out dist

Every photo goes through four checks before it can reach the site:
  1. It is downloaded into a quarantine folder, never straight into the site.
  2. A virus scan runs over the quarantine folder: Microsoft Defender on
     Windows, or ClamAV's clamscan elsewhere. If neither is available the
     import stops, unless you pass --skip-virus-scan on purpose.
  3. Pillow opens it and it must really be a JPEG, PNG or HEIC photo of a
     sensible size (no "decompression bombs").
  4. It is re-saved as a brand-new JPEG from the picture alone. Anything
     hidden inside the original file, and phone data such as GPS location,
     is left behind. Only these clean copies are kept.

On Windows, double-click import-uploads.bat instead (it installs what it needs).
Needs: pip install pillow pillow-heif boto3
Settings come from uploads.env next to this script (never put it in git):
    R2_ACCOUNT_ID=...
    R2_ACCESS_KEY_ID=...
    R2_SECRET_ACCESS_KEY=...
    R2_BUCKET=sibilia-uploads
"""
import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import warnings
from datetime import datetime, timezone
from pathlib import Path

from PIL import Image, ImageOps

ROOT = Path(__file__).resolve().parent
MAX_PIXELS = 80_000_000      # about an 80 megapixel photo
MAX_SIDE = 3000              # clean copies are kept at most this big
ALBUM_ID = re.compile(r"^[0-9]{8}-[a-z0-9]{6}$")
PHOTO_KEY = re.compile(r"^\d{3}\.(jpg|png|heic)$")

Image.MAX_IMAGE_PIXELS = MAX_PIXELS
warnings.simplefilter("error", Image.DecompressionBombWarning)

try:
    from pillow_heif import register_heif_opener
    register_heif_opener()
    HEIF = True
except ImportError:
    HEIF = False


def load_settings():
    env_file = ROOT / "uploads.env"
    settings = {}
    if env_file.exists():
        for line in env_file.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if line and not line.startswith("#") and "=" in line:
                k, v = line.split("=", 1)
                settings[k.strip()] = v.strip()
    for k in ("R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"):
        settings.setdefault(k, os.environ.get(k, ""))
    missing = [k for k, v in settings.items() if k.startswith("R2_") and not v]
    if missing:
        sys.exit(f"Missing settings in uploads.env: {', '.join(missing)}")
    return settings


def r2_client(s):
    import boto3
    return boto3.client(
        "s3",
        endpoint_url=f"https://{s['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com",
        aws_access_key_id=s["R2_ACCESS_KEY_ID"],
        aws_secret_access_key=s["R2_SECRET_ACCESS_KEY"],
        region_name="auto",
    )


def list_keys(r2, bucket, prefix, delimiter=None):
    kw = {"Bucket": bucket, "Prefix": prefix}
    if delimiter:
        kw["Delimiter"] = delimiter
    keys, prefixes = [], []
    while True:
        page = r2.list_objects_v2(**kw)
        keys += [o["Key"] for o in page.get("Contents", [])]
        prefixes += [p["Prefix"] for p in page.get("CommonPrefixes", [])]
        if not page.get("IsTruncated"):
            return keys, prefixes
        kw["ContinuationToken"] = page["NextContinuationToken"]


def get_json(r2, bucket, key):
    return json.loads(r2.get_object(Bucket=bucket, Key=key)["Body"].read())


def put_json(r2, bucket, key, data):
    r2.put_object(Bucket=bucket, Key=key, Body=json.dumps(data).encode(), ContentType="application/json")


def defender_path():
    if os.name != "nt":
        return None
    for base in (os.environ.get("ProgramFiles", r"C:\Program Files"),):
        exe = Path(base) / "Windows Defender" / "MpCmdRun.exe"
        if exe.exists():
            return exe
    return None


def virus_scan(folder, expected):
    """True if clean. Raises FileNotFoundError if no scanner is available."""
    defender = defender_path()
    if defender:
        res = subprocess.run([str(defender), "-Scan", "-ScanType", "3", "-File", str(folder),
                              "-DisableRemediation"], capture_output=True, text=True)
        if res.returncode == 2:
            print(res.stdout.strip()[-500:])
            return False
        if res.returncode != 0:
            raise RuntimeError(f"virus scan failed (Defender code {res.returncode})")
    else:
        scanner = shutil.which("clamscan")
        if not scanner:
            raise FileNotFoundError("no virus scanner")
        res = subprocess.run([scanner, "--recursive", "--infected", "--no-summary", str(folder)],
                             capture_output=True, text=True)
        if res.returncode == 1:
            print(res.stdout.strip())
            return False
        if res.returncode != 0:
            raise RuntimeError(f"virus scan failed: {res.stderr.strip() or res.stdout.strip()}")
    # Real-time protection may already have removed a bad file on download.
    return all(f.exists() for f in expected)


def clean_copy(src, dest):
    """Re-save one photo as a fresh JPEG. Returns an error message or None."""
    try:
        with Image.open(src) as im:
            if im.format not in ("JPEG", "PNG", "HEIF"):
                return f"not a photo ({im.format})"
            w, h = im.size
            if w < 50 or h < 50 or w * h > MAX_PIXELS:
                return f"unusual size {w}x{h}"
            im.verify()
        with Image.open(src) as im:
            im.load()
            im = ImageOps.exif_transpose(im).convert("RGB")
            im.thumbnail((MAX_SIDE, MAX_SIDE), Image.LANCZOS)
            # A new picture from the pixels only: no EXIF, GPS or other extras.
            fresh = Image.new("RGB", im.size)
            fresh.paste(im)
            dest.parent.mkdir(parents=True, exist_ok=True)
            fresh.save(dest, "JPEG", quality=90, optimize=True)
        return None
    except Exception as e:  # anything odd means the photo is left out
        return f"could not be read ({type(e).__name__})"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--uploads", default=str(ROOT.parent / "family-uploads"),
                    help="where clean family photos are kept (default: family-uploads next to this folder)")
    ap.add_argument("--skip-virus-scan", action="store_true",
                    help="import without ClamAV (photos are still checked and re-saved)")
    ap.add_argument("--dry-run", action="store_true", help="only list what would be imported")
    args = ap.parse_args()

    if not HEIF:
        print("Note: pillow-heif is not installed, so iPhone (HEIC) photos will be skipped. "
              "pip install pillow-heif")
    s = load_settings()
    r2, bucket = r2_client(s), s["R2_BUCKET"]
    uploads = Path(args.uploads)
    events_file = uploads / "events.json"
    events = json.loads(events_file.read_text(encoding="utf-8")) if events_file.exists() else []
    known = {e["id"] for e in events}

    _, prefixes = list_keys(r2, bucket, "albums/", "/")
    approved = []
    for p in prefixes:
        aid = p[len("albums/"):-1]
        if not ALBUM_ID.match(aid):
            continue
        album = get_json(r2, bucket, f"albums/{aid}/album.json")
        if album.get("status") == "approved":
            approved.append(album)
    if not approved:
        print("No approved albums waiting.")
        return
    for a in approved:
        print(f"Approved: {a['label']} ({a.get('year') or 'no year'}) from {a.get('ownerName')}, {a.get('photoCount')} photos")
    if args.dry_run:
        return

    quarantine = ROOT / ".quarantine"
    added = 0
    for album in approved:
        aid = album["id"]
        event_id = f"family-{aid}"
        box = quarantine / aid
        shutil.rmtree(box, ignore_errors=True)
        box.mkdir(parents=True)
        keys, _ = list_keys(r2, bucket, f"albums/{aid}/photos/")
        files, blocked = [], False
        for k in sorted(keys):
            name = k.rsplit("/", 1)[-1]
            if PHOTO_KEY.match(name):
                try:
                    r2.download_file(bucket, k, str(box / name))
                except OSError:
                    blocked = True  # antivirus refused to let the file be written
                files.append(box / name)

        if args.skip_virus_scan:
            print("  Virus scan skipped (--skip-virus-scan).")
        else:
            try:
                clean = not blocked and virus_scan(box, files)
            except FileNotFoundError:
                shutil.rmtree(quarantine, ignore_errors=True)
                sys.exit("No virus scanner found (Microsoft Defender or ClamAV), so nothing was imported.\n"
                         "Install one, or run again with --skip-virus-scan.")
            if not clean:
                print(f"  VIRUS FOUND in '{album['label']}'. Album not imported; marked rejected.")
                album.update(status="rejected", note="A file failed the virus scan.",
                             reviewedAt=datetime.now(timezone.utc).isoformat())
                put_json(r2, bucket, f"albums/{aid}/album.json", album)
                shutil.rmtree(box, ignore_errors=True)
                continue

        dest_dir = uploads / aid
        shutil.rmtree(dest_dir, ignore_errors=True)
        good, problems = 0, []
        for f in files:
            if f.suffix == ".heic" and not HEIF:
                problems.append(f"{f.name}: HEIC support not installed")
                continue
            err = clean_copy(f, dest_dir / f"{good + 1:03d}.jpg")
            if err:
                problems.append(f"{f.name}: {err}")
            else:
                good += 1
        shutil.rmtree(box, ignore_errors=True)
        for p in problems:
            print(f"  left out {p}")
        if not good:
            print(f"  No usable photos in '{album['label']}'; nothing added.")
            continue

        entry = {
            "id": event_id,
            "category": "family",
            "title": album["label"],
            "year": album.get("year"),
            "folder": aid,
            "cover": "001.jpg",
            "photos": good,
            "by": album.get("ownerName", ""),
            "minSize": 50,
        }
        events = [e for e in events if e["id"] != event_id] + [entry]
        uploads.mkdir(parents=True, exist_ok=True)
        events_file.write_text(json.dumps(events, indent=2), encoding="utf-8")

        album.update(status="published", photoCount=good,
                     publishedAt=datetime.now(timezone.utc).isoformat())
        put_json(r2, bucket, f"albums/{aid}/album.json", album)
        # The clean copies are kept here; the originals are no longer needed.
        if keys:
            r2.delete_objects(Bucket=bucket, Delete={"Objects": [{"Key": k} for k in keys]})
        added += 1
        print(f"  Added '{album['label']}' with {good} clean photos.")

    shutil.rmtree(quarantine, ignore_errors=True)
    if added:
        print(f"\n{added} album(s) added. Now run build.py and upload the new folders.")


if __name__ == "__main__":
    main()
