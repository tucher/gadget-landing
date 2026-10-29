// The installer page: fetch the published firmware and its app as soon as the
// page opens; on a click, get the board into its ROM loader (board.js),
// decide between an update and a fresh install (image.js), ask before
// anything is erased, write, start the firmware, and write the app's files
// through the REPL (repl.js). Then, separately, Wi-Fi over Improv
// (improv.js), with the networks the board itself sees.

import { Board, BoardError, USB_SERIAL_JTAG_PID, enterLoader, isTinyUsb, pickPort, waitForPort } from "./board.js";
import { describeImage, plan } from "./image.js";
import { Improv, ImprovError } from "./improv.js";
import { Repl, ReplError } from "./repl.js";

const $ = (id) => document.getElementById(id);
const ui = {
  fw: $("fw"),
  go: $("go"),
  bar: $("bar"),
  status: $("status"),
  confirm: $("confirm"),
  confirmText: $("confirm-text"),
  yes: $("confirm-yes"),
  no: $("confirm-no"),
  again: $("again"),
  againText: $("again-text"),
  againGo: $("again-go"),
  log: $("log"),
  wifiGo: $("wifi-go"),
  wifiForm: $("wifi-form"),
  wifiSsid: $("wifi-ssid"),
  wifiOther: $("wifi-other"),
  wifiPass: $("wifi-pass"),
  wifiRescan: $("wifi-rescan"),
  wifiStatus: $("wifi-status"),
};

/** A failure whose message is meant for the person at the page as it is. */
class Notice extends Error {}

const hex = (buf) => Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");

function log(text) {
  ui.log.textContent += text;
}

function say(text, tone = "") {
  ui.status.textContent = text;
  ui.status.className = tone;
}

/** null hides the bar, "busy" shows it moving, 0..1 shows how far. */
function progress(value) {
  ui.bar.hidden = value === null;
  ui.bar.classList.toggle("busy", value === "busy");
  if (typeof value === "number") ui.bar.firstElementChild.style.width = `${Math.round(value * 100)}%`;
}

const leaving = (e) => {
  e.preventDefault();
  e.returnValue = "";
};

function busy(on) {
  ui.go.disabled = on;
  if (on) addEventListener("beforeunload", leaving);
  else removeEventListener("beforeunload", leaving);
}

async function loadFirmware() {
  const res = await fetch("firmware/manifest.json", { cache: "no-cache" });
  if (res.status === 404) throw new Notice("No firmware has been published yet.");
  if (!res.ok) throw new Notice(`The firmware list did not load (HTTP ${res.status}). Reload the page to try again.`);
  const manifest = await res.json();
  ui.fw.textContent = `Firmware ${manifest.version} · built ${manifest.built} · ${(manifest.size / 1048576).toFixed(1)} MB`;
  ui.go.disabled = false;

  const image = await download(manifest.file, manifest.sha256, "firmware");
  const app = [];
  for (const f of manifest.app?.files ?? []) app.push({ ...f, data: await download(f.file, f.sha256, f.path) });
  return { manifest, image, info: describeImage(image), app };
}

async function download(file, sha256, what) {
  const res = await fetch(`firmware/${file}`);
  if (!res.ok) throw new Notice(`The ${what} did not download (HTTP ${res.status}). Reload the page to try again.`);
  const data = new Uint8Array(await res.arrayBuffer());
  if (hex(await crypto.subtle.digest("SHA-256", data)) !== sha256) {
    throw new Notice(`The ${what} download is damaged. Reload the page to try again.`);
  }
  return data;
}

/**
 * Show `text` with a button; on its click, Chrome's port chooser (the loader's
 * port only if `loader`). Chrome asks for each USB device once: the board in
 * its loader is another device than the board running the firmware.
 */
function chooseAgain(text, button, loader) {
  ui.againText.textContent = text;
  ui.againGo.textContent = button;
  ui.again.hidden = false;
  ui.againGo.focus();
  return new Promise((resolve, reject) => {
    ui.againGo.onclick = async () => {
      try {
        const port = await pickPort(loader);
        ui.again.hidden = true;
        ui.againGo.onclick = null;
        resolve(port);
      } catch (e) {
        if (e.name !== "NotFoundError") { // NotFoundError: the chooser was closed; the button stays
          ui.again.hidden = true;
          reject(e);
        }
      }
    };
  });
}

const espressif = (p) => p.getInfo().usbVendorId === 0x303a;
const inLoader = (p) => espressif(p) && p.getInfo().usbProductId === USB_SERIAL_JTAG_PID;

/** The board's ROM loader port, and whether the board is already in the loader. */
async function loaderPort(port) {
  if (!isTinyUsb(port)) return { port, inLoader: false };
  say("Asking the board into its download mode…");
  if (!(await enterLoader(port))) {
    throw new BoardError("The board did not switch to its download mode. Hold BOOT and short-press PWR " +
      "(long-press PWR first if the board is on), then install again.");
  }
  say("Waiting for the board in download mode…");
  const loader = await waitForPort(inLoader, 6000) ??
    await chooseAgain("The board is now in its download mode, where it is another USB device: " +
      "choose it once more (“USB JTAG/serial debug unit”).", "Choose the board", true);
  return { port: loader, inLoader: true };
}

/**
 * The app goes onto the board through the REPL once the firmware runs: only
 * where there is no app yet or it is this one, never over another app. The
 * board then starts it.
 */
async function installApp(fw) {
  if (!fw.app.length) return null;
  const name = fw.manifest.app.name;
  say("Waiting for the new firmware to start…");
  progress("busy");
  const port = await waitForPort(isTinyUsb, 20000) ??
    await chooseAgain("The firmware is running, as yet another USB device: choose the board once more " +
      `to put ${name} on it.`, "Choose the board", false);
  const repl = await Repl.open(port);
  try {
    const head = await repl.exec("import os\nprint(open('main.py').read(300) if 'main.py' in os.listdir() else '')");
    if (head.trim() && !head.includes(name)) {
      log(`main.py is another app; ${name} not installed\n`);
      return `The board keeps its own app; ${name} was not installed.`;
    }
    let done = 0;
    const total = fw.app.reduce((n, f) => n + f.data.length, 0);
    for (const f of fw.app) {
      say(`Putting ${name} on the board: ${f.path}…`);
      await repl.writeFile(f.path, f.data, f.sha256, (x) => progress((done + x * f.data.length) / total));
      done += f.data.length;
      log(`${f.path}: ${f.data.length} bytes written and checked\n`);
    }
    return null;
  } finally {
    await repl.restartApp();
  }
}

function describe(desc) {
  const name = [desc.project, desc.version].filter(Boolean).join(" ") || "unnamed firmware";
  return `${name}, built ${desc.date}`;
}

/** What to ask before going ahead, or null to go ahead. */
function question(p, onBoard) {
  if (p.kind === "update") {
    return p.sameBuild
      ? { text: "The board already runs this build. Install it again? Its files and settings stay.", yes: "Install again" }
      : null;
  }
  if (!onBoard.table) return null; // erased flash: nothing to lose
  const lost = p.erase.map((r) => r.what).join(" and ");
  const what = p.installed ? ` (${describe(p.installed.desc)})` : "";
  return {
    text: `The board has other firmware${what}, or an older layout of this one. ` +
      `Installing replaces it and erases the ${lost} stored on the board.`,
    yes: "Erase and install",
  };
}

function ask({ text, yes }) {
  ui.confirmText.textContent = text;
  ui.yes.textContent = yes;
  ui.confirm.hidden = false;
  ui.yes.focus();
  return new Promise((resolve) => {
    const answer = (value) => {
      ui.confirm.hidden = true;
      ui.yes.onclick = ui.no.onclick = null;
      resolve(value);
    };
    ui.yes.onclick = () => answer(true);
    ui.no.onclick = () => answer(false);
  });
}

function explain(e, writing) {
  const m = String(e?.message ?? e);
  if (e instanceof Notice || e instanceof BoardError) return m;
  if (writing) {
    return `The installation stopped (${m}). The board may not start until it is installed again, so install again.`;
  }
  if (/Failed to open serial port/i.test(m)) {
    return "The board's port is busy. Close mpremote, serial monitors or other tabs that use it, and try again.";
  }
  if (/Failed to connect/i.test(m)) {
    return "The board did not answer. Unplug it and plug it in again, or see “The board is not in the list” below.";
  }
  if (e instanceof ReplError) {
    return `The firmware is installed, but its app could not be put on the board (${m}). Install again to retry.`;
  }
  return `Something went wrong: ${m}. The log below has the details.`;
}

async function install(firmware) {
  // One allowed board plugged in: no need to ask which.
  const allowed = (await navigator.serial.getPorts()).filter(espressif);
  let port = allowed.length === 1 ? allowed[0] : null;
  try {
    port ??= await pickPort();
  } catch (e) {
    if (e.name !== "NotFoundError") say(explain(e, false), "error"); // NotFoundError: the chooser was closed
    return;
  }

  busy(true);
  let board = null;
  let writing = false;
  try {
    say("Getting the firmware ready…");
    progress("busy");
    const fw = await firmware;
    const loader = await loaderPort(port);
    say("Connecting to the board…");
    progress("busy");
    board = await Board.open(loader.port, log, loader.inLoader);
    log(`Board: ${board.chip}, MAC ${board.mac}\n`);
    say("Reading what is installed…");
    const onBoard = await board.read();
    const p = plan(fw.info, onBoard);
    const regions = p.erase.map((r) => `${r.what} 0x${r.offset.toString(16)}+0x${r.size.toString(16)}`);
    log(`Plan: ${p.kind}${regions.length ? ", erase " + regions.join(", ") : ""}\n`);

    const q = question(p, onBoard);
    if (q) {
      progress(null);
      say("");
      if (!(await ask(q))) {
        say("Nothing was changed.");
        return;
      }
    }

    writing = true;
    for (const r of p.erase) {
      say(`Erasing the ${r.what} on the board…`);
      progress("busy");
      await board.erase(r.offset, r.size);
    }
    say("Writing the firmware…");
    progress(0);
    await board.write(fw.image, (f) => {
      progress(f);
      if (f >= 1) say("Checking what was written…");
    });
    writing = false;

    say("Starting the new firmware…");
    progress("busy");
    await board.restart();
    board = null;
    const kept = await installApp(fw);
    progress(null);
    const app = fw.app.length && !kept ? ` and ${fw.manifest.app.name}` : "";
    say(`Done: the board runs firmware ${fw.manifest.version}${app}. ${kept ?? ""}`.trim() +
      (app ? " Next, Wi-Fi below." : ""), "ok");
  } catch (e) {
    progress(null);
    log(`\n${e?.stack ?? e}\n`);
    say(explain(e, writing), "error");
  } finally {
    // Leave the board in its loader only after a write that did not finish,
    // where starting it would run half an image; otherwise start what it has.
    if (board) await (writing ? board.close() : board.restart().catch(() => board.close()));
    busy(false);
  }
}

// -- Wi-Fi ------------------------------------------------------------------

let improv = null;

function wifiSay(text, tone = "") {
  ui.wifiStatus.textContent = text;
  ui.wifiStatus.className = tone;
}

const bars = (rssi) => (rssi >= -55 ? "▂▄▆█" : rssi >= -67 ? "▂▄▆" : rssi >= -78 ? "▂▄" : "▂");

function showNetworks(nets) {
  ui.wifiSsid.replaceChildren();
  for (const n of nets) {
    const o = new Option(`${n.ssid}   ${bars(n.rssi)}${n.secure ? "  🔒" : ""}`, n.ssid);
    o.dataset.secure = n.secure ? "1" : "";
    ui.wifiSsid.add(o);
  }
  ui.wifiSsid.add(new Option("Another network…", ""));
  ui.wifiSsid.hidden = false;
  pickedNetwork();
}

function pickedNetwork() {
  const other = ui.wifiSsid.hidden || ui.wifiSsid.value === "";
  ui.wifiOther.hidden = !other;
  const o = ui.wifiSsid.selectedOptions[0];
  ui.wifiPass.disabled = !other && o && !o.dataset.secure;
  (other ? ui.wifiOther : ui.wifiPass).focus();
}

async function lookForNetworks() {
  ui.wifiRescan.disabled = true;
  wifiSay("The board is looking for networks…");
  try {
    const nets = await improv.scan();
    showNetworks(nets);
    wifiSay(nets.length ? `The board sees ${nets.length} network${nets.length === 1 ? "" : "s"}.`
      : "The board sees no network. Type its name, or look again.", nets.length ? "" : "warn");
  } finally {
    ui.wifiRescan.disabled = false;
  }
}

async function wifiStart() {
  ui.wifiGo.disabled = true;
  try {
    improv?.disconnect();
    wifiSay("Choose the board in Chrome's list (an app on it must offer Wi-Fi setup)…");
    try {
      improv = await Improv.pick();
    } catch (e) {
      if (e.name === "NotFoundError") { // the chooser was closed
        wifiSay("");
        return;
      }
      throw e;
    }
    const info = await improv.info();
    log(`Improv: ${improv.name}${info ? ", " + info.join(", ") : ""}, capabilities 0x${improv.caps.toString(16)}\n`);
    ui.wifiForm.hidden = false;
    ui.wifiSsid.hidden = true;
    ui.wifiRescan.hidden = !improv.canScan;
    if (improv.canScan) await lookForNetworks();
    else {
      pickedNetwork();
      wifiSay("Type the network's name and password.");
    }
  } catch (e) {
    log(`\n${e?.stack ?? e}\n`);
    wifiSay(e instanceof ImprovError ? e.message : `The board could not be reached over Bluetooth: ${e.message}`, "error");
  } finally {
    ui.wifiGo.disabled = false;
  }
}

async function wifiJoin(ev) {
  ev.preventDefault();
  const ssid = ui.wifiSsid.hidden || ui.wifiSsid.value === "" ? ui.wifiOther.value.trim() : ui.wifiSsid.value;
  if (!ssid) {
    wifiSay("Choose or type a network.", "warn");
    return;
  }
  const submit = ui.wifiForm.querySelector("button[type=submit]");
  submit.disabled = true;
  wifiSay(`The board is joining ${ssid}…`);
  try {
    const url = await improv.provision(ssid, ui.wifiPass.disabled ? "" : ui.wifiPass.value);
    wifiSay(`The board is on ${ssid}${url ? ` at ${url.replace(/^https?:\/\//, "").replace(/\/$/, "")}` : ""}. ` +
      "It keeps the network and joins it whenever it starts.", "ok");
    ui.wifiForm.hidden = true;
    improv.disconnect();
    improv = null;
  } catch (e) {
    log(`\n${e?.stack ?? e}\n`);
    wifiSay(e instanceof ImprovError ? e.message : `Something went wrong: ${e.message}`, "error");
  } finally {
    submit.disabled = false;
  }
}

if (!("bluetooth" in navigator)) {
  ui.wifiGo.disabled = true;
  wifiSay("This browser cannot reach Bluetooth devices: use Chrome or Edge on a computer.", "warn");
} else {
  ui.wifiGo.addEventListener("click", wifiStart);
  ui.wifiForm.addEventListener("submit", wifiJoin);
  ui.wifiSsid.addEventListener("change", pickedNetwork);
  ui.wifiRescan.addEventListener("click", () => lookForNetworks().catch((e) => wifiSay(e.message, "error")));
}

if (!("serial" in navigator)) {
  ui.fw.textContent = "This browser cannot reach USB devices.";
  say("Open this page in Chrome or Edge on a computer.", "warn");
} else {
  const firmware = loadFirmware();
  firmware.catch((e) => {
    ui.go.disabled = true;
    ui.fw.textContent = e instanceof Notice ? e.message : `The firmware did not load: ${e.message}`;
  });
  ui.go.addEventListener("click", () => install(firmware));
}
