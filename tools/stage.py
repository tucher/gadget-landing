#!/usr/bin/env python3
"""Put a firmware image, the app installed with it, and their manifest into the site.

    python3 tools/stage.py [firmware.bin] [--app DIR] [--version V] [--out site/firmware]

The image is what build.sh writes at flash offset 0: bootloader, partition
table, app. It is copied under a name made from its SHA-256, so that a cached
copy can never stand in for a newer image, and manifest.json, which the page
fetches without caching, names the current one. The app's files (default:
hello-pendant, from the same repository) are copied the same way, as
app-<sha>-<name>; the page writes them onto the board after the firmware. The
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
    for f in sorted(app.iterdir()):
        if f.is_file() and not f.name.startswith("."):
            data = f.read_bytes()
            h = hashlib.sha256(data).hexdigest()
            name = f"app-{h[:12]}-{f.name}"
            (out / name).write_bytes(data)
            files.append({"path": f.name, "file": name, "size": len(data), "sha256": h})
    if not any(f["path"] == "main.py" for f in files):
        sys.exit(f"{app}: no main.py")
    return {"name": app.name, "files": files}


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("image", nargs="?", default=DEFAULT)
    ap.add_argument("--app", default=DEFAULT_APP, help="the app the page installs with the firmware")
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
        "app": stage_app(pathlib.Path(args.app), out),
    }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"{out / name}: {manifest['version']}, built {manifest['built']}, {len(image)} bytes; "
          f"app {manifest['app']['name']}: {', '.join(f['path'] for f in manifest['app']['files'])}")


if __name__ == "__main__":
    main()
