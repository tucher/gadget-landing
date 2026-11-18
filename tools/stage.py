#!/usr/bin/env python3
"""Put a firmware image, the apps offered with it, and their manifest into the site.

    python3 tools/stage.py [firmware.bin] [--app DIR ...] [--version V] [--out site/firmware]

The image is what build.sh writes at flash offset 0: bootloader, partition
table, app. It is copied under a name made from its SHA-256, so that a cached
copy can never stand in for a newer image, and manifest.json, which the page
fetches without caching, names the current one. Each app's files (--app, once
per app, the first the page's default; without it, hello-pendant from the same
repository), subfolders included, are copied the same way, as
app-<sha>-<name>; the page offers the apps by name and the first line of their
main.py ("name: what it is"), and writes the chosen one's files onto the board
after the firmware. An app that imports improv is marked as offering Wi-Fi
setup over Bluetooth, which the page's Wi-Fi step needs. The
default image is the local build in the private repository this one sits in;
site/firmware/ is never committed. tools/publish.sh in that repository stages
into a scratch folder and publishes it as a Release, which the Pages workflow
copies into the site.
"""
import argparse
import datetime
import hashlib
import json
import pathlib
import re
import struct
import sys

DEFAULT = "../vendor/micropython/ports/esp32/build-WAVESHARE_AMOLED_143C/firmware.bin"
DEFAULT_APP = "../apps/hello-pendant"
TABLE_OFFSET = 0x8000


def app_descriptor(image):
    """The esp_app_desc_t of the first app in the image's partition table."""
    for at in range(TABLE_OFFSET, TABLE_OFFSET + 0xC00, 32):
        magic, ptype, _, offset, _ = struct.unpack_from("<HBBII", image, at)
        if magic != 0x50AA:
            break
        if ptype == 0:
            d = image[offset + 0x20 : offset + 0x20 + 256]
            if image[offset] != 0xE9 or struct.unpack_from("<I", d)[0] != 0xABCD5432:
                break
            s = lambda a, n: d[a : a + n].split(b"\0")[0].decode()
            return {"version": s(16, 32), "time": s(80, 16), "date": s(96, 16), "elf_sha256": d[144:176].hex()}
    sys.exit("not a firmware image: no app found through a partition table at 0x8000")


def stage_app(app, out):
    files = []
    for f in sorted(app.rglob("*")):
        rel = f.relative_to(app)
        if not f.is_file() or any(p.startswith(".") or p == "__pycache__" for p in rel.parts):
            continue
        data = f.read_bytes()
        h = hashlib.sha256(data).hexdigest()
        name = f"app-{h[:12]}-{f.name}"
        (out / name).write_bytes(data)
        files.append({"path": rel.as_posix(), "file": name, "size": len(data), "sha256": h})
    main = app / "main.py"
    if not main.is_file():
        sys.exit(f"{app}: no main.py")
    text = main.read_text()
    first = re.match(r'\s*"""\s*([\w-]+):\s*(.+)', text)
    return {
        "name": app.name,
        "description": first.group(2).strip() if first else "",
        "wifi_setup": bool(re.search(r"^\s*(import|from)\s+improv\b", text, re.M)),
        "files": files,
    }


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("image", nargs="?", default=DEFAULT)
    ap.add_argument("--app", action="append", help="an app the page offers with the firmware (repeatable)")
    ap.add_argument("--version", help="shown on the page (default: the image's own, else its build hash)")
    ap.add_argument("--out", default="site/firmware")
    args = ap.parse_args()

    image = pathlib.Path(args.image).read_bytes()
    desc = app_descriptor(image)
    sha256 = hashlib.sha256(image).hexdigest()
    built = datetime.datetime.strptime(f"{desc['date']} {desc['time']}", "%b %d %Y %H:%M:%S")

    out = pathlib.Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    for old in [*out.glob("firmware-*.bin"), *out.glob("app-*")]:
        old.unlink()
    name = f"firmware-{sha256[:12]}.bin"
    (out / name).write_bytes(image)
    manifest = {
        "version": args.version or desc["version"] or desc["elf_sha256"][:8],
        "built": built.strftime("%Y-%m-%d %H:%M"),
        "file": name,
        "size": len(image),
        "sha256": sha256,
        "apps": [stage_app(pathlib.Path(a), out) for a in args.app or [DEFAULT_APP]],
    }
    manifest["app"] = manifest["apps"][0]       # for a page from before the choice
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"{out / name}: {manifest['version']}, built {manifest['built']}, {len(image)} bytes")
    for a in manifest["apps"]:
        print(f"  app {a['name']}: {', '.join(f['path'] for f in a['files'])}")


if __name__ == "__main__":
    main()
