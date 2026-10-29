// The board over Web Serial, through esptool-js: connect to the chip's ROM
// loader, read what is installed, erase, write, restart.
//
// The board shows up as one of two USB devices. Running this firmware, it is
// TinyUSB's (product IDs 0x4000-0x40ff, the REPL's serial port among its
// functions); asked through the REPL (machine.bootloader(), as mpremote
// bootloader does), it drops off USB and comes back as the chip's ROM loader
// on its USB-Serial-JTAG (0x1001), a different device, which Chrome asks the
// person to allow the first time. MicroPython's RTS-then-DTR signal would do
// the same without the REPL, but it needs both lines changed in one USB
// request, and Chrome on macOS changes them one at a time (measured: the
// board stayed).
// Running Waveshare's firmware or this one's debug build, or held in the
// loader by hand, it is USB-Serial-JTAG already.
//
// On USB-Serial-JTAG, esptool-js 0.7 leaves out two things Python esptool does
// (esptool targets/esp32s3.py), so they are done here:
//  - after connecting, switch off the RTC watchdog and let the super watchdog
//    feed itself: a reset over USB-Serial-JTAG does not reset them, and a
//    watchdog the app left running would reset the chip mid-flash;
//  - restart through a watchdog reset. An RTS reset over USB-Serial-JTAG does
//    not read the boot strapping again, so the chip would come back in the
//    loader (build.sh flashes with --after watchdog_reset for this reason).

import { ESPLoader, Transport } from "../vendor/esptool-js-0.7.0/bundle.js";
import { Repl } from "./repl.js";
import { md5hex } from "./md5.js";
import { APP_HEAD_SIZE, FLASH_SIZE, TABLE_OFFSET, TABLE_SIZE, parseApp, parseTable } from "./image.js";

const ESPRESSIF_VID = 0x303a;
export const USB_SERIAL_JTAG_PID = 0x1001;

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
export const SERIAL_BUFFER = 64 * 1024;

/** A failure the person at the board can act on; its message says how. */
export class BoardError extends Error {}

/** Ask for the board's port, the loader's only if `loader`. Must be called from a click. */
export function pickPort(loader = false) {
  const filter = { usbVendorId: ESPRESSIF_VID };
  if (loader) filter.usbProductId = USB_SERIAL_JTAG_PID;
  return navigator.serial.requestPort({ filters: [filter] });
}

/** The board running this firmware: TinyUSB's device, the REPL's serial port on it. */
export const isTinyUsb = (port) => {
  const { usbVendorId, usbProductId } = port.getInfo();
  return usbVendorId === ESPRESSIF_VID && (usbProductId & 0xff00) === 0x4000;
};

/** An allowed port that is plugged in now and matches `test`, or null. */
export async function knownPort(test) {
  for (const p of await navigator.serial.getPorts()) if (test(p)) return p;
  return null;
}

/** Wait until an allowed port matching `test` is plugged in; null after `ms`. */
export async function waitForPort(test, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const p = await knownPort(test);
    if (p) return p;
    await sleep(200);
  }
  return null;
}

/**
 * Ask the board on TinyUSB's port into its ROM loader, through the REPL, and
 * wait for it to leave USB. False if it stays.
 */
export async function enterLoader(port) {
  let gone = false;
  const left = new Promise((resolve) => {
    const on = (e) => {
      if (e.target === port) {
        gone = true;
        navigator.serial.removeEventListener("disconnect", on);
        resolve();
      }
    };
    navigator.serial.addEventListener("disconnect", on);
  });
  const repl = await Repl.open(port);
  try {
    // No answer: the board leaves USB as it runs it.
    await repl.write("import machine\nmachine.bootloader()\x04");
    await Promise.race([left, sleep(5000)]);
  } finally {
    await repl.close();
  }
  return gone;
}

export class Board {
  /**
   * Connect to the ROM loader on `port` (USB-Serial-JTAG). `inLoader`: the
   * board is there already (enterLoader()), so it is not reset first; otherwise
   * it is reset into the loader. `log` gets esptool's output as text.
   */
  static async open(port, log, inLoader = false) {
    const transport = new Transport(port, false);
    const loader = new ESPLoader({
      transport,
      // USB ignores the baud rate; equal rates also spare a port reopen.
      baudrate: 115200,
      romBaudrate: 115200,
      // Web Serial's default 255-byte buffer stalls the loader's 4 KB packets
      // midway: Chrome stops taking data off USB (measured: a flash read stopped
      // after 1522 of 3074 bytes, every time; with this, at once).
      serialOptions: { bufferSize: SERIAL_BUFFER },
      terminal: { clean() {}, writeLine: (s) => log(s + "\n"), write: log },
    });
    const board = new Board(transport, loader);
    try {
      await loader.main(inLoader ? "no_reset" : "default_reset");
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

  /**
   * Read flash, checked against the MD5 the loader's stub sends after the data
   * (esptool-js 0.7 leaves that packet unread, and it would arrive ahead of the
   * next command's answer).
   */
  async readFlash(offset, size) {
    const data = await this.loader.readFlash(offset, size);
    const digest = await this.loader.transport.read(3000);
    const hex = Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
    if (digest.length !== 16 || hex !== md5hex(data)) {
      throw new BoardError("Reading the board's flash gave damaged data. Unplug the board, plug it in again, and retry.");
    }
    return data;
  }

  /** What the flash holds: its partition table, and the first app in it with a descriptor. */
  async read() {
    const tableBytes = await this.readFlash(TABLE_OFFSET, TABLE_SIZE);
    const table = parseTable(tableBytes);
    let app = null;
    for (const p of (table ?? []).filter((p) => p.type === 0)) {
      const desc = parseApp(await this.readFlash(p.offset, APP_HEAD_SIZE));
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
