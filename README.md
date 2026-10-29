# gadget-landing

The installer page for the gadget firmware on the Waveshare
ESP32-S3-Touch-AMOLED-1.43C, served at <https://gadget.means.live>.

`site/` is published as it is by `.github/workflows/pages.yml` on every push to
`main`. There is no build step.

To work on it locally, serve `site/` and open it in Chrome:

```bash
python3 -m http.server -d site 8000     # then http://localhost:8000
```

Web Serial needs a secure context, and `localhost` counts as one.

Firmware images never go into this repository's history (`site/firmware/` is
ignored). The site will get them at deploy time; until then, put a local build
in `site/firmware/` to test against.
