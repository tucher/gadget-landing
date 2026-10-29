# gadget-landing

The installer page for the gadget firmware on the Waveshare
ESP32-S3-Touch-AMOLED-1.43C, served at <https://gadget.means.live>. It writes
the firmware over Web Serial (Chrome or Edge on a computer), with
[esptool-js](https://github.com/espressif/esptool-js) 0.7.0, kept in
`site/vendor/` under its Apache-2.0 license.

`site/` is published as it is by `.github/workflows/pages.yml` on every push to
`main`. There is no build step.

## What the page does

1. Fetches `firmware/manifest.json` and the image it names, and checks the
   image's SHA-256.
2. On a click, resets the board into the chip's ROM loader and reads its
   partition table and installed app.
3. Decides (`site/js/image.js`, `plan()`):
   - **update**, when the board's partition table is the image's byte for
     byte: only the image is written, settings (NVS) and files stay. If the
     board already runs this very build, it asks first.
   - **fresh install**, otherwise: it asks first (unless the flash is erased),
     then erases everything after the app slot, as `build.sh flash-fresh`
     does, and NVS unless the board has the same NVS partition. Erasing comes
     before writing, so a fresh install cut short is still a fresh install the
     next time.
4. Writes the image at 0x0, checks it by MD5, and restarts the board with a
   watchdog reset. The last two and switching off the watchdogs after
   connecting are done in `site/js/board.js`: esptool-js leaves them out on
   USB-Serial-JTAG, Python esptool does them.

## Working on it

```bash
python3 tools/stage.py                  # the local build -> site/firmware/
python3 -m http.server -d site 8000     # then http://localhost:8000 in Chrome
```

Web Serial needs a secure context, and `localhost` counts as one.
`tools/stage.py` copies the image under a name made from its hash and writes
the manifest; `site/firmware/` is never committed.

Tests, none of which needs a board:

```bash
node tools/test.mjs          # md5, partition tables, plan(), on real images
python tools/ui_test.py      # the page in Chrome, against a simulated board (needs Playwright)
```

Both default to the local build and the board's factory dump in the private
repository this one is checked out in (`../vendor`, `../backups`), and skip
the factory cases without it. Neither file belongs here.
