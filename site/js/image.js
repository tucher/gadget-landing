// What an ESP-IDF image and a board's flash say about themselves: the
// partition table, and the descriptor at the start of an app. The installer
// reads both from the image it is about to write and from the board, and
// plan() decides between an update and a fresh install. No DOM here, so
// tools/test.mjs runs this code in Node against real images.

import { md5hex } from "./md5.js";

export const FLASH_SIZE = 8 * 1024 * 1024; // the AMOLED-1.43C's ESP32-S3-PICO-1-N8R8
export const TABLE_OFFSET = 0x8000;
export const TABLE_SIZE = 0xc00;
// An app partition starts with the image header (24 bytes) and the first
// segment's header (8), then esp_app_desc_t (256).
export const APP_HEAD_SIZE = 0x20 + 0x100;

const TYPE_APP = 0x00;
const TYPE_DATA = 0x01;
const SUBTYPE_NVS = 0x02;

const text = (bytes) => {
  const end = bytes.indexOf(0);
  return new TextDecoder().decode(end < 0 ? bytes : bytes.subarray(0, end));
};
const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

/** The entries of a partition table, or null if `bytes` holds none. */
export function parseTable(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const entries = [];
  for (let at = 0; at + 32 <= bytes.length; at += 32) {
    const magic = view.getUint16(at, true);
    if (magic === 0x50aa) {
      entries.push({
        label: text(bytes.subarray(at + 12, at + 28)),
        type: bytes[at + 2],
        subtype: bytes[at + 3],
        offset: view.getUint32(at + 4, true),
        size: view.getUint32(at + 8, true),
      });
    } else if (magic === 0xebeb) {
      // The MD5 row covers the entries before it; a mismatch is a damaged table.
      if (md5hex(bytes.subarray(0, at)) !== hex(bytes.subarray(at + 16, at + 32))) return null;
      break;
    } else {
      break;
    }
  }
  return entries.length ? entries : null;
}

/** The descriptor of the app that `head` starts with, or null if there is none. */
export function parseApp(head) {
  if (head.length < APP_HEAD_SIZE || head[0] !== 0xe9) return null;
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  if (view.getUint32(0x20, true) !== 0xabcd5432) return null;
  const d = head.subarray(0x20);
  return {
    version: text(d.subarray(16, 48)),
    project: text(d.subarray(48, 80)),
    time: text(d.subarray(80, 96)),
    date: text(d.subarray(96, 112)),
    idf: text(d.subarray(112, 144)),
    elfSha256: hex(d.subarray(144, 176)),
  };
}

/** The partition table and the app of an image written at flash offset 0. */
export function describeImage(image) {
  const tableBytes = image.subarray(TABLE_OFFSET, TABLE_OFFSET + TABLE_SIZE);
  const table = parseTable(tableBytes);
  if (!table) throw new Error("the image has no partition table at 0x8000");
  const app = table.find((p) => p.type === TYPE_APP);
  const desc = app && parseApp(image.subarray(app.offset, app.offset + APP_HEAD_SIZE));
  if (!desc) throw new Error("the image has no app where its partition table puts one");
  if (image.length > app.offset + app.size) throw new Error("the image overruns its app partition");
  return { tableBytes, table, app, desc };
}

/**
 * What installing an image (describeImage()) does to a board, from what the
 * board's flash holds: `tableBytes` (TABLE_SIZE bytes from TABLE_OFFSET), its
 * parsed `table`, and `app`, the first app it names that has a descriptor.
 *
 * The same partition table, byte for byte, makes an update: the image is
 * written, and settings (NVS) and files stay.
 *
 * Any other table, or none, makes a fresh install. MicroPython takes the flash
 * after the last partition for its filesystem and loops at start-up, before
 * USB comes up, if that area holds anything but a filesystem or erased flash.
 * So everything after the app slot is erased, as `build.sh flash-fresh` does;
 * and NVS too, unless the board's table has the very same NVS partition.
 * The erasing must come before the image is written: a fresh install cut off
 * after writing would otherwise look like an update the next time.
 */
export function plan(image, board) {
  const installed = board.app;
  const sameBuild = !!installed && installed.desc.elfSha256 === image.desc.elfSha256;
  const same = board.tableBytes.length === image.tableBytes.length &&
    board.tableBytes.every((b, i) => b === image.tableBytes[i]);
  if (same) return { kind: "update", installed, sameBuild, erase: [] };

  const erase = [];
  const isNvs = (p) => p.type === TYPE_DATA && p.subtype === SUBTYPE_NVS;
  const nvs = image.table.find(isNvs);
  const nvsKept = nvs && board.table?.some((p) => isNvs(p) && p.offset === nvs.offset && p.size === nvs.size);
  if (nvs && !nvsKept) erase.push({ offset: nvs.offset, size: nvs.size, what: "settings" });
  const appEnd = Math.max(...image.table.filter((p) => p.type === TYPE_APP).map((p) => p.offset + p.size));
  erase.push({ offset: appEnd, size: FLASH_SIZE - appEnd, what: "files" });
  return { kind: "fresh", installed, sameBuild, erase };
}
