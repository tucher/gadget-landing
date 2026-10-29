// The board over Web Serial, through esptool-js: connect to the chip's ROM
// loader, read what is installed, erase, write, restart.
//
// The AMOLED-1.43C's USB is the ESP32-S3's own USB-Serial-JTAG, and on it
// esptool-js 0.7 leaves out two things Python esptool does (esptool
// targets/esp32s3.py), so they are done here:
//  - after connecting, switch off the RTC watchdog and let the super watchdog
//    feed itself: a reset over USB-Serial-JTAG does not reset them, and a
//    watchdog the app left running would reset the chip mid-flash;
//  - restart through a watchdog reset. An RTS reset over USB-Serial-JTAG does
//    not read the boot strapping again, so the chip would come back in the
//    loader (build.sh flashes with --after watchdog_reset for this reason).

import { ESPLoader, Transport } from "../vendor/esptool-js-0.7.0/bundle.js";
import { md5hex } from "./md5.js";
import { APP_HEAD_SIZE, FLASH_SIZE, TABLE_OFFSET, TABLE_SIZE, parseApp, parseTable } from "./image.js";

const ESPRESSIF_VID = 0x303a;
const USB_SERIAL_JTAG_PID = 0x1001;

const RTC_CNTL = 0x60008000;
const WDT_CONFIG0 = RTC_CNTL + 0x98;
const WDT_CONFIG1 = RTC_CNTL + 0x9c;
const WDT_WPROTECT = RTC_CNTL + 0xb0;
const WDT_WKEY = 0x50d83aa1;
const SWD_CONF = RTC_CNTL + 0xb4;
const SWD_AUTO_FEED_EN = 0x80000000;
const SWD_WPROTECT = RTC_CNTL + 0xb8;
const SWD_WKEY = 0x8f1d312a;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** A failure the person at the board can act on; its message says how. */
export class BoardError extends Error {}

/** Ask for the board's port. Must be called from a click. */
export function pickPort() {
  return navigator.serial.requestPort({ filters: [{ usbVendorId: ESPRESSIF_VID }] });
}

export class Board {
  /** Reset the board into its ROM loader and connect. `log` gets esptool's output as text. */
  static async open(port, log) {
    const transport = new Transport(port, false);
    const loader = new ESPLoader({
      transport,
      // USB ignores the baud rate; equal rates also spare a port reopen.
      baudrate: 115200,
      romBaudrate: 115200,
      terminal: { clean() {}, writeLine: (s) => log(s + "\n"), write: log },
    });
    const board = new Board(transport, loader);
    try {
      await loader.main("default_reset");
      const chip = loader.chip.CHIP_NAME;
      if (chip !== "ESP32-S3") {
        throw new BoardError(`This board has an ${chip}. This firmware is for the ESP32-S3 of the AMOLED-1.43C.`);
      }
      const flash = await loader.detectFlashSize();
      if (!flash || loader.flashSizeBytes(flash) < FLASH_SIZE) {
        throw new BoardError(`This board has ${flash || "an unknown amount of"} flash. The AMOLED-1.43C has 8 MB.`);
      }
      if (port.getInfo().usbProductId === USB_SERIAL_JTAG_PID) await board.stopWatchdogs();
      board.chip = await loader.chip.getChipDescription(loader);
      board.mac = await loader.chip.readMac(loader);
    } catch (e) {
      await board.close();
      throw e;
    }
    return board;
  }

  constructor(transport, loader) {
    this.transport = transport;
    this.loader = loader;
  }

  async stopWatchdogs() {
    const l = this.loader;
    await l.writeReg(WDT_WPROTECT, WDT_WKEY);
    await l.writeReg(WDT_CONFIG0, 0);
    await l.writeReg(WDT_WPROTECT, 0);
    await l.writeReg(SWD_WPROTECT, SWD_WKEY);
    await l.writeReg(SWD_CONF, ((await l.readReg(SWD_CONF)) | SWD_AUTO_FEED_EN) >>> 0);
    await l.writeReg(SWD_WPROTECT, 0);
  }

  /** What the flash holds: its partition table, and the first app in it with a descriptor. */
  async read() {
    const tableBytes = await this.loader.readFlash(TABLE_OFFSET, TABLE_SIZE);
    const table = parseTable(tableBytes);
    let app = null;
    for (const p of (table ?? []).filter((p) => p.type === 0)) {
      const desc = parseApp(await this.loader.readFlash(p.offset, APP_HEAD_SIZE));
      if (desc) {
        app = { label: p.label, desc };
        break;
      }
    }
    return { tableBytes, table, app };
  }

  /** Erase a region (4 KB-aligned), as esptool's erase_region does. */
  async erase(offset, size) {
    const l = this.loader;
    const pkt = new Uint8Array(8);
    const view = new DataView(pkt.buffer);
    view.setUint32(0, offset, true);
    view.setUint32(4, size, true);
    await l.checkCommand("erase region", l.ESP_ERASE_REGION, pkt, 0, 0,
      l.timeoutPerMb(l.ERASE_REGION_TIMEOUT_PER_MB, size));
  }

  /** Write an image at offset 0 and check it by MD5. `progress` gets 0..1 of the data sent. */
  async write(image, progress) {
    await this.loader.writeFlash({
      fileArray: [{ data: image, address: 0 }],
      flashMode: "keep",
      flashFreq: "keep",
      flashSize: "keep",
      eraseAll: false,
      compress: true,
      reportProgress: (_, sent, total) => progress(sent / total),
      calculateMD5Hash: md5hex,
    });
  }

  /** Start the installed firmware: a watchdog reset, then let go of the port. */
  async restart() {
    const l = this.loader;
    await l.writeReg(WDT_WPROTECT, WDT_WKEY);
    await l.writeReg(WDT_CONFIG1, 2000);
    await l.writeReg(WDT_CONFIG0, ((1 << 31) | (5 << 28) | (1 << 8) | 2) >>> 0);
    // The chip may reset before it answers this one.
    await l.writeReg(WDT_WPROTECT, 0).catch(() => {});
    await sleep(500);
    await this.close();
  }

  async close() {
    try {
      await this.transport.disconnect();
    } catch {
      // Already gone: the board reset or was unplugged.
    }
  }
}
