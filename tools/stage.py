#!/usr/bin/env python3
"""Put a firmware image and its manifest into the site.

    python3 tools/stage.py [firmware.bin] [--version V] [--out site/firmware]

The image is what build.sh writes at flash offset 0: bootloader, partition
table, app. It is copied under a name made from its SHA-256, so that a cached
copy can never stand in for a newer image, and manifest.json, which the page
fetches without caching, names the current one. The default image is the
local build in the private repository this one sits in; site/firmware/ is
never committed.
"""
import argparse
import datetime
import hashlib
import json
import pathlib
import struct
import sys

DEFAULT = "../vendor/micropython/ports/esp32/build-WAVESHARE_AMOLED_143C/firmware.bin"
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


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("image", nargs="?", default=DEFAULT)
    ap.add_argument("--version", help="shown on the page (default: the image's own, else its build hash)")
    ap.add_argument("--out", default="site/firmware")
    args = ap.parse_args()

    image = pathlib.Path(args.image).read_bytes()
    desc = app_descriptor(image)
    sha256 = hashlib.sha256(image).hexdigest()
    built = datetime.datetime.strptime(f"{desc['date']} {desc['time']}", "%b %d %Y %H:%M:%S")

    out = pathlib.Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    for old in out.glob("firmware-*.bin"):
        old.unlink()
    name = f"firmware-{sha256[:12]}.bin"
    (out / name).write_bytes(image)
    manifest = {
        "version": args.version or desc["version"] or desc["elf_sha256"][:8],
        "built": built.strftime("%Y-%m-%d %H:%M"),
        "file": name,
        "size": len(image),
        "sha256": sha256,
    }
    (out / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"{out / name}: {manifest['version']}, built {manifest['built']}, {len(image)} bytes")


if __name__ == "__main__":
    main()
