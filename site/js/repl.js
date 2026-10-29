// MicroPython's raw REPL over Web Serial, as mpremote uses it: enough to ask
// the board a question and to write files. The board runs this firmware, on
// TinyUSB's serial port.

const CTRL_A = "\x01", CTRL_B = "\x02", CTRL_C = "\x03", CTRL_D = "\x04";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class ReplError extends Error {}

export class Repl {
  static async open(port) {
    // A bigger buffer than Web Serial's default 255 bytes, which can stall a
    // stream from the board (see board.js).
    await port.open({ baudRate: 115200, bufferSize: 64 * 1024 });
    const repl = new Repl(port);
    try {
      await repl.enter();
    } catch (e) {
      await repl.close();
      throw e;
    }
    return repl;
  }

  constructor(port) {
    this.port = port;
    this.writer = port.writable.getWriter();
    this.reader = port.readable.getReader();
    this.buf = "";
    this.dec = new TextDecoder();
    this.closed = false;
    this.pump = this.readLoop();
  }

  async readLoop() {
    try {
      for (;;) {
        const { value, done } = await this.reader.read();
        if (done) break;
        this.buf += this.dec.decode(value, { stream: true });
      }
    } catch {
      // The board left USB (a reset) or the port was closed.
    }
    this.closed = true;
  }

  write(text) {
    return this.writer.write(new TextEncoder().encode(text));
  }

  /** What arrived up to and including `mark`, which is consumed; ReplError after `ms`. */
  async until(mark, ms) {
    const end = Date.now() + ms;
    for (;;) {
      const at = this.buf.indexOf(mark);
      if (at >= 0) {
        const out = this.buf.slice(0, at);
        this.buf = this.buf.slice(at + mark.length);
        return out;
      }
      if (this.closed) throw new ReplError("the board left USB");
      if (Date.now() > end) throw new ReplError(`the board did not answer (waiting for ${JSON.stringify(mark)})`);
      await sleep(10);
    }
  }

  /** Stop whatever runs (an app's main.py) and enter the raw REPL. */
  async enter() {
    for (let attempt = 0; ; attempt++) {
      await this.write("\r" + CTRL_C + CTRL_C);
      await sleep(200);
      this.buf = "";
      await this.write(CTRL_A);
      try {
        await this.until("raw REPL; CTRL-B to exit\r\n>", 2000);
        return;
      } catch (e) {
        // A board that has only just started may miss the first Ctrl-C.
        if (attempt >= 4) throw e;
      }
    }
  }

  /** Run code; what it printed. A Python exception becomes a ReplError with its text. */
  async exec(code, ms = 10000) {
    await this.write(code);
    await this.write(CTRL_D);
    const ok = await this.until(CTRL_D, ms);
    if (!ok.startsWith("OK")) throw new ReplError(`the board did not take the code: ${ok}`);
    const out = ok.slice(2);
    const err = await this.until(CTRL_D, ms);
    await this.until(">", ms);
    if (err) throw new ReplError(err.trim());
    return out;
  }

  /**
   * Write a file: in pieces to path + ".part", checked by SHA-256 on the board,
   * then renamed over path, so a board cut off on the way keeps the old file.
   * `progress` gets 0..1.
   */
  async writeFile(path, data, sha256, progress = () => {}) {
    const part = path + ".part";
    await this.exec(`import binascii, hashlib, os\nf = open(${JSON.stringify(part)}, "wb")`);
    const CHUNK = 1536;
    for (let at = 0; at < data.length; at += CHUNK) {
      const piece = data.subarray(at, at + CHUNK);
      const b64 = btoa(String.fromCharCode(...piece));
      await this.exec(`f.write(binascii.a2b_base64("${b64}"))`);
      progress(Math.min(1, (at + CHUNK) / data.length));
    }
    const got = (await this.exec(
      `f.close()\nh = hashlib.sha256()\nwith open(${JSON.stringify(part)}, "rb") as f:\n` +
      `    while True:\n        b = f.read(2048)\n        if not b:\n            break\n        h.update(b)\n` +
      `print(binascii.hexlify(h.digest()).decode())`)).trim();
    if (got !== sha256) {
      await this.exec(`os.remove(${JSON.stringify(part)})`).catch(() => {});
      throw new ReplError(`${path} arrived damaged on the board`);
    }
    await this.exec(`os.rename(${JSON.stringify(part)}, ${JSON.stringify(path)})`);
  }

  /** Leave the raw REPL and soft-reset: the board starts its main.py. Then let go of the port. */
  async restartApp() {
    await this.write(CTRL_B);
    await sleep(100);
    await this.write(CTRL_D);
    await sleep(300);
    await this.close();
  }

  async close() {
    try {
      this.reader.cancel().catch(() => {});
      this.reader.releaseLock();
    } catch {
      // Already released.
    }
    try {
      this.writer.releaseLock();
    } catch {
      // Already released.
    }
    await this.port.close().catch(() => {});
  }
}
