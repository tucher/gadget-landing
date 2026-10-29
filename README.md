# gadget-landing

The installer page for the gadget firmware on the Waveshare
ESP32-S3-Touch-AMOLED-1.43C, served at <https://gadget.means.live>. It writes
the firmware over Web Serial and puts the board on Wi-Fi over Web Bluetooth
(Chrome or Edge on a computer), with
[esptool-js](https://github.com/espressif/esptool-js) 0.7.0, kept in
`site/vendor/` under its Apache-2.0 license.

`site/` is published by `.github/workflows/pages.yml` on every push to `main`
and every new Release: the page as it is (no build step), plus the newest
Release's files in `site/firmware/`. Releases come from the private
repository's `tools/publish.sh`, which builds the firmware and stages it with
`tools/stage.py`, together with the app the page installs (hello-pendant).
Firmware never enters this repository's history.

## What the page does

1. Fetches `firmware/manifest.json`, the image and the app files it names, and
   checks each one's SHA-256.
2. On a click, finds the board. Running this firmware it is TinyUSB's device,
   the REPL's serial port on it: the page asks it into the chip's ROM loader
   through the REPL (`machine.bootloader()`), and the board comes back as
   another USB device, which Chrome asks the person to allow the first time.
   Otherwise (Waveshare's firmware, a debug build, the loader already) it is
   USB-Serial-JTAG, and the page resets it into the loader.
3. Reads the board's partition table and installed app, and decides
   (`site/js/image.js`, `plan()`):
   - **update**, when the board has the image's layout (every partition at the
     same offset, of the same size and type, names aside): only the image is
     written, settings (NVS) and files stay. If the board already runs this
     very build, it asks first.
   - **fresh install**, otherwise: it asks first (unless the flash is erased),
     then erases everything after the app slot, as `build.sh flash-fresh`
     does, and NVS unless the board has the same NVS partition. Erasing comes
     before writing, so a fresh install cut short is still a fresh install the
     next time.
4. Writes the image at 0x0, checks it by MD5, and restarts the board with a
   watchdog reset (`site/js/board.js` does this, and switches the watchdogs
   off after connecting: esptool-js leaves both out on USB-Serial-JTAG).
5. Once the firmware runs, writes the app's files through the raw REPL
   (`site/js/repl.js`), each checked by SHA-256 on the board and renamed into
   place, then starts the app. Only where the board has no app or this one:
   another app is left alone.
6. Wi-Fi, separately: Improv over Web Bluetooth (`site/js/improv.js`). The
   board's app offers it (hello-pendant does by itself while it has no
   network); the page asks the board which networks it sees (Improv's "request
   scanned Wi-Fi networks") and offers them as a list, typing only as a
   fallback.

Two things esptool-js 0.7 gets wrong here, worked around in `board.js`: Web
Serial's default 255-byte read buffer stalls the loader's 4 KB packets midway
(the port is opened with 64 KB), and a flash read leaves the loader's MD5
packet unread, where it would precede the next command's answer (it is read
and checked).

## Working on it

```bash
python3 tools/stage.py                  # the local build and hello-pendant -> site/firmware/
python3 -m http.server -d site 8000     # then http://localhost:8000 in Chrome
```

Web Serial needs a secure context, and `localhost` counts as one.
`tools/stage.py` copies each file under a name made from its hash and writes
the manifest; `site/firmware/` is never committed.

Tests without a board:

```bash
node tools/test.mjs          # md5, partition tables, plan(), on real images
python tools/ui_test.py      # the page in Chrome, against a simulated board (needs Playwright)
```

Both default to the local build and the board's factory dump in the private
repository this one is checked out in (`../vendor`, `../backups`), and skip
the factory cases without it. Neither file belongs here. On a real board, the
private repository's `bench/host/installer.py` drives this page in Chrome.
