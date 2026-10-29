#!/usr/bin/env python3
"""Drive the installer page in Chrome against a simulated board.

    python3 tools/stage.py                  # the page needs a firmware to offer
    python tools/ui_test.py [factory-dump.bin]

Needs Playwright (pip install playwright) and Chrome. The page is served from
site/ on 127.0.0.1, which Chrome treats as secure, as Web Serial requires.
js/board.js, the only module that touches a board, is replaced by a fake that
"reads" its flash from real images (erased flash, the staged firmware, a
copy of it from another build, Waveshare's factory dump) and records what the
page asks it to do, so each path through the page runs without hardware.
Also checks that the real board.js and esptool-js load.
"""
import functools
import http.server
import json
import pathlib
import sys
import threading

from playwright.sync_api import sync_playwright

ROOT = pathlib.Path(__file__).resolve().parent.parent
SITE = ROOT / "site"
FACTORY = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else ROOT / "../backups/amoled-143c_factory_ac276ed2fcd4_8MB.bin")

FAKE_BOARD = r"""
import { APP_HEAD_SIZE, TABLE_OFFSET, TABLE_SIZE, parseApp, parseTable } from "./image.js";
const F = window.FAKE;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export class BoardError extends Error {}
export async function pickPort() {
  if (F.pick === "cancel") throw new DOMException("No port selected by the user.", "NotFoundError");
  return {};
}
async function flash() {
  if (F.flash === "erased") return new Uint8Array(0x10200).fill(0xff);
  if (F.flash === "factory") return new Uint8Array(await (await fetch("/__factory.bin")).arrayBuffer());
  const m = await (await fetch("firmware/manifest.json")).json();
  const bytes = new Uint8Array(await (await fetch("firmware/" + m.file)).arrayBuffer());
  if (F.flash === "other") bytes[0x10000 + 0x20 + 144] ^= 0xff;   // another build's ELF hash
  return bytes;
}
export class Board {
  static async open(port, log) {
    F.calls.push("open");
    if (F.open === "busy") throw new DOMException("Failed to execute 'open' on 'SerialPort': Failed to open serial port.", "NetworkError");
    log("fake board\n");
    const b = new Board();
    b.chip = "ESP32-S3 (fake)";
    b.mac = "00:00:00:00:00:00";
    return b;
  }
  async read() {
    const f = await flash();
    const tableBytes = f.slice(TABLE_OFFSET, TABLE_OFFSET + TABLE_SIZE);
    const table = parseTable(tableBytes);
    let app = null;
    for (const p of (table ?? []).filter((p) => p.type === 0)) {
      const desc = parseApp(f.slice(p.offset, p.offset + APP_HEAD_SIZE));
      if (desc) { app = { label: p.label, desc }; break; }
    }
    return { tableBytes, table, app };
  }
  async erase(offset, size) { F.calls.push(`erase ${offset.toString(16)}+${size.toString(16)}`); await sleep(20); }
  async write(image, progress) {
    F.calls.push(`write ${image.length}`);
    for (const f of [0, 0.5, 1]) { progress(f); await sleep(20); }
    if (F.write === "fail") throw new Error("Timeout waiting for the board");
  }
  async restart() { F.calls.push("restart"); }
  async close() { F.calls.push("close"); }
}
"""


class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *args):
        pass


def serve():
    handler = functools.partial(Quiet, directory=str(SITE))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server


def main():
    if not (SITE / "firmware/manifest.json").exists():
        sys.exit("no staged firmware: run tools/stage.py first")
    server = serve()
    base = f"http://127.0.0.1:{server.server_address[1]}/"
    manifest = json.loads((SITE / "firmware/manifest.json").read_text())
    size = manifest["size"]
    failures = 0

    with sync_playwright() as pw:
        browser = pw.chromium.launch(channel="chrome", headless=True)

        def page_with(fake=None, no_firmware=False):
            ctx = browser.new_context()
            page = ctx.new_page()
            errors = []
            page.on("pageerror", lambda e: errors.append(str(e)))
            if not no_firmware:
                page.on("console", lambda m: m.type == "error" and errors.append(m.text))
                page.on("response", lambda r: r.status >= 400 and errors.append(f"{r.status} {r.url}"))
            if fake is not None:
                page.add_init_script(f"window.FAKE = Object.assign({{calls: []}}, {json.dumps(fake)});")
                page.route("**/js/board.js", lambda r: r.fulfill(body=FAKE_BOARD, content_type="text/javascript"))
                if FACTORY.exists():
                    page.route("**/__factory.bin", lambda r: r.fulfill(path=str(FACTORY)))
            if no_firmware:
                page.route("**/firmware/manifest.json", lambda r: r.fulfill(status=404, body="not found"))
            page.goto(base)
            return page, errors

        def check(name, cond, detail=""):
            nonlocal failures
            print(("ok   " if cond else "FAIL ") + name + ("" if cond else f"  -- {detail}"))
            failures += not cond

        def run(name, fake, answer=None, expect_calls=None, expect_status=None, expect_question=None):
            page, errors = page_with(fake)
            page.wait_for_function("!document.getElementById('go').disabled")
            page.click("#go")
            if answer is not None:
                page.wait_for_selector("#confirm:not([hidden])")
                question = page.text_content("#confirm-text")
                if expect_question:
                    check(f"{name}: asks", expect_question in question, question)
                page.click("#confirm-yes" if answer else "#confirm-no")
            page.wait_for_function("!document.getElementById('go').disabled")
            page.wait_for_timeout(100)
            calls = page.evaluate("window.FAKE.calls")
            status = page.text_content("#status")
            confirm_hidden = page.get_attribute("#confirm", "hidden") is not None
            ok = (expect_calls is None or calls == expect_calls) and expect_status in status and confirm_hidden
            check(name, ok and not errors, f"calls={calls} status={status!r} errors={errors}")
            page.context.close()

        # The real modules: esptool-js loads, the firmware downloads and checks out.
        page, errors = page_with()
        page.wait_for_function("!document.getElementById('go').disabled")
        page.wait_for_timeout(1500)  # the download and its SHA-256 run after the button enables
        fw = page.text_content("#fw")
        check("real modules load; firmware offered", manifest["version"] in fw and not errors, f"fw={fw!r} errors={errors}")
        check("Web Serial present in this Chrome", page.evaluate("'serial' in navigator"))
        page.context.close()

        page, errors = page_with(no_firmware=True)
        page.wait_for_function("document.getElementById('fw').textContent.includes('No firmware')")
        check("nothing published: says so, button stays off", page.is_disabled("#go"))
        page.context.close()

        erase_all = ["erase 9000+6000", "erase 490000+370000"]
        run("chooser closed: nothing happens", {"pick": "cancel"}, expect_calls=[], expect_status="")
        run("port busy: says so", {"open": "busy"}, expect_calls=["open"], expect_status="port is busy")
        run("erased flash: installs without asking", {"flash": "erased"},
            expect_calls=["open", *erase_all, f"write {size}", "restart"], expect_status="Done")
        if FACTORY.exists():
            run("factory firmware, cancelled: board restarted, nothing written", {"flash": "factory"}, answer=False,
                expect_question="01_Fac", expect_calls=["open", "restart"], expect_status="Nothing was changed")
            run("factory firmware, confirmed: erases then writes", {"flash": "factory"}, answer=True,
                expect_question="erases the settings and files",
                expect_calls=["open", *erase_all, f"write {size}", "restart"], expect_status="Done")
        else:
            print("skip factory dump (not found:", FACTORY, ")")
        run("same build installed: asks, then writes without erasing", {"flash": "ours"}, answer=True,
            expect_question="already runs this build", expect_calls=["open", f"write {size}", "restart"],
            expect_status="Done")
        run("other build installed: updates without asking", {"flash": "other"},
            expect_calls=["open", f"write {size}", "restart"], expect_status="Done")
        run("write fails: says so, leaves the board in its loader", {"flash": "other", "write": "fail"},
            expect_calls=["open", f"write {size}", "close"], expect_status="installation stopped")

        browser.close()
    server.shutdown()
    print("all passed" if not failures else f"{failures} failed")
    sys.exit(1 if failures else 0)


if __name__ == "__main__":
    main()
