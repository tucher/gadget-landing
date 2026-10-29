// Checks the page's image code in Node, against real images:
//
//   node tools/test.mjs [firmware.bin] [factory-dump.bin]
//
// By default, the local build and the board's factory dump from the private
// repository this one sits in (../vendor, ../backups); the factory checks are
// skipped without the dump. Neither file is ever committed here.

import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { md5hex } from "../site/js/md5.js";
import { APP_HEAD_SIZE, FLASH_SIZE, TABLE_OFFSET, TABLE_SIZE, describeImage, parseApp, parseTable, plan } from "../site/js/image.js";

const [ours = "../vendor/micropython/ports/esp32/build-WAVESHARE_AMOLED_143C/firmware.bin",
  factory = "../backups/amoled-143c_factory_ac276ed2fcd4_8MB.bin"] = process.argv.slice(2);

let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log("ok  ", name); };

// What the installer reads from a board whose flash is `flash`.
function boardFrom(flash) {
  const tableBytes = flash.slice(TABLE_OFFSET, TABLE_OFFSET + TABLE_SIZE);
  const table = parseTable(tableBytes);
  let app = null;
  for (const p of (table ?? []).filter((p) => p.type === 0)) {
    const desc = parseApp(flash.slice(p.offset, p.offset + APP_HEAD_SIZE));
    if (desc) { app = { label: p.label, desc }; break; }
  }
  return { tableBytes, table, app };
}

check("md5 matches Node's at block edges and on random data", () => {
  for (const n of [0, 1, 55, 56, 57, 63, 64, 65, 119, 120, 128, 1000, 100003]) {
    const data = randomBytes(n);
    assert.equal(md5hex(new Uint8Array(data)), createHash("md5").update(data).digest("hex"), `length ${n}`);
  }
});

const image = new Uint8Array(readFileSync(ours));
const img = describeImage(image);

check("md5 matches Node's on the firmware image", () => {
  assert.equal(md5hex(image), createHash("md5").update(image).digest("hex"));
});

check("our image: partition table, app slot, descriptor", () => {
  assert.deepEqual(img.table.map((p) => [p.label, p.offset, p.size]), [
    ["nvs", 0x9000, 0x6000],
    ["phy_init", 0xf000, 0x1000],
    ["factory", 0x10000, 0x480000],
    ["model", 0x490000, 0x100000],
    ["coredump", 0x590000, 0x10000],
  ]);
  assert.equal(img.app.label, "factory");
  assert.match(img.desc.idf, /^v5\.5/);
  assert.match(img.desc.elfSha256, /^[0-9a-f]{64}$/);
});

check("a damaged partition table is no table", () => {
  const t = img.tableBytes.slice();
  t[40] ^= 1; // inside the second entry, covered by the MD5 row
  assert.equal(parseTable(t), null);
});

check("the same build already on the board: an update, nothing erased", () => {
  const p = plan(img, boardFrom(image));
  assert.equal(p.kind, "update");
  assert.equal(p.sameBuild, true);
  assert.deepEqual(p.erase, []);
});

check("another build of the same layout: an update, nothing erased", () => {
  const flash = image.slice();
  flash[img.app.offset + 0x20 + 144] ^= 0xff; // the installed app's ELF SHA-256
  const p = plan(img, boardFrom(flash));
  assert.equal(p.kind, "update");
  assert.equal(p.sameBuild, false);
  assert.deepEqual(p.erase, []);
});

check("erased flash: a fresh install, settings and files erased", () => {
  const p = plan(img, boardFrom(new Uint8Array(FLASH_SIZE).fill(0xff)));
  assert.equal(p.kind, "fresh");
  assert.equal(p.installed, null);
  assert.deepEqual(p.erase, [
    { offset: 0x9000, size: 0x6000, what: "settings" },
    { offset: 0x490000, size: 0x370000, what: "files" }, // build.sh's FS_START and FS_SIZE
  ]);
});

check("an older layout of ours with the same NVS: settings kept, files erased", () => {
  const flash = image.slice();
  const view = new DataView(flash.buffer);
  // Move the model partition (the fourth entry) and fix the MD5 row.
  view.setUint32(TABLE_OFFSET + 3 * 32 + 4, 0x4a0000, true);
  const rows = 5 * 32;
  const md5 = md5hex(flash.subarray(TABLE_OFFSET, TABLE_OFFSET + rows));
  flash.set(md5.match(/../g).map((h) => parseInt(h, 16)), TABLE_OFFSET + rows + 16);
  const board = boardFrom(flash);
  assert.ok(board.table, "the edited table still parses");
  const p = plan(img, board);
  assert.equal(p.kind, "fresh");
  assert.deepEqual(p.erase, [{ offset: 0x490000, size: 0x370000, what: "files" }]);
});

if (existsSync(factory)) {
  const dump = new Uint8Array(readFileSync(factory));
  check("Waveshare's factory firmware: a fresh install, settings and files erased", () => {
    const board = boardFrom(dump);
    assert.deepEqual(board.table.map((p) => p.label), ["nvs", "otadata", "phy_init", "ota_0", "ota_1", "storage"]);
    assert.equal(board.app.label, "ota_0");
    assert.equal(board.app.desc.project, "01_Fac");
    const p = plan(img, board);
    assert.equal(p.kind, "fresh");
    assert.deepEqual(p.erase.map((r) => r.what), ["settings", "files"]);
  });
} else {
  console.log("skip  factory dump (not found:", factory + ")");
}

console.log(`${passed} passed`);
