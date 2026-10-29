// The installer page: fetch the published firmware as soon as the page opens,
// then, on a click, connect to the board, decide between an update and a
// fresh install (image.js), ask before anything is erased, and write.

import { Board, BoardError, pickPort } from "./board.js";
import { describeImage, plan } from "./image.js";

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
  log: $("log"),
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

  const bin = await fetch(`firmware/${manifest.file}`);
  if (!bin.ok) throw new Notice(`The firmware did not download (HTTP ${bin.status}). Reload the page to try again.`);
  const image = new Uint8Array(await bin.arrayBuffer());
  if (hex(await crypto.subtle.digest("SHA-256", image)) !== manifest.sha256) {
    throw new Notice("The firmware download is damaged. Reload the page to try again.");
  }
  return { manifest, image, info: describeImage(image) };
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
  return `Something went wrong: ${m}. The log below has the details.`;
}

async function install(firmware) {
  let port;
  try {
    port = await pickPort();
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
    say("Connecting to the board…");
    board = await Board.open(port, log);
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
    progress(null);
    say(`Done. The board is starting firmware ${fw.manifest.version}.`, "ok");
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
