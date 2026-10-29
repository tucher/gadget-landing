// Improv over Web Bluetooth (improv-wifi.com/ble): give the board a Wi-Fi
// network. The board offers it while its app runs Wi-Fi setup (hello-pendant
// does by itself when it has no network). Besides the standard commands, the
// board answers "request scanned Wi-Fi networks" (RPC 4): the networks it can
// see, so the person picks one instead of typing its name.

const uuid = (n) => `00467768-6228-2272-4663-27747826800${n}`;
export const SERVICE = uuid(0);
const STATE = uuid(1), ERROR = uuid(2), RPC = uuid(3), RESULT = uuid(4), CAPS = uuid(5);

const AUTHORIZED = 2, PROVISIONING = 3, PROVISIONED = 4;
const SEND_WIFI = 1, DEVICE_INFO = 3, SCAN = 4;
const CAP_DEVICE_INFO = 0x02, CAP_SCAN = 0x04;
const ERRORS = {
  1: "The board did not understand the request.",
  2: "The board does not know this request.",
  3: "The board could not join that network: check the password, and that the network is in range.",
  4: "The board did not allow the setup: turn Wi-Fi setup on on the board.",
};

/** A failure to show as it is. */
export class ImprovError extends Error {}

function packet(cmd, strings = []) {
  const enc = new TextEncoder();
  const parts = strings.map((s) => enc.encode(s));
  const data = [];
  for (const p of parts) data.push(p.length, ...p);
  const p = [cmd, data.length, ...data];
  p.push(p.reduce((a, b) => a + b, 0) & 0xff);
  return new Uint8Array(p);
}

function strings(bytes) {
  const out = [];
  const dec = new TextDecoder();
  for (let i = 2; i < 2 + bytes[1]; i += 1 + bytes[i]) out.push(dec.decode(bytes.subarray(i + 1, i + 1 + bytes[i])));
  return out;
}

export class Improv {
  /** Ask the person to pick the board in Chrome's list, and connect. Must be called from a click. */
  static async pick() {
    const device = await navigator.bluetooth.requestDevice({ filters: [{ services: [SERVICE] }] });
    const improv = new Improv(device);
    await improv.connect();
    return improv;
  }

  constructor(device) {
    this.device = device;
    this.name = device.name || "the board";
    this.results = [];      // [command, strings] as they arrive
    this.waiters = [];
    this.state = 0;
    this.error = 0;
  }

  async connect() {
    const server = await this.device.gatt.connect();
    const svc = await server.getPrimaryService(SERVICE);
    const ch = async (u) => svc.getCharacteristic(u);
    this.rpc = await ch(RPC);
    this.caps = (await (await ch(CAPS)).readValue()).getUint8(0);
    for (const [u, on] of [[STATE, (v) => { this.state = v.getUint8(0); }],
      [ERROR, (v) => { this.error = v.getUint8(0); }],
      [RESULT, (v) => { const b = new Uint8Array(v.buffer); this.results.push([b[0], strings(b)]); }]]) {
      const c = await ch(u);
      c.addEventListener("characteristicvaluechanged", (e) => { on(e.target.value); this.wake(); });
      await c.startNotifications();
      on(await c.readValue());
    }
  }

  wake() {
    for (const w of this.waiters.splice(0)) w();
  }

  /** Wait until `test()` is true; ImprovError(`what`) after `ms`. */
  async until(test, ms, what) {
    const end = Date.now() + ms;
    while (!test()) {
      if (!this.device.gatt.connected) throw new ImprovError("The board disconnected.");
      const left = end - Date.now();
      if (left <= 0) throw new ImprovError(what);
      await new Promise((r) => { this.waiters.push(r); setTimeout(r, Math.min(left, 500)); });
    }
  }

  /** The next result of `cmd`. */
  async result(cmd, ms, what) {
    let got;
    await this.until(() => {
      const i = this.results.findIndex(([c]) => c === cmd);
      if (i >= 0) got = this.results.splice(i, 1)[0][1];
      return got !== undefined;
    }, ms, what);
    return got;
  }

  get canScan() {
    return !!(this.caps & CAP_SCAN);
  }

  /** [firmware, version, chip, name], if the board says. */
  async info() {
    if (!(this.caps & CAP_DEVICE_INFO)) return null;
    await this.rpc.writeValueWithResponse(packet(DEVICE_INFO));
    return this.result(DEVICE_INFO, 5000, "The board did not say what it is.");
  }

  /** The networks the board sees, strongest first: [{ssid, rssi, secure}]. */
  async scan() {
    this.results = this.results.filter(([c]) => c !== SCAN);
    await this.rpc.writeValueWithResponse(packet(SCAN));
    const nets = [];
    for (;;) {
      const s = await this.result(SCAN, 20000, "The board did not finish looking for networks.");
      if (!s.length) break;
      nets.push({ ssid: s[0], rssi: Number(s[1]), secure: s[2] !== "NO" });
    }
    return nets.sort((a, b) => b.rssi - a.rssi);
  }

  /** Join a network; the link the board offers (or null) once it is on it. */
  async provision(ssid, password) {
    if (this.state !== AUTHORIZED && this.state !== PROVISIONED) {
      throw new ImprovError("The board is not ready for a network: turn Wi-Fi setup on on the board.");
    }
    this.results = this.results.filter(([c]) => c !== SEND_WIFI);
    this.error = 0;
    await this.rpc.writeValueWithResponse(packet(SEND_WIFI, [ssid, password]));
    await this.until(() => this.state === PROVISIONING || this.error, 5000, "The board did not start joining.");
    await this.until(() => this.state === PROVISIONED || this.error || this.state === AUTHORIZED, 60000,
      "The board did not join within a minute.");
    if (this.state !== PROVISIONED) throw new ImprovError(ERRORS[this.error] ?? `The board reported error ${this.error}.`);
    const r = this.results.find(([c]) => c === SEND_WIFI);
    return r && r[1].length ? r[1][0] : null;
  }

  disconnect() {
    if (this.device.gatt.connected) this.device.gatt.disconnect();
  }
}
