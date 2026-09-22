import { initializeApp } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-app.js";
import { getDatabase, ref, set, update, onValue } from "https://www.gstatic.com/firebasejs/12.19.0/firebase-database.js";
import { firebaseConfig } from "./firebase-config.js";

const app = initializeApp(firebaseConfig);
const db = getDatabase(app);

const COLS = 32, ROWS = 18, TOTAL = COLS * ROWS; // LOGICAL art grid — all movies/games render here (live-safe)

// PHYSICAL wall/DB grid. LD = 32x18 (matches old live site). HD = 64x36 (matches upgraded live files).
// In HD every logical pixel is written as a 2x2 block, so all art appears 2x bigger on live.
let HD = false, PCOLS = 32, PROWS = 18, PTOTAL = 576;

function buildWall() {
  wallEl.innerHTML = "";
  wallEl.style.gridTemplateColumns = `repeat(${PCOLS}, 1fr)`;
  for (let i = 0; i < PTOTAL; i++) {
    const cell = document.createElement("button");
    cell.dataset.index = i;
    cell.setAttribute("aria-label", "Square " + (i + 1));
    wallEl.append(cell);
  }
}

// logical 32x18 index -> 4 physical 64x36 indices (2x2 block)
function expandIdx(li) {
  const lx = li % COLS, ly = (li / COLS) | 0;
  const bx = lx * 2, by = ly * 2, base = by * PCOLS + bx;
  return [base, base + 1, base + PCOLS, base + PCOLS + 1];
}

function applyHD(on) {
  if (on && !confirm("HD writes 2304 squares but gyanl.com was NEVER upgraded — live viewers would only see scrambled top rows. Turn HD on anyway?")) return;
  HD = on;
  PCOLS = on ? 64 : 32; PROWS = on ? 36 : 18; PTOTAL = PCOLS * PROWS;
  buildWall();
  try { localStorage.setItem("wall-hd", on ? "1" : "0"); } catch {}
  document.querySelector("#b-hd-on")?.classList.toggle("zoom-on", on);
  document.querySelector("#b-hd-off")?.classList.toggle("zoom-on", !on);
  const note = document.querySelector("#hd-note");
  if (note) note.textContent = on
    ? "HD 64×36 ON — paints 2304 squares/live frame. Upload style.css + script.js to gyanl.com FIRST or live viewers see only the top rows."
    : "LD 32×18 — matches the current live site.";
  log(on ? "HD 64×36 enabled (2304 squares)" : "LD 32×18 enabled (576 squares)");
}
const wallEl = document.querySelector("#wall");
const statusEl = document.querySelector("#status");
const boardEl = document.querySelector("#leaderboard");
const cStatus = document.querySelector("#c-status");
const logEl = document.querySelector("#log");
const nameEl = document.querySelector("#c-name");
const colourEl = document.querySelector("#c-colour");

const log = (m) => {
  const t = new Date().toLocaleTimeString();
  logEl.textContent += `[${t}] ${m}\n`;
  logEl.scrollTop = logEl.scrollHeight;
  console.log(m);
};

const me = () => ({ name: (nameEl.value.trim() || "neelabh").slice(0, 20), colour: colourEl.value });

// force normal paint identity too
localStorage.setItem("wall-player", JSON.stringify(me()));
nameEl.addEventListener("change", () => localStorage.setItem("wall-player", JSON.stringify(me())));
colourEl.addEventListener("change", () => localStorage.setItem("wall-player", JSON.stringify(me())));

// grid (rebuilt by applyHD for LD/HD switching)
buildWall();

let latestPixels = {};
let guardianOn = false;
let lastWrite = 0;
let guardTimer = null;

function counts(pixels) {
  const per = {};
  for (let i = 0; i < PTOTAL; i++) {
    let s = pixels[i];
    if (typeof s === "string") s = { colour: s, name: "Anonymous" };
    if (!s) continue;
    if (!per[s.name]) per[s.name] = 0;
    per[s.name]++;
  }
  return per;
}

function showLeaderboard(pixels) {
  const per = counts(pixels);
  const colourOf = {};
  for (let i = 0; i < PTOTAL; i++) {
    const s = pixels[i];
    if (s && s.name && !(s.name in colourOf)) colourOf[s.name] = s.colour;
  }
  const top = Object.entries(per).map(([name, count]) => ({ name, count, colour: colourOf[name] || "#999" }))
    .sort((a, b) => b.count - a.count).slice(0, 10);
  const myName = me().name;
  boardEl.replaceChildren(...top.map((e) => {
    const li = document.createElement("li");
    li.innerHTML = "";
    const sw = document.createElement("span"); sw.className = "swatch"; sw.style.background = e.colour;
    const nm = document.createElement("span"); nm.className = "board-name"; nm.textContent = e.name;
    const ct = document.createElement("span"); ct.className = "board-count"; ct.textContent = e.count;
    li.append(sw, nm, ct);
    if (e.name === myName) li.classList.add("is-me");
    return li;
  }));
  return { per, top };
}

// live read — same DB as gyanl.com/wall, so this IS the live leaderboard
onValue(ref(db, "wall"), (snap) => {
  const pixels = snap.val() || {};
  latestPixels = pixels;
  const squares = [];
  for (const cell of wallEl.children) {
    let s = pixels[cell.dataset.index];
    if (typeof s === "string") s = { colour: s, name: "Anonymous" };
    cell.style.background = s ? s.colour : "";
    cell.title = s ? s.name : "";
    if (s) squares.push(s);
  }
  const { per, top } = showLeaderboard(pixels);
  const myName = me().name;
  const mine = per[myName] || 0;
  const others = Object.entries(per).filter(([n]) => n !== myName).sort((a, b) => b[1] - a[1]);
  const leader = others[0] ? `${others[0][0]}:${others[0][1]}` : "none";
  const maxOther = others[0] ? others[0][1] : 0;
  statusEl.textContent = `${squares.length} of ${PTOTAL} squares coloured`;
  cStatus.textContent = `YOU ${myName}=${mine} | leader ${leader} | max_other=${maxOther} | double=${Math.min(PTOTAL, maxOther * 2)} | guardian=${guardianOn ? "ON" : "OFF"} | ${HD ? "HD 64x36" : "LD 32x18"}`;

  // guardian: reclaim anything not mine, throttled to avoid loop
  if (guardianOn) {
    const now = Date.now();
    if (now - lastWrite < 900) return;
    const lost = [];
    for (let i = 0; i < PTOTAL; i++) {
      const s = pixels[i];
      const nm = typeof s === "string" ? "Anonymous" : s?.name;
      if (nm !== myName) lost.push(i);
    }
    if (lost.length > 0) {
      log(`guardian: reclaiming ${lost.length} squares...`);
      guardReclaim(lost); // physical indices — restores art, no expansion
    }
  }
});

async function bulkPaintPhysical(indices, verbose = true) {
  const { name, colour } = me();
  const updates = {};
  for (const i of indices) { if (i >= 0 && i < PTOTAL) updates[`wall/${i}`] = { colour, name }; }
  lastWrite = Date.now();
  await update(ref(db), updates);
  // optimistic paint
  for (const i of indices) { const c = wallEl.children[i]; if (c) c.style.background = colour; }
  if (verbose) log(`painted ${indices.length} as ${name} — live leaderboard updates in ~1s`);
}

// logical 32x18 indices -> physical wall (2x2 expansion in HD)
async function bulkPaint(indices, verbose = true) {
  if (!HD) return bulkPaintPhysical(indices, verbose);
  const physical = [];
  for (const li of indices) physical.push(...expandIdx(li));
  return bulkPaintPhysical(physical, verbose);
}

// Image-aware guardian: restores the actual last art (gradients included) on lost
// squares instead of a flat colour — classmates painting over your image get undone.
let lastArt = null;
async function guardReclaim(idxs) {
  const { name } = me();
  if (!HD && lastArt && lastArt.length === TOTAL) {
    const updates = {};
    for (const i of idxs) { if (i >= 0 && i < TOTAL) updates[`wall/${i}`] = { colour: lastArt[i], name }; }
    lastWrite = Date.now();
    await update(ref(db), updates);
    for (const i of idxs) { const el = wallEl.children[i]; if (el) el.style.background = lastArt[i]; }
    log(`guardian: restored ${idxs.length} art squares...`);
  } else {
    await bulkPaintPhysical(idxs, false);
  }
}

document.querySelector("#b-count").addEventListener("click", () => {
  const { per } = showLeaderboard(latestPixels);
  const sorted = Object.entries(per).sort((a, b) => b[1] - a[1]);
  log(`counts: ${JSON.stringify(sorted)} | TOTAL painted=${Object.values(per).reduce((a, b) => a + b, 0)}/${PTOTAL}`);
});

document.querySelector("#b-double").addEventListener("click", async () => {
  const myName = me().name;
  const per = counts(latestPixels);
  const scale = HD ? 4 : 1; // physical cells per logical pixel
  const maxOtherLogical = Math.max(0, ...Object.entries(per).filter(([n]) => n !== myName).map(([, c]) => Math.ceil(c / scale)));
  const targetLogical = Math.min(TOTAL, maxOtherLogical * 2 || TOTAL);
  log(`max_other=${maxOtherLogical} (logical) -> taking DOUBLE=${targetLogical} squares as ${myName}${HD ? " [HD 2x2 blocks]" : ""}`);
  const idx = Array.from({ length: targetLogical }, (_, i) => i);
  await bulkPaint(idx);
});

document.querySelector("#b-all").addEventListener("click", async () => {
  log(`taking ALL ${PTOTAL} as ${me().name}`);
  await bulkPaint(Array.from({ length: TOTAL }, (_, i) => i)); // logical full set (expands to full wall in HD)
});

document.querySelector("#b-guard-on").addEventListener("click", () => {
  guardianOn = true;
  document.querySelector("#b-guard-on").disabled = true;
  document.querySelector("#b-guard-off").disabled = false;
  log(`guardian ON for ${me().name} — will auto-reclaim + full re-assert every 4s`);
  guardTimer = setInterval(() => {
    if (!guardianOn) return;
    const myName = me().name;
    const lost = [];
    for (let i = 0; i < PTOTAL; i++) {
      const s = latestPixels[i];
      const nm = typeof s === "string" ? "Anonymous" : s?.name;
      if (nm !== myName) lost.push(i);
    }
    if (lost.length) { log(`guard timer: ${lost.length} lost, reclaiming`); guardReclaim(lost); }
  }, 4000);
});

document.querySelector("#b-guard-off").addEventListener("click", () => {
  guardianOn = false;
  clearInterval(guardTimer);
  document.querySelector("#b-guard-on").disabled = false;
  document.querySelector("#b-guard-off").disabled = true;
  log("guardian OFF");
});

// manual paint still works
let last = null;
const squareAt = (x, y) => {
  const box = wallEl.getBoundingClientRect();
  const col = Math.floor((x - box.left) / box.width * PCOLS);
  const row = Math.floor((y - box.top) / box.height * PROWS);
  if (col < 0 || col >= PCOLS || row < 0 || row >= PROWS) return null;
  return { col, row };
};
wallEl.addEventListener("pointerdown", (e) => {
  const p = squareAt(e.clientX, e.clientY);
  if (p) { const i = p.row * PCOLS + p.col; const { name, colour } = me(); wallEl.children[i].style.background = colour; set(ref(db, "wall/" + i), { colour, name }); last = p; }
});
wallEl.addEventListener("pointermove", (e) => {
  if (!last) return;
  const h = squareAt(e.clientX, e.clientY);
  if (!h || (h.col === last.col && h.row === last.row)) return;
  const steps = Math.max(Math.abs(h.col - last.col), Math.abs(h.row - last.row));
  const { name, colour } = me();
  for (let s = 1; s <= steps; s++) {
    const col = Math.round(last.col + (h.col - last.col) * s / steps);
    const row = Math.round(last.row + (h.row - last.row) * s / steps);
    const i = row * PCOLS + col;
    wallEl.children[i].style.background = colour;
    set(ref(db, "wall/" + i), { colour, name });
  }
  last = h;
});
window.addEventListener("pointerup", () => last = null);

log("win.js loaded — this writes to LIVE DB, same as gyanl.com/wall");

// ---------- PIXEL EMOJI + LED SIGN (LIVE) ----------
const preview = document.querySelector("#preview");
const pctx = preview.getContext("2d");
pctx.imageSmoothingEnabled = false;

async function bulkPaintMap(colours) {
  const { name } = me();
  // flatten to physical entries first (HD expands 1 logical -> 2x2 physical)
  const entries = [];
  if (!HD) {
    for (let i = 0; i < TOTAL; i++) entries.push([i, colours[i]]);
  } else {
    for (let li = 0; li < TOTAL; li++) for (const pi of expandIdx(li)) entries.push([pi, colours[li]]);
  }
  lastWrite = Date.now();
  // Huge stills (256-colour photos ≈ MBs) go out in sequential 96-path chunks so
  // every byte lands; small animation frames stay a single fast update. Same values either way.
  let est = 0;
  for (const [, c] of entries) est += c.length;
  const CHUNK = est > 262144 ? 96 : entries.length;
  for (let s = 0; s < entries.length; s += CHUNK) {
    const updates = {};
    const slice = entries.slice(s, s + CHUNK);
    for (const [pi, c] of slice) updates[`wall/${pi}`] = { colour: c, name };
    await update(ref(db), updates);
    for (const [pi, c] of slice) { const el = wallEl.children[pi]; if (el) el.style.background = c; }
    if (entries.length > CHUNK) log(`…${Math.min(s + CHUNK, entries.length)}/${entries.length} squares live`);
  }
  lastArt = colours.slice(0, TOTAL); // remember art for image-aware guardian
}

// ---------- BUDGET-GUARDED DELTA SENDER (video/slideshow stay under Firebase limits) ----------
// Firebase allows ~64MB/min writes for the WHOLE database (all users). We budget 40MB
// and only send squares that changed since the last sent frame. Frames that don't fit
// are dropped (video keeps playing) instead of killing the connection.
let bwBytes = 0, bwStart = Date.now();
const BW_BUDGET = 40 * 1024 * 1024;
function bwCheck(n) {
  const now = Date.now();
  if (now - bwStart > 60000) { bwBytes = 0; bwStart = now; }
  if (bwBytes + n > BW_BUDGET) return false;
  bwBytes += n;
  return true;
}
let lastSent = null; // last values actually written (576 wall values)
async function sendDelta(packed, { force = false } = {}) {
  const { name } = me();
  const updates = {};
  const changed = [];
  let est = 0;
  for (let i = 0; i < packed.length; i++) {
    if (!force && lastSent && lastSent[i] === packed[i]) continue;
    updates[`wall/${i}`] = { colour: packed[i], name };
    changed.push(i);
    est += packed[i].length + 48;
  }
  if (!changed.length) return { sent: true, changed: 0, bytes: 0, dropped: false };
  if (!bwCheck(est)) return { sent: false, changed: changed.length, bytes: est, dropped: true };
  lastWrite = Date.now();
  await update(ref(db), updates);
  for (const i of changed) { const c = wallEl.children[i]; if (c) c.style.background = packed[i]; }
  lastSent = packed.slice();
  return { sent: true, changed: changed.length, bytes: est, dropped: false };
}

// ---------- DISPLAY & CLARITY (local only, live-safe) ----------
let ART_BOLD = true, PREVIEW_GRID = true;
const PV_W = 320, PV_H = 180, PX = PV_W / COLS; // 10x scale

// ---------- SUBPIXEL QUADRANTS: 4 colours per square, zero server changes ----------
// A square's `colour` may be a plain #hex OR a conic-gradient string. The live page
// assigns it straight to style.background, so gradients render on gyanl.com as-is.
// Clock order from 12 o'clock: 0-25% top-right, 25-50% bottom-right, 50-75% bottom-left, 75-100% top-left.
function encodeQ(tl, tr, br, bl) {
  const n = (c) => (c || "#000000").toLowerCase();
  const a = n(tl), b = n(tr), c = n(br), d = n(bl);
  if (a === b && b === c && c === d) return a; // flat areas stay short plain hex
  return `conic-gradient(${b} 0 25%, ${c} 0 50%, ${d} 0 75%, ${a} 0 100%)`;
}
function decodeQ(s) {
  if (typeof s !== "string" || !s.startsWith("conic-gradient(")) return null;
  let m = s.match(/#[0-9a-fA-F]{6}/g) || [];
  if (m.length < 4) { // tolerate shorthand #rgb
    const short = s.match(/#[0-9a-fA-F]{3}(?![0-9a-fA-F])/g) || [];
    m = short.map((h) => ("#" + h[1] + h[1] + h[2] + h[2] + h[3] + h[3]));
  }
  if (m.length < 4) return null;
  const [tr, br, bl, tl] = m.slice(0, 4); // stored clock order
  return [tl.toLowerCase(), tr.toLowerCase(), br.toLowerCase(), bl.toLowerCase()];
}
const isQ = (s) => typeof s === "string" && s.startsWith("conic-gradient(");

// ---------- OCTANTS: 8 colours per square (smooth photos, still zero server changes) ----------
// 8 pie slices, 12.5% each, clockwise from 12 o'clock. Best for photos/gradients;
// quadrants stay best for crisp vector art (text, games).
function encodeO8(c) {
  const n = (v) => (v || "#000000").toLowerCase();
  const k = c.map(n);
  const all = k.every((v) => v === k[0]);
  if (all) return k[0];
  const half = k.every((v, i) => v === k[i < 4 ? 0 : 4]);
  if (half) return encodeQ(k[0], k[0], k[4], k[4]); // degenerate to 2-stop quadrant
  return `conic-gradient(${k[0]} 0 12.5%, ${k[1]} 0 25%, ${k[2]} 0 37.5%, ${k[3]} 0 50%, ${k[4]} 0 62.5%, ${k[5]} 0 75%, ${k[6]} 0 87.5%, ${k[7]} 0 100%)`;
}
function decodeO8(s) {
  if (typeof s !== "string" || !s.startsWith("conic-gradient(")) return null;
  const m = s.match(/#[0-9a-fA-F]{6}/g) || [];
  if (m.length < 8) return null;
  return m.slice(0, 8).map((h) => h.toLowerCase());
}
// unified: {type:'flat'|'q4'|'o8'|'b64'|'b256', colors:[...]}
function decodeWall(s) {
  if (typeof s !== "string") return { type: "flat", colors: ["#000000"] };
  if (s.includes("linear-gradient")) {
    const big = decode256(s);
    if (big) return { type: "b256", colors: big };
    const g = decode64(s);
    if (g) return { type: "b64", colors: g };
    return { type: "flat", colors: ["#000000"] };
  }
  if (!s.startsWith("conic-gradient(")) return { type: "flat", colors: [s || "#000000"] };
  const m = s.match(/#[0-9a-fA-F]{6}/g) || [];
  if (m.length >= 8) return { type: "o8", colors: m.slice(0, 8).map((h) => h.toLowerCase()) };
  const q = decodeQ(s);
  if (q) return { type: "q4", colors: q };
  return { type: "flat", colors: ["#000000"] };
}
// ---------- 64 COLOURS per square: 8 stacked gradient bands = 8x8 sub-pixels ----------
// One background layer per row-band, each clipped to its 12.5% strip: 8 layers x 8 stops.
// Hierarchical: uniform -> flat hex; quadrant-structured -> short conic; else full 64.
// NOTE: ~1KB per square -> use for one-shot images/emoji, NOT animations (payload).
function encode64(cells) {
  const n = (v) => (v || "#000000").toLowerCase();
  const k = cells.map(n);
  if (k.every((v) => v === k[0])) return k[0];
  // quadrant check: four 4x4 blocks uniform?
  const blocks = [];
  let isQ = true;
  for (let by = 0; by < 2; by++) for (let bx = 0; bx < 2; bx++) {
    const c0 = k[(by * 4) * 8 + bx * 4];
    for (let r = 0; r < 4 && isQ; r++) for (let c = 0; c < 4; c++) {
      if (k[(by * 4 + r) * 8 + bx * 4 + c] !== c0) { isQ = false; break; }
    }
    blocks.push(c0);
  }
  if (isQ) return encodeQ(blocks[0], blocks[1], blocks[3], blocks[2]); // tl,tr,br,bl
  const layers = [];
  for (let r = 0; r < 8; r++) {
    const stops = [];
    for (let c = 0; c < 8; c++) stops.push(`${k[r * 8 + c]} ${c * 12.5}%`, `${k[r * 8 + c]} ${(c + 1) * 12.5}%`);
    layers.push(`linear-gradient(90deg, ${stops.join(", ")}) 0 ${r * 12.5}%/100% 12.5% no-repeat`);
  }
  return layers.join(", ");
}
function decode64(s) {
  if (typeof s !== "string" || !s.includes("linear-gradient")) return null;
  const m = s.match(/#[0-9a-fA-F]{6}/g) || [];
  if (m.length < 128) return null;
  const out = new Array(64);
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) out[r * 8 + c] = m[r * 16 + c * 2].toLowerCase();
  return out;
}

// ---------- 256 COLOURS per square: 16 stacked bands = 16x16 sub-pixels ----------
// Same zero-server-change trick. ~7KB/square worst case -> stills + slow slideshow ONLY.
// Hierarchical: uniform -> flat; quadrant-structured -> short conic; else full 256.
function encode256(cells) {
  const n = (v) => (v || "#000000").toLowerCase();
  const k = cells.map(n);
  if (k.every((v) => v === k[0])) return k[0];
  const blocks = [];
  let isQ = true;
  for (let by = 0; by < 2; by++) for (let bx = 0; bx < 2; bx++) {
    const c0 = k[(by * 8) * 16 + bx * 8];
    for (let r = 0; r < 8 && isQ; r++) for (let c = 0; c < 8; c++) {
      if (k[(by * 8 + r) * 16 + bx * 8 + c] !== c0) { isQ = false; break; }
    }
    blocks.push(c0);
  }
  if (isQ) return encodeQ(blocks[0], blocks[1], blocks[3], blocks[2]); // tl,tr,br,bl
  const layers = [];
  for (let r = 0; r < 16; r++) {
    const stops = [];
    for (let c = 0; c < 16; c++) stops.push(`${k[r * 16 + c]} ${c * 6.25}%`, `${k[r * 16 + c]} ${(c + 1) * 6.25}%`);
    layers.push(`linear-gradient(90deg, ${stops.join(", ")}) 0 ${r * 6.25}%/100% 6.25% no-repeat`);
  }
  return layers.join(", ");
}
function decode256(s) {
  if (typeof s !== "string" || !s.includes("linear-gradient")) return null;
  const m = s.match(/#[0-9a-fA-F]{6}/g) || [];
  if (m.length < 512) return null;
  const out = new Array(256);
  for (let r = 0; r < 16; r++) for (let c = 0; c < 16; c++) out[r * 16 + c] = m[r * 32 + c * 2].toLowerCase();
  return out;
}
// average each pie slice over a 4x4 source block (128x72 image -> per-cell octants)
function cellOctants(d, cx, cy) {
  // d: ImageData array of 128x72 canvas; (cx,cy): top-left of 4x4 block
  const sum = Array.from({ length: 8 }, () => [0, 0, 0, 0]);
  for (let py = 0; py < 4; py++) for (let px = 0; px < 4; px++) {
    const o = (((cy + py) * 128) + (cx + px)) * 4;
    const dx = px + 0.5 - 2, dy = py + 0.5 - 2;
    let ang = Math.atan2(dx, -dy) * 180 / Math.PI;
    if (ang < 0) ang += 360;
    const s = Math.min(7, Math.floor(ang / 45));
    sum[s][0] += d[o]; sum[s][1] += d[o + 1]; sum[s][2] += d[o + 2]; sum[s][3]++;
  }
  // fallback: empty slice inherits block average
  let tr = 0, tg = 0, tb = 0, tn = 0;
  for (const s of sum) { tr += s[0]; tg += s[1]; tb += s[2]; tn += s[3]; }
  const avg = [tr / tn, tg / tn, tb / tn];
  return sum.map((s) => {
    const v = s[3] ? [s[0] / s[3], s[1] / s[3], s[2] / s[3]] : avg;
    return "#" + v.map((n) => Math.round(n).toString(16).padStart(2, "0")).join("");
  });
}

// pack a 64x36 frame (array of 2304 hex) into 576 wall values (hex or quadrant string)
function pack64(frame64) {
  const out = new Array(TOTAL);
  for (let ly = 0; ly < ROWS; ly++) for (let lx = 0; lx < COLS; lx++) {
    const x = lx * 2, y = ly * 2;
    out[ly * COLS + lx] = encodeQ(
      frame64[y * 64 + x], frame64[y * 64 + x + 1],
      frame64[(y + 1) * 64 + x + 1], frame64[(y + 1) * 64 + x]
    );
  }
  return out;
}

// ---------- HIRES 64x36 primitives (draw here, pack64() to quadrants for live) ----------
function newBuf64(bg = "#000000") { return new Array(64 * 36).fill(bg); }
function setPx64(b, x, y, c) { x |= 0; y |= 0; if (x < 0 || x >= 64 || y < 0 || y >= 36) return; b[y * 64 + x] = c; }
function linePx64(b, x0, y0, x1, y1, c) {
  x0 |= 0; y0 |= 0; x1 |= 0; y1 |= 0;
  const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx + dy, x = x0, y = y0;
  for (let i = 0; i < 160; i++) {
    setPx64(b, x, y, c);
    if (ART_BOLD) setPx64(b, x + 1, y, c);
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x += sx; }
    if (e2 <= dx) { err += dx; y += sy; }
  }
}
function disc64(b, cx, cy, r, c) {
  cx = Math.round(cx); cy = Math.round(cy);
  for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++) {
    if (x * x + y * y <= r * r + 0.5) setPx64(b, cx + x, cy + y, c);
  }
}
function drawText64(b, text, x0, y0, c) {
  const t = (text || "").toUpperCase();
  let cx = x0;
  for (const ch of t) {
    const g = FONT[ch] || FONT[" "];
    for (let r = 0; r < 7; r++) for (let cc = 0; cc < 5; cc++) if (g[r][cc] === "1") setPx64(b, cx + cc, y0 + r, c);
    cx += 6;
    if (cx >= 64) return;
  }
}
function drawSprite64(b, spr, x0, y0, c, c2 = null, s = 2) {
  for (let r = 0; r < spr.length; r++) for (let cc = 0; cc < spr[r].length; cc++) {
    const ch = spr[r][cc];
    const col = ch === "1" ? c : (ch === "2" && c2 ? c2 : null);
    if (!col) continue;
    for (let dy = 0; dy < s; dy++) for (let dx = 0; dx < s; dx++) setPx64(b, x0 + cc * s + dx, y0 + r * s + dy, col);
  }
}
function drawHeart64(b, x0, y0, c) {
  const H = ["0110110", "1111111", "1111111", "0111110", "0011100", "0001000"];
  for (let r = 0; r < H.length; r++) for (let cc = 0; cc < 7; cc++) if (H[r][cc] === "1") {
    setPx64(b, x0 + cc * 2, y0 + r * 2, c); setPx64(b, x0 + cc * 2 + 1, y0 + r * 2, c);
    setPx64(b, x0 + cc * 2, y0 + r * 2 + 1, c); setPx64(b, x0 + cc * 2 + 1, y0 + r * 2 + 1, c);
  }
}

const SPX = 5; // subpixel: 64*5=320 wide, 36*5=180 tall — same canvas
function drawPreview(colours) {
  pctx.imageSmoothingEnabled = false;
  pctx.fillStyle = "#000";
  pctx.fillRect(0, 0, PV_W, PV_H);
  for (let ly = 0; ly < ROWS; ly++) for (let lx = 0; lx < COLS; lx++) {
    const v = colours[ly * COLS + lx];
    const w = decodeWall(v);
    const ox = lx * 2 * SPX, oy = ly * 2 * SPX, cw = SPX * 2;
    if (w.type === "flat") {
      pctx.fillStyle = w.colors[0];
      pctx.fillRect(ox, oy, cw, cw);
    } else if (w.type === "q4") {
      const [tl, tr, br, bl] = w.colors;
      pctx.fillStyle = tl; pctx.fillRect(ox, oy, SPX, SPX);
      pctx.fillStyle = tr; pctx.fillRect(ox + SPX, oy, SPX, SPX);
      pctx.fillStyle = br; pctx.fillRect(ox + SPX, oy + SPX, SPX, SPX);
      pctx.fillStyle = bl; pctx.fillRect(ox, oy + SPX, SPX, SPX);
    } else if (w.type === "b64" || w.type === "b256") {
      // NxN sub-grid (8x8 or 16x16): sub-pixels get tiny on preview — still shows detail
      const n = w.type === "b64" ? 8 : 16, u = cw / n;
      for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
        pctx.fillStyle = w.colors[r * n + c];
        pctx.fillRect(ox + c * u, oy + r * u, u + 0.6, u + 0.6);
      }
    } else {
      // o8: 8 pie wedges, CSS slice i = [i*45,(i+1)*45)° clockwise from top
      const cx = ox + SPX, cy = oy + SPX, r = SPX * 1.42;
      for (let i = 0; i < 8; i++) {
        pctx.fillStyle = w.colors[i];
        pctx.beginPath();
        pctx.moveTo(cx, cy);
        pctx.arc(cx, cy, r, (i * 45 - 90) * Math.PI / 180, ((i + 1) * 45 - 90) * Math.PI / 180);
        pctx.closePath();
        pctx.fill();
      }
    }
  }
  if (PREVIEW_GRID) {
    pctx.lineWidth = 1;
    pctx.strokeStyle = "rgba(255,255,255,0.14)"; // square boundaries
    pctx.beginPath();
    for (let x = 1; x < COLS; x++) { pctx.moveTo(x * 2 * SPX + 0.5, 0); pctx.lineTo(x * 2 * SPX + 0.5, PV_H); }
    for (let y = 1; y < ROWS; y++) { pctx.moveTo(0, y * 2 * SPX + 0.5); pctx.lineTo(PV_W, y * 2 * SPX + 0.5); }
    pctx.stroke();
    pctx.strokeStyle = "rgba(255,255,255,0.05)"; // subpixel boundaries
    pctx.beginPath();
    for (let x = 1; x < 64; x++) { pctx.moveTo(x * SPX + 0.5, 0); pctx.lineTo(x * SPX + 0.5, PV_H); }
    for (let y = 1; y < 36; y++) { pctx.moveTo(0, y * SPX + 0.5); pctx.lineTo(PV_W, y * SPX + 0.5); }
    pctx.stroke();
  }
}

function setWallZoom(level) {
  wallEl.classList.remove("z1", "z2", "z3");
  if (level > 1) wallEl.classList.add("z" + level);
  for (const b of document.querySelectorAll("#z1,#z2,#z3")) b.classList.remove("zoom-on");
  document.querySelector("#z" + level)?.classList.add("zoom-on");
  try { localStorage.setItem("wall-zoom", String(level)); } catch {}
}

document.querySelector("#z1")?.addEventListener("click", () => setWallZoom(1));
document.querySelector("#z2")?.addEventListener("click", () => setWallZoom(2));
document.querySelector("#z3")?.addEventListener("click", () => setWallZoom(3));
document.querySelector("#b-hd-on")?.addEventListener("click", () => { stopAllModesQuiet(); applyHD(true); });
document.querySelector("#b-hd-off")?.addEventListener("click", () => { stopAllModesQuiet(); applyHD(false); });
document.querySelector("#b-clear-wall")?.addEventListener("click", async () => {
  if (!confirm(`Wipe ALL ${PTOTAL} live squares? Everyone's art will be erased.`)) return;
  try {
    const res = await fetch(`${firebaseConfig.databaseURL}/wall.json`, { method: "DELETE" });
    log(res.ok ? "🧹 live wall cleared" : "clear failed: " + res.status);
  } catch (e) { log("clear failed: " + e.message); }
});
try {
  localStorage.setItem("wall-hd", "0");
  applyHD(false); // always boot LD: live was never upgraded, HD writes display wrong there
  log("booted LD 32×18 (matches live site)");
} catch {}
document.querySelector("#bold-art")?.addEventListener("change", (e) => { ART_BOLD = e.target.checked; log("bold art " + (ART_BOLD ? "ON — thicker characters" : "OFF — thin 1px lines")); });
document.querySelector("#grid-art")?.addEventListener("change", (e) => { PREVIEW_GRID = e.target.checked; });
try {
  const zl = parseInt(localStorage.getItem("wall-zoom") || "1", 10);
  if (zl >= 1 && zl <= 3) setWallZoom(zl); else setWallZoom(1);
} catch { setWallZoom(1); }

function stopGuardianQuiet() {
  if (guardianOn) { guardianOn = false; clearInterval(guardTimer); document.querySelector("#b-guard-on").disabled = false; document.querySelector("#b-guard-off").disabled = true; log("guardian auto-paused for art/sign mode"); }
}

// --- emoji: raster any emoji at 64x36, pack 2x2 blocks to quadrant gradients ---
async function paintEmojiLive() {
  stopAllModesQuiet();
  const ch = (document.querySelector("#emoji-char").value || "😎").trim().slice(0, 4) || "😎";
  const { name } = me();
  const eq = document.querySelector("#emoji-quality")?.value || "b256";
  const EW = eq === "b256" ? 512 : eq === "b64" ? 256 : 64;
  const EH = eq === "b256" ? 288 : eq === "b64" ? 144 : 36;
  const cv = document.createElement("canvas"); cv.width = EW; cv.height = EH;
  const cx = cv.getContext("2d", { willReadFrequently: true });
  cx.clearRect(0, 0, EW, EH);
  cx.fillStyle = "#000000"; cx.fillRect(0, 0, EW, EH);
  cx.font = (eq === "b256" ? "240px" : eq === "b64" ? "120px" : "30px") + " 'Segoe UI Emoji','Noto Color Emoji',serif";
  cx.textAlign = "center"; cx.textBaseline = "middle";
  cx.fillText(ch, EW / 2, EH / 2 + (eq === "b256" ? 16 : eq === "b64" ? 8 : 2));
  const d = cx.getImageData(0, 0, EW, EH).data;
  const hexAt = (WW, x, y) => {
    const o = (y * WW + x) * 4;
    const r = d[o], g = d[o + 1], b = d[o + 2];
    if (r < 12 && g < 12 && b < 12) return "#000000";
    return "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");
  };
  const colours = new Array(TOTAL);
  let detail = 0;
  if (eq === "b256") {
    for (let ly = 0; ly < ROWS; ly++) for (let lx = 0; lx < COLS; lx++) {
      const cells = new Array(256);
      for (let r = 0; r < 16; r++) for (let c = 0; c < 16; c++) cells[r * 16 + c] = hexAt(512, lx * 16 + c, ly * 16 + r);
      const v = encode256(cells);
      if (v.length > 7) detail++;
      colours[ly * COLS + lx] = v;
    }
  } else if (eq === "b64") {
    for (let ly = 0; ly < ROWS; ly++) for (let lx = 0; lx < COLS; lx++) {
      const cells = new Array(64);
      for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) cells[r * 8 + c] = hexAt(256, lx * 8 + c, ly * 8 + r);
      const v = encode64(cells);
      if (v.length > 7) detail++;
      colours[ly * COLS + lx] = v;
    }
  } else {
    const px = (x, y) => hexAt(64, x, y);
    for (let ly = 0; ly < ROWS; ly++) for (let lx = 0; lx < COLS; lx++) {
      const x = lx * 2, y = ly * 2;
      const v = encodeQ(px(x, y), px(x + 1, y), px(x + 1, y + 1), px(x, y + 1));
      if (isQ(v)) detail++;
      colours[ly * COLS + lx] = v;
    }
  }
  drawPreview(colours);
  log(`emoji ${ch}: ${detail} multi-colour squares [${eq}], painting all ${HD ? PTOTAL : TOTAL} as ${name} (bg black) to hold leaderboard...`);
  await bulkPaintMap(colours);
  log(`emoji LIVE now [SUBPIXEL] — check gyanl.com/wall`);
  await verifyLive(colours);
}

for (let n = 1; n <= 5; n++) document.querySelector("#emoji-pick-" + n)?.addEventListener("click", (e) => { document.querySelector("#emoji-char").value = e.target.textContent; });
document.querySelector("#b-emoji").addEventListener("click", paintEmojiLive);

// --- image upload: sampled to 64x36 (quadrants) or 128x72 (octants), painted live ---
document.querySelector("#b-img")?.addEventListener("click", async () => {
  const f = document.querySelector("#img-file").files[0];
  if (!f) { log("choose an image file first"); return; }
  stopAllModesQuiet();
  const { name } = me();
  const url = URL.createObjectURL(f);
  try {
    const img = new Image();
    await new Promise((res, rej) => { img.onload = res; img.onerror = rej; img.src = url; });
    const fit = document.querySelector("#img-fit").value || "cover";
    const quality = document.querySelector("#img-quality")?.value || "b256";
    // AUTO-COMPRESS: always sample once at 512x288, then pick the richest
    // tier+bit-depth whose payload fits under 1MB. Starts at your selected quality.
    const SW = 512, SHH = 288, BUDGET = 950 * 1024;
    const cv = document.createElement("canvas"); cv.width = SW; cv.height = SHH;
    const cx = cv.getContext("2d", { willReadFrequently: true });
    cx.fillStyle = "#000000"; cx.fillRect(0, 0, SW, SHH);
    const s = fit === "cover"
      ? Math.max(SW / img.width, SHH / img.height)
      : Math.min(SW / img.width, SHH / img.height);
    const dw = img.width * s, dh = img.height * s;
    cx.imageSmoothingEnabled = true; cx.imageSmoothingQuality = "high";
    cx.drawImage(img, (SW - dw) / 2, (SHH - dh) / 2, dw, dh);
    const d = cx.getImageData(0, 0, SW, SHH).data;
    const avgRGB = (x0, y0, w, h) => {
      let r = 0, g = 0, b = 0, n = 0;
      for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) {
        const o = (y * SW + x) * 4;
        r += d[o]; g += d[o + 1]; b += d[o + 2]; n++;
      }
      return [r / n, g / n, b / n];
    };
    const qHex = (rgb, bits) => {
      const shift = 8 - bits, mid = shift ? (1 << (shift - 1)) : 0;
      const ch = rgb.map((v) => Math.min(255, ((v | 0) >> shift << shift) + mid));
      return "#" + ch.map((v) => v.toString(16).padStart(2, "0")).join("");
    };
    const octFromRGB16 = (a16) => {
      // wedge-average a 4x4 rgb array -> 8 hex (same clock order as cellOctants)
      const sum = Array.from({ length: 8 }, () => [0, 0, 0, 0]);
      for (let py = 0; py < 4; py++) for (let px = 0; px < 4; px++) {
        const v = a16[py * 4 + px];
        let ang = Math.atan2(px + 0.5 - 2, -(py + 0.5 - 2)) * 180 / Math.PI;
        if (ang < 0) ang += 360;
        const s2 = Math.min(7, Math.floor(ang / 45));
        sum[s2][0] += v[0]; sum[s2][1] += v[1]; sum[s2][2] += v[2]; sum[s2][3]++;
      }
      let tr = 0, tg = 0, tb = 0, tn = 0;
      for (const sm of sum) { tr += sm[0]; tg += sm[1]; tb += sm[2]; tn += sm[3]; }
      const avg = [tr / tn, tg / tn, tb / tn];
      return sum.map((sm) => (sm[3] ? [sm[0] / sm[3], sm[1] / sm[3], sm[2] / sm[3]] : avg));
    };
    const packTier = (tier, bits) => {
      const out = new Array(TOTAL);
      for (let ly = 0; ly < ROWS; ly++) for (let lx = 0; lx < COLS; lx++) {
        const X = lx * 16, Y = ly * 16; // source block per square (16x16 px)
        if (tier === "b256") {
          const cells = new Array(256);
          for (let r = 0; r < 16; r++) for (let c = 0; c < 16; c++) {
            const o = ((Y + r) * SW + (X + c)) * 4;
            cells[r * 16 + c] = qHex([d[o], d[o + 1], d[o + 2]], bits);
          }
          out[ly * COLS + lx] = encode256(cells);
        } else if (tier === "b64") {
          const cells = new Array(64);
          for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++)
            cells[r * 8 + c] = qHex(avgRGB(X + c * 2, Y + r * 2, 2, 2), bits);
          out[ly * COLS + lx] = encode64(cells);
        } else if (tier === "octants") {
          const a16 = new Array(16);
          for (let r = 0; r < 4; r++) for (let c = 0; c < 4; c++)
            a16[r * 4 + c] = avgRGB(X + c * 4, Y + r * 4, 4, 4);
          const oct = octFromRGB16(a16).map((v) => qHex(v, bits));
          out[ly * COLS + lx] = encodeO8(oct);
        } else {
          out[ly * COLS + lx] = encodeQ(
            qHex(avgRGB(X, Y, 8, 8), bits), qHex(avgRGB(X + 8, Y, 8, 8), bits),
            qHex(avgRGB(X + 8, Y + 8, 8, 8), bits), qHex(avgRGB(X, Y + 8, 8, 8), bits)
          );
        }
      }
      return out;
    };
    const estBytes = (packed) => {
      let n = 120;
      for (const v of packed) n += v.length + 64; // value + path/name/JSON overhead
      return n;
    };
    // Grid layouts first (true pixel mosaic), octants LAST: pie wedges triangulate
    // faces into visible low-poly facets, while grids just look like pixels.
    const TIERS = ["b256", "b64", "quadrants", "octants"], BITS = [8, 6, 5, 4];
    let si = Math.max(0, TIERS.indexOf(quality)), chosen = null;
    for (; si < TIERS.length; si++) {
      for (const bits of BITS) {
        const packed = packTier(TIERS[si], bits);
        const est = estBytes(packed);
        if (est <= BUDGET) { chosen = { tier: TIERS[si], bits, packed, est }; break; }
      }
      if (chosen) break;
    }
    const packed = chosen.packed;
    let rich = 0;
    for (const v of packed) if (v.length > 7) rich++;
    drawPreview(packed);
    log(`image "${f.name}": ${(chosen.est / 1024).toFixed(0)}KB <= 1MB [${chosen.tier}, ${chosen.bits}-bit] — painting live as ${name}...`);
    await bulkPaintMap(packed);
    await verifyLive(packed);
    log(`🖼️ image LIVE [${chosen.tier.toUpperCase()} ${(chosen.est / 1024).toFixed(0)}KB] — check gyanl.com/wall`);
  } catch (e) { log("image failed: " + e.message); }
  finally { URL.revokeObjectURL(url); }
});

// Verify what's actually live: read the wall back, re-push any square that doesn't
// match what we sent (partial writes, throttling, classmates painting mid-upload).
// Returns {ok, repaired}. Makes "full pic" a guarantee, not a hope.
async function verifyLive(packed) {
  const { name } = me();
  let snap;
  try {
    snap = await (await fetch(`${firebaseConfig.databaseURL}/wall.json`)).json();
  } catch (e) { log("verify: could not read back (" + e.message + ")"); return { ok: false, repaired: 0 }; }
  const repairs = {};
  for (let i = 0; i < packed.length; i++) {
    const cell = snap ? snap[i] : undefined;
    const live = typeof cell === "string" ? cell : cell?.colour;
    if (live !== packed[i]) repairs[`wall/${i}`] = { colour: packed[i], name };
  }
  const keys = Object.keys(repairs);
  if (!keys.length) { log(`✔ verified live: ${packed.length}/${packed.length} squares match`); return { ok: true, repaired: 0 }; }
  log(`verifying: ${keys.length} squares differ — repairing...`);
  for (let s = 0; s < keys.length; s += 96) {
    const part = {};
    for (const k of keys.slice(s, s + 96)) part[k] = repairs[k];
    await update(ref(db), part);
  }
  for (const k of keys) {
    const i = +k.split("/")[1];
    const el = wallEl.children[i];
    if (el) el.style.background = packed[i];
  }
  log(`✔ repaired ${keys.length} squares — full pic live. Start Guardian to keep it.`);
  return { ok: true, repaired: keys.length };
}

// ---------- VIDEO upload + play LIVE (delta sender + budget guard) ----------
// 🎞️ video mode: 8 colours @~5fps = genuinely smooth, fits the write budget.
// 🖼️ slideshow MAX: 256 colours @1 frame per 5s = max detail, slow Ken-Burns feel.
// Full-rate 256 video is impossible on this database (64MB/min shared) — physics, not code.
let vidTimer = null, vidBusy = false, vidSent = 0, vidDropped = 0, vidURL = null;
function vidSample(vid, W, H) {
  const cv = vidSample._cv || (vidSample._cv = document.createElement("canvas"));
  cv.width = W; cv.height = H;
  const cx = cv.getContext("2d", { willReadFrequently: true });
  cx.drawImage(vid, 0, 0, W, H);
  return cx.getImageData(0, 0, W, H).data;
}
const vidHex = (d, W, x, y) => {
  const o = (y * W + x) * 4;
  return "#" + [d[o], d[o + 1], d[o + 2]].map((v) => v.toString(16).padStart(2, "0")).join("");
};
function vidProgress() {
  const v = document.querySelector("#vid-el");
  const pct = v.duration ? (v.currentTime / v.duration * 100) : 0;
  document.querySelector("#vid-bar").style.width = pct + "%";
  document.querySelector("#vid-time").textContent =
    `${v.currentTime.toFixed(1)}s / ${isFinite(v.duration) ? v.duration.toFixed(0) + "s" : "?"} • sent ${vidSent} • dropped ${vidDropped}`;
}
async function vidFrameVideo() {
  // smooth mode: 64x36 -> quadrant mosaic -> delta send (~40KB worst case per frame).
  // Mosaic blocks read as pixels; octant wedges triangulated faces (see image fix).
  if (vidBusy) return;
  const v = document.querySelector("#vid-el");
  if (v.paused || v.ended || v.readyState < 2) return;
  vidBusy = true;
  try {
    const d = vidSample(v, 64, 36);
    const frame64 = new Array(64 * 36);
    for (let y = 0; y < 36; y++) for (let x = 0; x < 64; x++) frame64[y * 64 + x] = vidHex(d, 64, x, y);
    const packed = pack64(frame64);
    drawPreview(packed);
    const r = await sendDelta(packed);
    r.sent ? vidSent++ : vidDropped++;
    document.querySelector("#vid-hud").textContent = r.dropped ? "throttled — dropping frames" : "smooth mosaic";
    vidProgress();
    if (v.ended) await stopVidLive(true);
  } finally { vidBusy = false; }
}
async function vidFrameSlide() {
  // max mode: 512x288 -> 256 colours, one frame per 5s (delta-sent, budget-guarded)
  if (vidBusy) return;
  const v = document.querySelector("#vid-el");
  if (v.paused || v.ended || v.readyState < 2) return;
  vidBusy = true;
  try {
    const d = vidSample(v, 512, 288);
    const packed = new Array(TOTAL);
    for (let ly = 0; ly < ROWS; ly++) for (let lx = 0; lx < COLS; lx++) {
      const cells = new Array(256);
      for (let r = 0; r < 16; r++) for (let c = 0; c < 16; c++) cells[r * 16 + c] = vidHex(d, 512, lx * 16 + c, ly * 16 + r);
      packed[ly * COLS + lx] = encode256(cells);
    }
    drawPreview(packed);
    const r = await sendDelta(packed);
    r.sent ? vidSent++ : vidDropped++;
    document.querySelector("#vid-hud").textContent = r.dropped ? "over budget — frame held" : "MAX 256-colour";
    vidProgress();
  } finally { vidBusy = false; }
}
async function stopVidLive(done = false) {
  if (vidTimer) { clearInterval(vidTimer); vidTimer = null; }
  const v = document.querySelector("#vid-el");
  try { v.pause(); } catch {}
  document.querySelector("#b-vid-start").disabled = false;
  document.querySelector("#b-vid-stop").disabled = true;
  if (done) log("video finished LIVE — last frame holds as " + me().name);
  else log("video stopped");
}
document.querySelector("#b-vid-start")?.addEventListener("click", async () => {
  const f = document.querySelector("#vid-file").files[0];
  if (!f) { log("choose a video file first"); return; }
  stopAllModesQuiet();
  if (HD) { applyHD(false); log("video forces LD 32x18 (HD would 4x the payload)"); }
  lastSent = null; bwBytes = 0; bwStart = Date.now();
  vidSent = 0; vidDropped = 0;
  const mode = document.querySelector("#vid-mode").value || "video";
  if (vidURL) URL.revokeObjectURL(vidURL);
  vidURL = URL.createObjectURL(f);
  const v = document.querySelector("#vid-el");
  v.src = vidURL; v.loop = false; v.muted = true;
  try { await v.play(); } catch (e) { log("video play failed: " + e.message); return; }
  document.querySelector("#b-vid-start").disabled = true;
  document.querySelector("#b-vid-stop").disabled = false;
  if (mode === "slideshow") {
    log(`🖼️ slideshow MAX LIVE (256 colours, 1 frame/5s) as ${me().name} — watch gyanl.com/wall`);
    await vidFrameSlide();
    vidTimer = setInterval(vidFrameSlide, 5000);
  } else {
    log(`🎞️ video LIVE (mosaic, ~5fps, delta-sent) as ${me().name} — watch gyanl.com/wall`);
    vidTimer = setInterval(vidFrameVideo, 200);
  }
});
document.querySelector("#b-vid-stop")?.addEventListener("click", () => stopVidLive(false));

// --- 5x7 LED font, 2x scaled to fill 18px height like real sign ---
const FONT = {
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"], B: ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
  C: ["01110", "10001", "10000", "10000", "10000", "10001", "01110"], D: ["11100", "10010", "10001", "10001", "10001", "10010", "11100"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"], F: ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
  G: ["01110", "10001", "10000", "10111", "10001", "10001", "01111"], H: ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
  I: ["01110", "00100", "00100", "00100", "00100", "00100", "01110"], J: ["00111", "00010", "00010", "00010", "00010", "10010", "01100"],
  K: ["10001", "10010", "10100", "11000", "10100", "10010", "10001"], L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  M: ["10001", "11011", "10101", "10101", "10001", "10001", "10001"], N: ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"], P: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  Q: ["01110", "10001", "10001", "10001", "10101", "10010", "01101"], R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"], T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  U: ["10001", "10001", "10001", "10001", "10001", "10001", "01110"], V: ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
  W: ["10001", "10001", "10001", "10101", "10101", "11011", "10001"], X: ["10001", "10001", "01010", "00100", "01010", "10001", "10001"],
  Y: ["10001", "10001", "01010", "00100", "00100", "00100", "00100"], Z: ["11111", "00001", "00010", "00100", "01000", "10000", "11111"],
  "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"], "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["01110", "10001", "00001", "00110", "01000", "10000", "11111"], "3": ["11111", "00010", "00100", "00010", "00001", "10001", "01110"],
  "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"], "5": ["11111", "10000", "11110", "00001", "00001", "10001", "01110"],
  "6": ["00110", "01000", "10000", "11110", "10001", "10001", "01110"], "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"], "9": ["01110", "10001", "10001", "01111", "00001", "00010", "01100"],
  " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"], "!": ["00100", "00100", "00100", "00100", "00100", "00000", "00100"],
  "?": ["01110", "10001", "00001", "00010", "00100", "00000", "00100"], ".": ["00000", "00000", "00000", "00000", "00000", "01100", "01100"],
  "-": ["00000", "00000", "00000", "11111", "00000", "00000", "00000"], ":": ["00000", "01100", "01100", "00000", "01100", "01100", "00000"],
  "<": ["00010", "00100", "01000", "10000", "01000", "00100", "00010"], ">": ["01000", "00100", "00010", "00001", "00010", "00100", "01000"],
};

let signTimer = null, signOffset = 0, signStrip = [], signW = 0;
const SCALE = 2, Y0 = 2; // 7*2=14 rows, y=2..15 centred in 18

function buildStrip(text) {
  const t = (text || "").toUpperCase().slice(0, 40) || "HI";
  const rows = Array.from({ length: 7 }, () => []);
  for (const ch of t) {
    const g = FONT[ch] || FONT[" "];
    for (let r = 0; r < 7; r++) for (let c = 0; c < 5; c++) rows[r].push(g[r][c] === "1" ? 1 : 0);
    for (let r = 0; r < 7; r++) rows[r].push(0); // spacing
  }
  // scale 2x
  const sH = 14, sW = rows[0].length * 2;
  const strip = Array.from({ length: sH }, () => Array(sW).fill(0));
  for (let r = 0; r < 7; r++) for (let c = 0; c < rows[0].length; c++) if (rows[r][c]) {
    strip[r * 2][c * 2] = strip[r * 2][c * 2 + 1] = strip[r * 2 + 1][c * 2] = strip[r * 2 + 1][c * 2 + 1] = 1;
  }
  return { strip, sW };
}

async function signFrame() {
  const led = document.querySelector("#sign-colour").value;
  const colours = new Array(TOTAL);
  for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) {
    const sx = signOffset + x;
    let on = false;
    if (sx >= 0 && sx < signW) {
      const sy = y - Y0;
      if (sy >= 0 && sy < 14 && signStrip[sy][sx]) on = true;
    }
    colours[y * COLS + x] = on ? led : "#000000";
  }
  drawPreview(colours);
  await bulkPaintMap(colours);
}

// SUBPIXEL sign: 1x 5x7 font on a 64x36 canvas, packed to quadrant gradients.
// Same letters, 2x sharper on live — zero server changes.
const SY0 = 14; // (36-7)/2, vertically centred
function buildStrip64(text) {
  const t = (text || "").toUpperCase().slice(0, 40) || "HI";
  const rows = Array.from({ length: 7 }, () => []);
  for (const ch of t) {
    const g = FONT[ch] || FONT[" "];
    for (let r = 0; r < 7; r++) for (let c = 0; c < 5; c++) rows[r].push(g[r][c] === "1" ? 1 : 0);
    for (let r = 0; r < 7; r++) rows[r].push(0);
  }
  return { strip: rows, sW: rows[0].length };
}

async function signFrame64() {
  const led = document.querySelector("#sign-colour").value;
  const bg = "#000000";
  const frame64 = new Array(64 * 36).fill(bg);
  for (let x = 0; x < 64; x++) {
    const sx = signOffset + x;
    if (sx < 0 || sx >= signW) continue;
    for (let r = 0; r < 7; r++) if (signStrip[r][sx]) frame64[(SY0 + r) * 64 + x] = led;
  }
  const packed = pack64(frame64);
  drawPreview(packed);
  await bulkPaintMap(packed);
}

function stopSignQuiet() {
  if (signTimer) { clearInterval(signTimer); signTimer = null; document.querySelector("#b-sign-start").disabled = false; document.querySelector("#b-sign-stop").disabled = true; }
}

document.querySelector("#b-sign-start").addEventListener("click", async () => {
  stopAllModesQuiet();
  const hd64 = document.querySelector("#sign-hd")?.checked !== false; // subpixel quadrants
  const text = document.querySelector("#sign-text").value;
  const built = hd64 ? buildStrip64(text) : buildStrip(text);
  signStrip = built.strip; signW = built.sW;
  const speed = parseInt(document.querySelector("#sign-speed").value, 10) || 280;
  const frame = hd64 ? signFrame64 : signFrame;
  const winW = hd64 ? 64 : COLS;
  document.querySelector("#b-sign-start").disabled = true;
  document.querySelector("#b-sign-stop").disabled = false;
  log(`sign LIVE${hd64 ? " [SUBPIXEL 4-color]" : ""}: "${text}" width=${signW}px, ${HD ? PTOTAL : TOTAL} squares/frame as ${me().name}, ${speed}ms — watch gyanl.com/wall`);
  signOffset = -winW;
  await frame();
  signTimer = setInterval(async () => {
    signOffset++;
    if (signOffset > signW + 2) signOffset = -winW;
    try { await frame(); } catch (e) { log("sign frame err: " + e.message); }
  }, speed);
});

document.querySelector("#b-sign-stop").addEventListener("click", () => { stopSignQuiet(); log("sign stopped — wall holds last frame, all still yours"); });

document.querySelector("#b-subpixel-test")?.addEventListener("click", async () => {
  stopAllModesQuiet();
  const { name } = me();
  // centre square (index 8*32+15): TL=red TR=green BR=blue BL=white — checks clock mapping live
  const test = encodeQ("#ff0000", "#00ff00", "#0000ff", "#ffffff");
  log("test string: " + test);
  const idx = 8 * COLS + 15;
  lastWrite = Date.now();
  await update(ref(db), { [`wall/${idx}`]: { colour: test, name } });
  wallEl.children[idx].style.background = test;
  drawPreview(Object.assign(new Array(TOTAL).fill("#000000"), { [idx]: test }));
  log(`🧪 test square #${idx} painted as ${name} — it should show 4 coloured quarters on gyanl.com/wall. TL=red TR=green BR=blue BL=white.`);
});

// ---------- 20s STICKMAN STORY (LIVE, 32x18, 5fps = 100 frames) ----------
let faceTimer = null, faceT = 0;
const FACE_LEN = 20, FACE_DT = 0.2;
const STICK = "#ffffff", GROUND_C = "#1f8a1f", BALL_C = "#ff4343", HEART_C = "#ff2d78", ZZZ_C = "#39c2ff";

function newBuf(bg = "#000000") { return new Array(TOTAL).fill(bg); }
function setPx(b, x, y, c) { x |= 0; y |= 0; if (x < 0 || x >= COLS || y < 0 || y >= ROWS) return; b[y * COLS + x] = c; }
function linePx(b, x0, y0, x1, y1, c) {
  x0 |= 0; y0 |= 0; x1 |= 0; y1 |= 0;
  const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx + dy, x = x0, y = y0;
  for (let i = 0; i < 40; i++) {
    setPx(b, x, y, c);
    if (ART_BOLD) setPx(b, x + 1, y, c); // 2px-thick characters, still 32x18 live-safe
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x += sx; }
    if (e2 <= dx) { err += dx; y += sy; }
  }
}
function circlePx(b, cx, cy, r, c) {
  for (let y = -r; y <= r; y++) for (let x = -r; x <= r; x++) {
    if (x * x + y * y <= r * r + 0.5) setPx(b, cx + x, cy + y, c);
  }
  // punch hole so head is a ring
  setPx(b, cx, cy, "#000000");
}
function drawGround(b) {
  for (let x = 0; x < COLS; x++) { setPx(b, x, 15, GROUND_C); setPx(b, x, 16, "#0d3d0d"); setPx(b, x, 17, "#0d3d0d"); }
}
function drawText1x(b, text, x0, y0, c) {
  const t = (text || "").toUpperCase();
  let cx = x0;
  for (const ch of t) {
    const g = FONT[ch] || FONT[" "];
    for (let r = 0; r < 7; r++) for (let cc = 0; cc < 5; cc++) if (g[r][cc] === "1") setPx(b, cx + cc, y0 + r, c);
    cx += 6;
    if (cx >= COLS) return;
  }
}
function drawBall(b, x, y) { circlePx(b, Math.round(x), Math.round(y), 1, BALL_C); setPx(b, Math.round(x), Math.round(y), BALL_C); }
function drawHeart(b, x0, y0, s, c) {
  const H = ["0110110", "1111111", "1111111", "0111110", "0011100", "0001000"];
  for (let r = 0; r < H.length; r++) for (let cc = 0; cc < 7; cc++) if (H[r][cc] === "1") {
    if (s === 1) setPx(b, x0 + cc, y0 + r, c);
    else { setPx(b, x0 + cc * 2, y0 + r * 2, c); setPx(b, x0 + cc * 2 + 1, y0 + r * 2, c); setPx(b, x0 + cc * 2, y0 + r * 2 + 1, c); setPx(b, x0 + cc * 2 + 1, y0 + r * 2 + 1, c); }
  }
}
// pose: {feetY, walk (float -1..1), arm:'down'|'up'|'wave'|'fwd'|'kick', lying:bool}
function drawStick(b, x, feetY, o = {}) {
  x = Math.round(x); feetY = Math.round(feetY);
  const c = STICK;
  if (o.lying) {
    // lying: head left, body horizontal
    circlePx(b, x - 3, feetY - 1, 2, c);
    linePx(b, x - 1, feetY - 1, x + 4, feetY - 1, c);
    linePx(b, x + 4, feetY - 1, x + 6, feetY - 2, c);
    linePx(b, x + 4, feetY - 1, x + 6, feetY, c);
    return;
  }
  const w = o.walk || 0;
  const hipY = feetY - 3, shY = feetY - 5, headY = feetY - 8;
  circlePx(b, x, headY, 2, c);
  linePx(b, x, headY + 2, x, hipY, c);
  // legs with walk cycle
  const lfx = Math.round(x - 1 - w), rfx = Math.round(x + 1 + w);
  linePx(b, x, hipY, lfx, feetY, c);
  linePx(b, x, hipY, rfx, feetY, c);
  // arms
  if (o.arm === "up") { linePx(b, x, shY, x - 2, shY - 3, c); linePx(b, x, shY, x + 2, shY - 3, c); }
  else if (o.arm === "wave") { linePx(b, x, shY, x - 2, shY + 1, c); linePx(b, x, shY, x + 2, shY - 3 - (o.waveBob || 0), c); }
  else if (o.arm === "fwd") { linePx(b, x, shY, x - 1, shY + 2, c); linePx(b, x, shY, x + 3, shY, c); }
  else if (o.arm === "kick") { linePx(b, x, shY, x - 2, shY + 1, c); linePx(b, x, shY, x + 1, shY - 1, c); linePx(b, x, hipY, x - 1, feetY, c); linePx(b, x, hipY, x + 4, feetY - 2, c); }
  else { const sw = w * 0.7; linePx(b, x, shY, Math.round(x - 1 - sw), shY + 3, c); linePx(b, x, shY, Math.round(x + 1 + sw), shY + 3, c); }
}

// 2x stickman for 64x36 (head r=3, ~17px tall)
function drawStick64(b, x, feetY, o = {}) {
  x = Math.round(x); feetY = Math.round(feetY);
  const c = STICK;
  if (o.lying) {
    disc64(b, x - 6, feetY - 2, 3, c); setPx64(b, x - 6, feetY - 2, "#000000");
    linePx64(b, x - 2, feetY - 2, x + 8, feetY - 2, c);
    linePx64(b, x + 8, feetY - 2, x + 12, feetY - 4, c);
    linePx64(b, x + 8, feetY - 2, x + 12, feetY, c);
    return;
  }
  const w = o.walk || 0;
  const hipY = feetY - 6, shY = feetY - 10, headY = feetY - 15;
  disc64(b, x, headY, 3, c); setPx64(b, x, headY, "#000000");
  linePx64(b, x, headY + 3, x, hipY, c);
  const lfx = Math.round(x - 2 - w * 2), rfx = Math.round(x + 2 + w * 2);
  linePx64(b, x, hipY, lfx, feetY, c);
  linePx64(b, x, hipY, rfx, feetY, c);
  if (o.arm === "up") { linePx64(b, x, shY, x - 4, shY - 6, c); linePx64(b, x, shY, x + 4, shY - 6, c); }
  else if (o.arm === "wave") { linePx64(b, x, shY, x - 4, shY + 2, c); linePx64(b, x, shY, x + 4, shY - 6 - (o.waveBob || 0) * 2, c); }
  else if (o.arm === "fwd") { linePx64(b, x, shY, x - 2, shY + 4, c); linePx64(b, x, shY, x + 6, shY, c); }
  else if (o.arm === "kick") { linePx64(b, x, shY, x - 4, shY + 2, c); linePx64(b, x, shY, x + 2, shY - 2, c); linePx64(b, x, hipY, x - 2, feetY, c); linePx64(b, x, hipY, x + 8, feetY - 4, c); }
  else { const sw = w * 1.4; linePx64(b, x, shY, Math.round(x - 2 - sw), shY + 6, c); linePx64(b, x, shY, Math.round(x + 2 + sw), shY + 6, c); }
}

function faceCaption(t) {
  if (t < 3) return "😊 happy…";
  if (t < 6) return "😉 wink…";
  if (t < 9) return "😮 surprised…";
  if (t < 12) return "😢 sad…";
  if (t < 15) return "😎 cool…";
  if (t < 18) return "😂 laughing…";
  return "😘 kisses + hearts!";
}

// big expressive face on 64x36 (head r=13). Angles in screen coords (y down):
// smile = lower arc 20..160, frown = upper arc 200..340.
function arc64(b, cx, cy, rx, ry, a0, a1, c) {
  for (let a = a0; a <= a1; a += 4) {
    const th = a * Math.PI / 180;
    const x = Math.round(cx + Math.cos(th) * rx), y = Math.round(cy + Math.sin(th) * ry);
    setPx64(b, x, y, c); setPx64(b, x + 1, y, c); // 2px thick
  }
}
function faceBase(b, hx, hy, skin) { disc64(b, hx, hy, 13, skin); }
function eyesDot(b, hx, hy, c = "#111111") {
  setPx64(b, hx - 5, hy - 3, c); setPx64(b, hx - 4, hy - 3, c);
  setPx64(b, hx - 5, hy - 2, c); setPx64(b, hx - 4, hy - 2, c);
  setPx64(b, hx + 4, hy - 3, c); setPx64(b, hx + 5, hy - 3, c);
  setPx64(b, hx + 4, hy - 2, c); setPx64(b, hx + 5, hy - 2, c);
}
function eyesShut(b, hx, hy, c = "#111111") {
  linePx64(b, hx - 6, hy - 2, hx - 3, hy - 2, c);
  linePx64(b, hx + 3, hy - 2, hx + 6, hy - 2, c);
}
function eyesHappy(b, hx, hy, c = "#111111") { // ^^ arcs
  arc64(b, hx - 5, hy, 3, 3, 200, 340, c);
  arc64(b, hx + 5, hy, 3, 3, 200, 340, c);
}
function eyesWide(b, hx, hy) {
  disc64(b, hx - 5, hy - 2, 2, "#ffffff"); setPx64(b, hx - 5, hy - 2, "#111111");
  disc64(b, hx + 5, hy - 2, 2, "#ffffff"); setPx64(b, hx + 5, hy - 2, "#111111");
}
function blush(b, hx, hy) {
  setPx64(b, hx - 9, hy + 3, "#ff9e9e"); setPx64(b, hx - 8, hy + 3, "#ff9e9e");
  setPx64(b, hx + 8, hy + 3, "#ff9e9e"); setPx64(b, hx + 9, hy + 3, "#ff9e9e");
}

function renderFace(t) {
  const SKIN = "#ffdd33";
  const b = newBuf64("#000000");
  for (let i = 0; i < 30; i++) {
    const x = (i * 13 + 5) % 64, y = (i * 7 + 1) % 34;
    if (x < 16 || x > 48 || y > 30) setPx64(b, x, y, "#222233");
  }
  const hx = 32, bob = Math.sin(t * 3) > 0.92 ? 1 : 0, hy = 18 + (t >= 15 && t < 18 ? Math.round(Math.sin(t * 10)) : bob * 0);

  if (t < 3) {
    // happy + blinking
    faceBase(b, hx, hy, SKIN);
    if (Math.sin(t * 3.5) > 0.85) eyesShut(b, hx, hy); else eyesDot(b, hx, hy);
    arc64(b, hx, hy + 4, 7, 4, 20, 160, "#111111"); // smile
    blush(b, hx, hy);
  } else if (t < 6) {
    // wink: left open, right shut + lash, smirk
    faceBase(b, hx, hy, SKIN);
    setPx64(b, hx - 5, hy - 3, "#111111"); setPx64(b, hx - 4, hy - 3, "#111111");
    setPx64(b, hx - 5, hy - 2, "#111111"); setPx64(b, hx - 4, hy - 2, "#111111");
    linePx64(b, hx + 3, hy - 2, hx + 6, hy - 2, "#111111");
    setPx64(b, hx + 7, hy - 3, "#111111"); // lash
    arc64(b, hx + 1, hy + 4, 6, 3, 20, 150, "#111111"); // smirk
    blush(b, hx, hy);
  } else if (t < 9) {
    // surprised: raised brows, wide eyes, O mouth
    faceBase(b, hx, hy, SKIN);
    linePx64(b, hx - 8, hy - 8, hx - 2, hy - 9, "#111111");
    linePx64(b, hx + 2, hy - 9, hx + 8, hy - 8, "#111111");
    eyesWide(b, hx, hy);
    disc64(b, hx, hy + 7, 3, "#111111"); disc64(b, hx, hy + 7, 1, "#7a1f1f"); // O mouth
  } else if (t < 12) {
    // sad: droop brows, frown, falling tear
    faceBase(b, hx, hy, SKIN);
    linePx64(b, hx - 8, hy - 8, hx - 2, hy - 6, "#111111");
    linePx64(b, hx + 2, hy - 6, hx + 8, hy - 8, "#111111");
    eyesDot(b, hx, hy);
    arc64(b, hx, hy + 10, 6, 4, 200, 340, "#111111"); // frown
    const ty = hy - 1 + Math.floor(((t - 9) * 8) % 9);
    setPx64(b, hx - 5, ty, "#4BD5EE"); setPx64(b, hx - 5, ty + 1, "#4BD5EE"); setPx64(b, hx - 4, ty + 1, "#4BD5EE");
  } else if (t < 15) {
    // cool: shades + smirk + shine
    faceBase(b, hx, hy, SKIN);
    for (let y = hy - 5; y <= hy - 1; y++) for (let x = hx - 9; x <= hx + 9; x++) setPx64(b, x, y, "#111111");
    linePx64(b, hx - 2, hy - 3, hx + 2, hy - 3, "#111111"); // bridge
    setPx64(b, hx - 7, hy - 5, "#ffffff"); setPx64(b, hx + 3, hy - 5, "#ffffff"); // shine
    arc64(b, hx + 1, hy + 4, 6, 3, 20, 150, "#111111"); // smirk
  } else if (t < 18) {
    // laughing: ^^ eyes, big open mouth with teeth + tongue, joy tears
    faceBase(b, hx, hy, SKIN);
    eyesHappy(b, hx, hy);
    disc64(b, hx, hy + 6, 5, "#111111");
    for (let x = hx - 4; x <= hx + 4; x++) { setPx64(b, x, hy + 3, "#ffffff"); setPx64(b, x, hy + 4, "#ffffff"); } // teeth
    setPx64(b, hx - 1, hy + 9, "#ff6b81"); setPx64(b, hx, hy + 9, "#ff6b81"); setPx64(b, hx + 1, hy + 9, "#ff6b81"); // tongue
    setPx64(b, hx - 9, hy - 1, "#4BD5EE"); setPx64(b, hx + 9, hy - 1, "#4BD5EE"); // joy tears
  } else {
    // kisses: wink + puckered lips + rising hearts
    faceBase(b, hx, hy, SKIN);
    setPx64(b, hx - 5, hy - 3, "#111111"); setPx64(b, hx - 4, hy - 3, "#111111");
    setPx64(b, hx - 5, hy - 2, "#111111"); setPx64(b, hx - 4, hy - 2, "#111111");
    linePx64(b, hx + 3, hy - 2, hx + 6, hy - 2, "#111111");
    disc64(b, hx + 3, hy + 5, 2, "#d42027"); // puckered lips
    const rise = Math.floor((t - 18) * 6) % 8;
    drawHeart64(b, 48, 20 - rise, "#ff2d78");
    drawHeart64(b, 6, 24 - rise, "#ff2d78");
    if (t > 19) drawText64(b, "XOXO", 20, 1, "#ff9ecb");
  }
  return pack64(b);
}

async function faceTick() {
  faceT += FACE_DT;
  if (faceT >= FACE_LEN) {
    if (document.querySelector("#face-loop").checked) { faceT = 0; log("faces loop…"); }
    else { await stopFaceLive(true); return; }
  }
  const frame = renderFace(faceT);
  drawPreview(frame);
  document.querySelector("#face-bar").style.width = (faceT / FACE_LEN * 100).toFixed(1) + "%";
  document.querySelector("#face-time").textContent = faceT.toFixed(1) + "s / 20s";
  document.querySelector("#face-caption").textContent = faceCaption(faceT);
  try { await bulkPaintMap(frame); } catch (e) { log("faces frame err: " + e.message); }
}

function stopAllModesQuiet() { stopGuardianQuiet(); stopSignQuiet(); if (typeof faceTimer !== "undefined" && faceTimer) { clearInterval(faceTimer); faceTimer = null; } try { if (swTimer) { clearInterval(swTimer); swTimer = null; } } catch {} try { if (fcTimer) { clearInterval(fcTimer); fcTimer = null; } } catch {} try { if (bbTimer) { clearInterval(bbTimer); bbTimer = null; } } catch {} try { if (hateTimer) { clearInterval(hateTimer); hateTimer = null; } } catch {} try { if (shTimer) { clearInterval(shTimer); shTimer = null; } } catch {} try { if (spTimer) { clearInterval(spTimer); spTimer = null; } } catch {} try { if (typeof vidTimer !== "undefined" && vidTimer) { clearInterval(vidTimer); vidTimer = null; } } catch {} for (const [a, b] of [["#b-sw-start", "#b-sw-stop"], ["#b-face-start", "#b-face-stop"], ["#b-fc-start", "#b-fc-stop"], ["#b-bb-start", "#b-bb-stop"], ["#b-hate-start", "#b-hate-stop"], ["#b-sh-start", "#b-sh-stop"], ["#b-sp-start", "#b-sp-stop"], ["#b-vid-start", "#b-vid-stop"]]) { try { document.querySelector(a).disabled = false; document.querySelector(b).disabled = true; } catch {} } }

async function stopFaceLive(finished = false) {
  if (faceTimer) { clearInterval(faceTimer); faceTimer = null; }
  document.querySelector("#b-face-start").disabled = false;
  document.querySelector("#b-face-stop").disabled = true;
  document.querySelector("#face-bar").style.width = finished ? "100%" : (faceT / FACE_LEN * 100) + "%";
  if (finished) { document.querySelector("#face-time").textContent = "20.0s / 20s — done"; log("faces finished LIVE — last frame holds, all 576 still yours"); }
  else log("faces stopped at " + faceT.toFixed(1) + "s");
}

document.querySelector("#b-face-start").addEventListener("click", async () => {
  stopAllModesQuiet();
  faceT = 0;
  document.querySelector("#b-face-start").disabled = true;
  document.querySelector("#b-face-stop").disabled = false;
  document.querySelector("#face-bar").style.width = "0%";
  log("▶ faces LIVE: 20s expressions @5fps (100 frames) as " + me().name + " — watch gyanl.com/wall");
  const f0 = renderFace(0); drawPreview(f0);
  try { await bulkPaintMap(f0); } catch (e) { log(e.message); }
  faceTimer = setInterval(faceTick, 200);
});
document.querySelector("#b-face-stop").addEventListener("click", () => stopFaceLive(false));

// ---------- 20s STAR WARS SCENE (LIVE, 32x18, 5fps) ----------
let swTimer = null, swT = 0;
const SW_LEN = 20, SW_DT = 0.2;
const SW_YELLOW = "#FFE81F", SW_BLUE = "#4BD5EE", SW_RED = "#ff2038", SW_GREEN = "#39ff14", SW_SABER_B = "#2E9DFF", SW_SABER_R = "#ff0033";

function swStars(b, t) {
  // deterministic twinkle
  for (let i = 0; i < 40; i++) {
    const x = (i * 7 + 3) % COLS, y = (i * 11 + 5) % ROWS;
    const tw = Math.sin(t * 3 + i * 1.7) > -0.2;
    if (tw) setPx(b, x, y, i % 7 === 0 ? "#8899bb" : "#ffffff");
  }
}
function drawSprite(b, spr, x0, y0, c, c2 = null) {
  for (let r = 0; r < spr.length; r++) for (let cc = 0; cc < spr[r].length; cc++) {
    const ch = spr[r][cc];
    if (ch === "1") setPx(b, x0 + cc, y0 + r, c);
    else if (ch === "2" && c2) setPx(b, x0 + cc, y0 + r, c2);
  }
}
const XWING = ["1001001", "1111111", "1001001"];
const TIE = ["11011", "11111", "01110", "11111", "11011"];
const DESTROYER = ["111111111111", "011111111110", "001111111100"];

function swCaption(t) {
  if (t < 4) return "⭐ STAR WARS";
  if (t < 10) return "📜 opening crawl…";
  if (t < 15) return "🚀 space battle!";
  if (t < 18.5) return "⚔️ saber duel!";
  return "💥 Death Star down!";
}

const SW_CRAWL = ["EPISODE X", "NEELABH", "WINS THE", "CLASS WALL", "", "THE force", "IS WITH", "YOU..."];

function swStars64(b, t) {
  for (let i = 0; i < 90; i++) {
    const x = (i * 7 + 3) % 64, y = (i * 11 + 5) % 36;
    const tw = Math.sin(t * 3 + i * 1.7) > -0.2;
    if (tw) setPx64(b, x, y, i % 7 === 0 ? "#8899bb" : "#ffffff");
  }
}

function renderSW(t) {
  const b = newBuf64("#000000");
  swStars64(b, t);

  if (t < 4) {
    // logo slam
    if (t >= 0.5) {
      drawText64(b, "STAR", 20, 8, SW_YELLOW);
      drawText64(b, "WARS", 20, 20, SW_YELLOW);
    }
    // fly lines
    if (t > 2.5) for (let i = 0; i < 16; i++) setPx64(b, (i * 4 + Math.floor(t * 8)) % 64, 16, "#333344");
  } else if (t < 10) {
    // blue intro + yellow crawl scrolling up
    const k = t - 4;
    if (k < 1.5) {
      drawText64(b, "A LONG TIME", 5, 10, SW_BLUE);
      drawText64(b, "AGO...", 5, 22, SW_BLUE);
    } else {
      const scroll = (k - 1.5) * 6.4; // px per sec
      for (let li = 0; li < SW_CRAWL.length; li++) {
        const y = Math.round(40 - scroll + li * 5);
        const indent = Math.max(0, Math.floor((16 - y) / 4));
        drawText64(b, SW_CRAWL[li], 4 + indent, y, SW_YELLOW);
      }
    }
  } else if (t < 15) {
    // trench run / dogfight
    const k = t - 10;
    // star destroyer top (2x sprite)
    drawSprite64(b, DESTROYER, 20, 0, "#666677", null, 2);
    // x-wing left->right, tie right->left
    const xx = Math.floor(4 + k * 9), tx = Math.floor(52 - k * 7);
    const xy = 18 + Math.round(Math.sin(k * 4) * 2), ty = 16 + Math.round(Math.cos(k * 3) * 4);
    drawSprite64(b, XWING, xx, xy, "#ffffff", "#ff0000", 2);
    drawSprite64(b, TIE, tx, ty, "#ffffff", null, 2);
    // lasers
    if (k > 0.8) {
      const lx = (xx + 14 + Math.floor((k - 0.8) * 36)) % 64;
      linePx64(b, xx + 14, xy + 2, Math.min(lx, 63), xy + 2, SW_RED);
      const lx2 = tx - Math.floor((k - 0.8) * 32);
      if (lx2 >= 0) linePx64(b, tx, ty + 4, Math.max(lx2, 0), ty + 4, SW_GREEN);
    }
    // hit flash at end
    if (k > 4.2) {
      disc64(b, tx + 4, ty + 4, 4 + Math.floor((k - 4.2) * 8), "#ffaa00");
      setPx64(b, tx + 4, ty + 4, "#ffffff");
    }
  } else if (t < 18.5) {
    // saber duel: two big sticks + sabers
    const k = t - 15;
    const lunge = Math.sin(k * 6) * 3;
    const lx = Math.round(22 + lunge), rx = Math.round(40 - lunge);
    disc64(b, lx, 10, 3, "#ffffff"); setPx64(b, lx, 10, "#000000");
    linePx64(b, lx, 13, lx, 22, "#ffffff");
    linePx64(b, lx, 22, lx - 2, 28, "#ffffff"); linePx64(b, lx, 22, lx + 2, 28, "#ffffff");
    disc64(b, rx, 10, 3, "#ffffff"); setPx64(b, rx, 10, "#000000");
    linePx64(b, rx, 13, rx, 22, "#ffffff");
    linePx64(b, rx, 22, rx - 2, 28, "#ffffff"); linePx64(b, rx, 22, rx + 2, 28, "#ffffff");
    // sabers cross middle
    const mx = 30 + Math.round(Math.sin(k * 6) * 2);
    linePx64(b, lx + 2, 18, mx + 2, 8, SW_SABER_B);
    linePx64(b, rx - 2, 18, mx - 2, 8, SW_SABER_R);
    // clash sparks
    if (Math.abs(lunge) > 1.6) {
      setPx64(b, mx, 12, "#ffffff"); setPx64(b, mx + 2, 14, "#ffff00"); setPx64(b, mx - 2, 10, "#ffff00");
      setPx64(b, mx + 1, 11, "#ffffff");
    }
    // ground glow
    for (let x = 0; x < 64; x++) setPx64(b, x, 30, "#111133");
  } else {
    // Death Star explosion
    const k = t - 18.5;
    const cx = 32, cy = 18;
    // death star
    disc64(b, cx, cy, 8, "#888899");
    setPx64(b, cx - 2, cy - 2, "#333344");
    // shockwave
    const r = Math.floor(k * 20);
    for (let a = 0; a < 48; a++) {
      const th = a / 48 * Math.PI * 2;
      setPx64(b, Math.round(cx + Math.cos(th) * r), Math.round(cy + Math.sin(th) * r * 0.55), k < 0.7 ? "#ffffff" : "#ffaa00");
    }
    if (k > 0.4) drawText64(b, "BOOM!", 8, 2, SW_YELLOW);
  }
  return pack64(b);
}

async function swTick() {
  swT += SW_DT;
  if (swT >= SW_LEN) {
    if (document.querySelector("#sw-loop").checked) { swT = 0; log("star wars loop…"); }
    else { await stopSWLive(true); return; }
  }
  const frame = renderSW(swT);
  drawPreview(frame);
  document.querySelector("#sw-bar").style.width = (swT / SW_LEN * 100).toFixed(1) + "%";
  document.querySelector("#sw-time").textContent = swT.toFixed(1) + "s / 20s";
  document.querySelector("#sw-caption").textContent = swCaption(swT);
  try { await bulkPaintMap(frame); } catch (e) { log("SW frame err: " + e.message); }
}

async function stopSWLive(finished = false) {
  if (swTimer) { clearInterval(swTimer); swTimer = null; }
  document.querySelector("#b-sw-start").disabled = false;
  document.querySelector("#b-sw-stop").disabled = true;
  if (finished) { document.querySelector("#sw-time").textContent = "20.0s / 20s — done"; log("Star Wars finished LIVE — all 576 still yours"); }
  else log("Star Wars stopped at " + swT.toFixed(1) + "s");
}

document.querySelector("#b-sw-start").addEventListener("click", async () => {
  stopAllModesQuiet();
  swT = 0;
  document.querySelector("#b-sw-start").disabled = true;
  document.querySelector("#b-sw-stop").disabled = false;
  log("▶ Star Wars LIVE: 20s @5fps as " + me().name + " — watch gyanl.com/wall");
  const f0 = renderSW(0); drawPreview(f0);
  try { await bulkPaintMap(f0); } catch (e) { log(e.message); }
  swTimer = setInterval(swTick, 200);
});
document.querySelector("#b-sw-stop").addEventListener("click", () => stopSWLive(false));

// ---------- FIGHT CLUB 20s (basement boxing, classroom-safe) ----------
let fcTimer = null, fcT = 0;
const FC_LEN = 20, FC_DT = 0.2;
function fcCaption(t) {
  if (t < 4) return "🫧 rule #1…";
  if (t < 9) return "🥊 face off…";
  if (t < 14) return "💥 POW! BAM!";
  if (t < 18) return "🤝 respect";
  return "🧼 SOAP — end";
}
function drawBoxer64(b, x, feetY, dir, punch, color) {
  // dir 1=right, -1=left; punch 0..1 extended
  x |= 0; feetY |= 0;
  disc64(b, x, feetY - 15, 3, "#ffffff"); setPx64(b, x, feetY - 15, "#000000");
  linePx64(b, x, feetY - 12, x, feetY - 6, "#ffffff");
  linePx64(b, x, feetY - 6, x - 2, feetY, "#ffffff");
  linePx64(b, x, feetY - 6, x + 2, feetY, "#ffffff");
  // back arm
  linePx64(b, x, feetY - 10, x - dir * 2, feetY - 8, "#ffffff");
  // punch arm with glove
  const gx = Math.round(x + dir * (2 + punch * 8)), gy = Math.round(feetY - 10 + (punch > 0.5 ? -2 : 0));
  linePx64(b, x, feetY - 10, gx, gy, "#ffffff");
  disc64(b, gx, gy, 2, color);
}
function renderFC(t) {
  const b = newBuf64("#0a0a0a");
  // basement: brick dots + hanging bulb
  for (let x = 0; x < 64; x += 4) setPx64(b, x, 4, "#1c1c1c");
  setPx64(b, 32, 0, "#ffff88"); linePx64(b, 32, 2, 32, 6, "#555522");
  disc64(b, 32, 8, 2, "#ffef9e"); setPx64(b, 32, 8, "#ffef9e");
  for (let x = 0; x < 64; x++) { setPx64(b, x, 30, "#3a2a1a"); setPx64(b, x, 31, "#2a1e12"); }
  if (t < 4) {
    drawText64(b, "FIGHT", 17, 12, "#ff5555");
    const blink = Math.sin(t * 6) > 0;
    if (blink) drawText64(b, "CLUB", 20, 20, "#ffffff");
    if (t > 2) drawText64(b, "1ST RULE?", 8, 28 - 14, "#888888");
  } else if (t < 9) {
    const k = (t - 4) / 5, bob = Math.sin(t * 8) * 1.2;
    drawBoxer64(b, Math.round(22 + bob), 28, 1, 0, "#ff2038");
    drawBoxer64(b, Math.round(40 - bob), 28, -1, 0, "#2E9DFF");
    if (t > 7.5) drawText64(b, "GO!", 28, 10, "#ffff00");
  } else if (t < 14) {
    const k = t - 9, hit = Math.sin(k * 8) > 0.3;
    const p1 = hit ? 1 : 0.2, p2 = hit ? 0.2 : 1;
    drawBoxer64(b, 22, 28, 1, p1, "#ff2038");
    drawBoxer64(b, 40, 28, -1, p2, "#2E9DFF");
    if (hit) {
      drawText64(b, k < 2.5 ? "POW!" : "BAM!", 24, 8, "#ffff00");
      setPx64(b, 30 + (Math.random() * 4 | 0), 14, "#ffffff");
      setPx64(b, 32, 16, "#ffaa00"); setPx64(b, 33, 16, "#ffaa00");
    }
    // sweat
    if (Math.sin(k * 12) > 0.6) { setPx64(b, 18, 6, "#4BD5EE"); setPx64(b, 44, 8, "#4BD5EE"); }
  } else if (t < 18) {
    drawBoxer64(b, 24, 28, 1, 0.1, "#ff2038");
    drawBoxer64(b, 38, 28, -1, 0.1, "#2E9DFF");
    linePx64(b, 26, 18, 36, 18, "#ffffff"); // handshake
    drawHeart64(b, 27, 4, "#ff5555");
  } else {
    // pink soap finale
    for (let y = 12; y <= 20; y++) for (let x = 20; x <= 42; x++) setPx64(b, x, y, "#ffb6d5");
    for (let x = 20; x <= 42; x++) { setPx64(b, x, 12, "#ffffff"); setPx64(b, x, 20, "#d46a9e"); }
    drawText64(b, "SOAP", 20, 24, "#ffffff");
  }
  return pack64(b);
}
async function fcTick() {
  fcT += FC_DT;
  if (fcT >= FC_LEN) {
    if (document.querySelector("#fc-loop").checked) { fcT = 0; }
    else { await stopFCLive(true); return; }
  }
  const f = renderFC(fcT);
  drawPreview(f);
  document.querySelector("#fc-bar").style.width = (fcT / FC_LEN * 100) + "%";
  document.querySelector("#fc-time").textContent = fcT.toFixed(1) + "s / 20s";
  document.querySelector("#fc-caption").textContent = fcCaption(fcT);
  try { await bulkPaintMap(f); } catch (e) { log("FC err: " + e.message); }
}
async function stopFCLive(done = false) {
  if (fcTimer) { clearInterval(fcTimer); fcTimer = null; }
  document.querySelector("#b-fc-start").disabled = false;
  document.querySelector("#b-fc-stop").disabled = true;
  if (done) log("Fight Club finished LIVE");
}
document.querySelector("#b-fc-start").addEventListener("click", async () => {
  stopAllModesQuiet(); fcT = 0;
  document.querySelector("#b-fc-start").disabled = true;
  document.querySelector("#b-fc-stop").disabled = false;
  log("▶ Fight Club LIVE 20s as " + me().name);
  const f0 = renderFC(0); drawPreview(f0);
  try { await bulkPaintMap(f0); } catch (e) { log(e.message); }
  fcTimer = setInterval(fcTick, 200);
});
document.querySelector("#b-fc-stop").addEventListener("click", () => stopFCLive(false));

// ---------- BARBIE 20s (pink dream, convertible + party) ----------
let bbTimer = null, bbT = 0;
const BB_LEN = 20, BB_DT = 0.2, BB_PINK = "#ff69b4";
function bbCaption(t) {
  if (t < 4) return "✨ Hi Barbie!";
  if (t < 10) return "🚗 Malibu drive!";
  if (t < 15) return "🏠 Dreamhouse!";
  return "🪩 dance party!";
}
function drawCar64(b, x0, y0) {
  // 20x8 pink convertible
  for (let x = 0; x < 20; x++) for (let y = 0; y < 4; y++) setPx64(b, x0 + x, y0 + y, BB_PINK);
  setPx64(b, x0 + 4, y0 - 2, BB_PINK); setPx64(b, x0 + 5, y0 - 2, BB_PINK);
  setPx64(b, x0 + 12, y0 - 2, BB_PINK); setPx64(b, x0 + 13, y0 - 2, BB_PINK);
  disc64(b, x0 + 4, y0 + 4, 2, "#111111"); disc64(b, x0 + 15, y0 + 4, 2, "#111111");
  setPx64(b, x0 + 4, y0 + 4, "#ffffff"); setPx64(b, x0 + 15, y0 + 4, "#ffffff");
  // driver head
  disc64(b, x0 + 10, y0 - 4, 2, "#ffd9b3"); setPx64(b, x0 + 10, y0 - 4, "#ffd9b3");
}
function drawPalm64(b, x, yBase) {
  linePx64(b, x, yBase, x, yBase - 10, "#7a4a21");
  linePx64(b, x, yBase - 10, x - 4, yBase - 12, "#1f8a1f");
  linePx64(b, x, yBase - 10, x + 4, yBase - 12, "#1f8a1f");
  linePx64(b, x, yBase - 10, x, yBase - 14, "#1f8a1f");
}
function renderBB(t) {
  const surf = Math.sin(t * 2) > 0;
  const b = newBuf64(t < 4 || t >= 15 ? "#2a0a1e" : (surf ? "#87CEEB" : "#7ec8f0"));
  // sparkles
  for (let i = 0; i < 40; i++) {
    const x = (i * 5 + Math.floor(t * 3)) % 64, y = (i * 3 + 1) % 14;
    if (Math.sin(t * 4 + i) > 0) setPx64(b, x, y, "#ffffff");
  }
  if (t < 4) {
    drawText64(b, "BARBIE", 14, 12, BB_PINK);
    drawHeart64(b, 48, 4, "#ff1744");
    drawHeart64(b, 2, 2, "#ffffff");
  } else if (t < 10) {
    // road
    for (let x = 0; x < 64; x++) setPx64(b, x, 28, "#333333");
    for (let x = 0; x < 64; x += 6) setPx64(b, (x + Math.floor(t * 20)) % 64, 28, "#ffff00");
    drawPalm64(b, 8, 27); drawPalm64(b, 56, 27);
    const cx = Math.floor(4 + (t - 4) / 6 * 40);
    drawCar64(b, cx, 20);
  } else if (t < 15) {
    // dreamhouse: pink rect + door + balcony figures
    for (let y = 12; y <= 28; y++) for (let x = 16; x <= 48; x++) setPx64(b, x, y, "#ffc0e0");
    for (let x = 16; x <= 48; x++) setPx64(b, x, 12, BB_PINK);
    setPx64(b, 30, 28, "#a02060"); setPx64(b, 32, 28, "#a02060"); setPx64(b, 30, 26, "#a02060"); setPx64(b, 32, 26, "#a02060");
    const w = Math.sin(t * 8) > 0 ? 1 : 0;
    drawStick64(b, 24, 24, { arm: "wave", waveBob: w });
    drawStick64(b, 40, 24, { arm: "wave", waveBob: 1 - w });
    drawText64(b, "HI BARBIE!", 4, 2, "#ffffff");
  } else {
    // disco: flashing floor + dancers
    for (let x = 0; x < 64; x++) setPx64(b, x, 30, (x + Math.floor(t * 6)) % 2 ? "#ff00d4" : "#00e5ff");
    for (let x = 0; x < 64; x++) setPx64(b, x, 31, (x + Math.floor(t * 6)) % 2 ? "#7c00ff" : "#ffea00");
    const d = Math.sin(t * 10) > 0 ? 1 : -1;
    drawStick64(b, 22, 28, { walk: d, arm: "up" });
    drawStick64(b, 40, 28, { walk: -d, arm: "up" });
    drawHeart64(b, 28, 4, "#ffffff");
  }
  return pack64(b);
}
async function bbTick() {
  bbT += BB_DT;
  if (bbT >= BB_LEN) {
    if (document.querySelector("#bb-loop").checked) { bbT = 0; }
    else { await stopBBLive(true); return; }
  }
  const f = renderBB(bbT);
  drawPreview(f);
  document.querySelector("#bb-bar").style.width = (bbT / BB_LEN * 100) + "%";
  document.querySelector("#bb-time").textContent = bbT.toFixed(1) + "s / 20s";
  document.querySelector("#bb-caption").textContent = bbCaption(bbT);
  try { await bulkPaintMap(f); } catch (e) { log("BB err: " + e.message); }
}
async function stopBBLive(done = false) {
  if (bbTimer) { clearInterval(bbTimer); bbTimer = null; }
  document.querySelector("#b-bb-start").disabled = false;
  document.querySelector("#b-bb-stop").disabled = true;
  if (done) log("Barbie finished LIVE");
}
document.querySelector("#b-bb-start").addEventListener("click", async () => {
  stopAllModesQuiet(); bbT = 0;
  document.querySelector("#b-bb-start").disabled = true;
  document.querySelector("#b-bb-stop").disabled = false;
  log("▶ Barbie LIVE 20s as " + me().name);
  const f0 = renderBB(0); drawPreview(f0);
  try { await bulkPaintMap(f0); } catch (e) { log(e.message); }
  bbTimer = setInterval(bbTick, 200);
});
document.querySelector("#b-bb-stop").addEventListener("click", () => stopBBLive(false));

// ---------- 10 THINGS I HATE ABOUT YOU 20s (school + boombox serenade) ----------
let hateTimer = null, hateT = 0;
const HATE_LEN = 20, HATE_DT = 0.2;
const POEM = ["I HATE IT", "WHEN YOU", "LIE... BUT", "I LOVE", "YOU."];
function hateCaption(t) {
  if (t < 4) return "🏫 school bell…";
  if (t < 11) return "📻 boombox serenade…";
  if (t < 16) return "💌 the poem…";
  return "❤️ 10 things…";
}
function drawSchool64(b) {
  for (let y = 14; y <= 28; y++) for (let x = 12; x <= 52; x++) setPx64(b, x, y, "#c9a86a");
  for (let x = 12; x <= 52; x++) setPx64(b, x, 14, "#8a2be2");
  setPx64(b, 30, 10, "#8a2be2"); linePx64(b, 30, 12, 30, 14, "#8a2be2");
  for (let x = 18; x <= 46; x += 8) for (let y = 18; y <= 24; y++) setPx64(b, x, y, "#4BD5EE");
  setPx64(b, 30, 28, "#5a3a1a"); setPx64(b, 32, 28, "#5a3a1a");
}
function drawBoombox64(b, x0, y0) {
  for (let y = 0; y < 6; y++) for (let x = 0; x < 12; x++) setPx64(b, x0 + x, y0 + y, "#222222");
  disc64(b, x0 + 2, y0 + 3, 2, "#888888"); disc64(b, x0 + 9, y0 + 3, 2, "#888888");
  setPx64(b, x0 + 4, y0, "#ff2038"); setPx64(b, x0 + 5, y0, "#ff2038"); setPx64(b, x0 + 6, y0, "#ff2038");
}
function renderHate(t) {
  const b = newBuf64("#0b1e3a");
  for (let i = 0; i < 50; i++) { const x = (i * 9 + 2) % 64, y = (i * 5) % 10; if (Math.sin(t * 2 + i) > -0.3) setPx64(b, x, y, "#ffffff"); }
  if (t < 4) {
    drawSchool64(b);
    drawText64(b, "SCHOOL", 14, 2, "#ffff00");
    if (Math.sin(t * 8) > 0) { disc64(b, 56, 6, 2, "#ffff00"); setPx64(b, 56, 6, "#ffff00"); }
    drawStick64(b, 16 + Math.sin(t * 3) * 2, 32, { walk: Math.sin(t * 8) });
  } else if (t < 11) {
    // stadium: green field, boy holds boombox overhead, girl watches, notes float
    for (let x = 0; x < 64; x++) for (let y = 26; y < 36; y++) setPx64(b, x, y, "#1f8a1f");
    for (let x = 0; x < 64; x += 8) setPx64(b, x, 26, "#ffffff");
    const bob = Math.sin(t * 6);
    drawStick64(b, 20, 24, { arm: "up" });
    drawBoombox64(b, 15, 2 + Math.round(bob));
    drawStick64(b, 44, 24, { arm: "down", walk: 0 });
    // girl hair
    setPx64(b, 42, 6, "#ff9e57"); setPx64(b, 46, 6, "#ff9e57");
    // music notes
    const n = Math.floor(t * 3) % 4;
    if (n >= 0) setPx64(b, 26, 8 - (Math.floor(t * 2) % 6), "#ffff00");
    if (n >= 1) setPx64(b, 32, 6, "#ffff00");
    if (n >= 2) setPx64(b, 38, 10, "#ffff00");
  } else if (t < 16) {
    const li = Math.min(POEM.length - 1, Math.floor((t - 11) / 1));
    for (let i = 0; i <= li; i++) drawText64(b, POEM[i], 4, 2 + i * 5, i === li ? "#ffff00" : "#ff9ecb");
  } else {
    drawHeart64(b, 24, 8, "#ff2d78");
    drawStick64(b, 16, 30, { arm: "wave", waveBob: 0 });
    drawStick64(b, 24, 30, { arm: "wave", waveBob: 1 });
    drawText64(b, "10", 52, 2, "#ffff00");
    drawText64(b, "END", 50, 18, "#4BD5EE");
  }
  return pack64(b);
}
async function hateTick() {
  hateT += HATE_DT;
  if (hateT >= HATE_LEN) {
    if (document.querySelector("#hate-loop").checked) { hateT = 0; }
    else { await stopHateLive(true); return; }
  }
  const f = renderHate(hateT);
  drawPreview(f);
  document.querySelector("#hate-bar").style.width = (hateT / HATE_LEN * 100) + "%";
  document.querySelector("#hate-time").textContent = hateT.toFixed(1) + "s / 20s";
  document.querySelector("#hate-caption").textContent = hateCaption(hateT);
  try { await bulkPaintMap(f); } catch (e) { log("Hate err: " + e.message); }
}
async function stopHateLive(done = false) {
  if (hateTimer) { clearInterval(hateTimer); hateTimer = null; }
  document.querySelector("#b-hate-start").disabled = false;
  document.querySelector("#b-hate-stop").disabled = true;
  if (done) log("10 Things finished LIVE");
}
document.querySelector("#b-hate-start").addEventListener("click", async () => {
  stopAllModesQuiet(); hateT = 0;
  document.querySelector("#b-hate-start").disabled = true;
  document.querySelector("#b-hate-stop").disabled = false;
  log("▶ 10 Things LIVE 20s as " + me().name);
  const f0 = renderHate(0); drawPreview(f0);
  try { await bulkPaintMap(f0); } catch (e) { log(e.message); }
  hateTimer = setInterval(hateTick, 200);
});
document.querySelector("#b-hate-stop").addEventListener("click", () => stopHateLive(false));

// ================= SPACE SHOOTER (playable, 32x18, LIVE) =================
let shTimer = null, shBusy = false;
const SH = { px: 16, bullets: [], ebullets: [], enemies: [], parts: [], score: 0, lives: 3, tick: 0, cool: 0, over: false, inv: 0 };
const keysDown = new Set();
let jumpQueued = false; // shared with spidey
window.addEventListener("keydown", (e) => {
  if (["ArrowLeft", "ArrowRight", "ArrowUp", "Space"].includes(e.code)) e.preventDefault();
  if (e.repeat) { keysDown.add(e.code); return; }
  keysDown.add(e.code);
  if (e.code === "Space" || e.code === "ArrowUp" || e.code === "KeyW") jumpQueued = true; // spidey jump
});
window.addEventListener("keyup", (e) => keysDown.delete(e.code));

function shBindHold(el, codes) {
  const on = (e) => { e.preventDefault(); codes.forEach((c) => keysDown.add(c)); };
  const off = (e) => { e.preventDefault(); codes.forEach((c) => keysDown.delete(c)); };
  el.addEventListener("pointerdown", on);
  el.addEventListener("pointerup", off);
  el.addEventListener("pointerleave", off);
  el.addEventListener("pointercancel", off);
}
shBindHold(document.querySelector("#sh-left"), ["ArrowLeft", "KeyA"]);
shBindHold(document.querySelector("#sh-right"), ["ArrowRight", "KeyD"]);

function shReset() {
  SH.px = 32; SH.bullets = []; SH.ebullets = []; SH.enemies = []; SH.parts = [];
  SH.score = 0; SH.lives = 3; SH.tick = 0; SH.cool = 0; SH.over = false; SH.inv = 0;
}
const SHIP = ["00100", "01110", "11111"];
const INV_A = ["10101", "01110", "01010"];
const INV_B = ["01110", "11111", "10101"];

function shSpawn() {
  const gap = Math.max(6, 12 - Math.floor(SH.score / 600));
  if (SH.tick % gap !== 0 || SH.enemies.length >= 5) return;
  const tough = Math.random() < Math.min(0.45, 0.15 + SH.score / 4000);
  SH.enemies.push({ x: 4 + Math.random() * 56, y: 2, dx: (Math.random() - 0.5) * 1.6, hp: tough ? 2 : 1, tough, ph: Math.random() * 6 });
}

function renderSH() {
  const b = newBuf64("#000000");
  for (let i = 0; i < 60; i++) {
    const x = (i * 7 + 3) % 64, y = (i * 11 + Math.floor(SH.tick / 2)) % 28;
    setPx64(b, x, y, "#333355");
  }
  // enemies (2x sprites)
  for (const e of SH.enemies) {
    const c = e.hp > 1 ? "#b44dff" : "#ff2038";
    drawSprite64(b, e.tough ? INV_B : INV_A, Math.round(e.x) - 5, Math.round(e.y), c, null, 2);
  }
  // bullets
  for (const bl of SH.bullets) { setPx64(b, Math.round(bl.x), Math.round(bl.y), "#ffff00"); setPx64(b, Math.round(bl.x), Math.round(bl.y) + 2, "#ffaa00"); }
  for (const bl of SH.ebullets) setPx64(b, Math.round(bl.x), Math.round(bl.y), "#ff5555");
  // explosions
  for (const p of SH.parts) {
    const r = 3 - p.ttl;
    setPx64(b, p.x, p.y, "#ffffff");
    if (r >= 1) { setPx64(b, p.x - 2, p.y, "#ffaa00"); setPx64(b, p.x + 2, p.y, "#ffaa00"); setPx64(b, p.x, p.y - 2, "#ffaa00"); setPx64(b, p.x, p.y + 2, "#ffaa00"); }
  }
  // player (blink while invincible)
  if (!(SH.inv > 0 && SH.tick % 2 === 0)) {
    drawSprite64(b, SHIP, Math.round(SH.px) - 5, 28, "#00e5ff", null, 2);
    setPx64(b, Math.round(SH.px), 31, "#ffffff"); setPx64(b, Math.round(SH.px), 32, "#ffffff");
  }
  // lives pips top-left
  for (let i = 0; i < SH.lives; i++) { setPx64(b, i * 4, 0, "#ff2038"); setPx64(b, i * 4 + 1, 0, "#ff2038"); }
  if (SH.over) {
    for (let y = 10; y <= 24; y++) for (let x = 8; x <= 54; x++) setPx64(b, x, y, "#000000");
    drawText64(b, "GAME", 22, 10, "#ff2038");
    drawText64(b, "OVER", 22, 20, "#ffffff");
  }
  return pack64(b);
}
function shUpdateHUD() {
  document.querySelector("#sh-hud").textContent = `score ${SH.score} • lives ${SH.lives}${SH.over ? " • GAME OVER" : ""}`;
}
async function shTick() {
  if (SH.over || shBusy) return;
  shBusy = true;
  try {
    SH.tick++;
    if (SH.inv > 0) SH.inv--;
    if (SH.cool > 0) SH.cool--;
    // move (64-space)
    if (keysDown.has("ArrowLeft") || keysDown.has("KeyA")) SH.px = Math.max(5, SH.px - 2);
    if (keysDown.has("ArrowRight") || keysDown.has("KeyD")) SH.px = Math.min(58, SH.px + 2);
    const wantFire = keysDown.has("Space") || keysDown.has("ArrowUp") || keysDown.has("KeyW");
    if (wantFire && SH.cool <= 0) { SH.bullets.push({ x: Math.round(SH.px), y: 26 }); SH.cool = 2; }
    shSpawn();
    // bullets
    for (const bl of SH.bullets) bl.y -= 4;
    SH.bullets = SH.bullets.filter((bl) => bl.y >= 0);
    for (const bl of SH.ebullets) bl.y += 2;
    SH.ebullets = SH.ebullets.filter((bl) => bl.y < 36);
    // enemy fire
    if (SH.tick % 16 === 0 && SH.enemies.length) {
      const s = SH.enemies[Math.floor(Math.random() * SH.enemies.length)];
      SH.ebullets.push({ x: Math.round(s.x), y: Math.round(s.y) + 4 });
    }
    // enemies drift down
    const speed = SH.score > 2000 ? 2 : 1;
    for (const e of SH.enemies) { e.ph += 0.3; e.y += (SH.tick % 2 === 0 ? speed : 0); e.x += Math.sin(e.ph) * 0.6; e.x = Math.max(5, Math.min(58, e.x)); }
    // bullet vs enemy
    for (const bl of SH.bullets) {
      for (const e of SH.enemies) {
        if (Math.abs(bl.x - e.x) <= 5 && Math.abs(bl.y - e.y) <= 3 && e.hp > 0 && bl.y >= 0) {
          e.hp--; bl.y = -99;
          SH.parts.push({ x: Math.round(e.x), y: Math.round(e.y), ttl: 2 });
          if (e.hp <= 0) SH.score += e.tough ? 250 : 100;
          break;
        }
      }
    }
    SH.bullets = SH.bullets.filter((bl) => bl.y >= 0);
    SH.enemies = SH.enemies.filter((e) => e.hp > 0);
    // enemy hits player / lands
    for (const e of SH.enemies) {
      if ((e.y >= 26 && Math.abs(e.x - SH.px) <= 5) || e.y >= 30) {
        if (SH.inv <= 0) {
          SH.lives--; SH.inv = 8;
          SH.parts.push({ x: Math.round(SH.px), y: 28, ttl: 3 });
          log(`💥 hit! lives=${SH.lives}`);
        }
        e.hp = 0;
      }
    }
    SH.enemies = SH.enemies.filter((e) => e.hp > 0);
    // enemy bullets hit player
    for (const bl of SH.ebullets) {
      if (Math.abs(bl.x - SH.px) <= 2 && bl.y >= 26 && SH.inv <= 0) {
        SH.lives--; SH.inv = 8; bl.y = 99;
        SH.parts.push({ x: Math.round(SH.px), y: 28, ttl: 3 });
        log(`💥 zapped! lives=${SH.lives}`);
      }
    }
    SH.ebullets = SH.ebullets.filter((bl) => bl.y < 36);
    for (const p of SH.parts) p.ttl--;
    SH.parts = SH.parts.filter((p) => p.ttl > 0);
    if (SH.lives <= 0) {
      SH.over = true;
      log(`☠️ GAME OVER score=${SH.score}`);
    }
    const frame = renderSH();
    drawPreview(frame);
    shUpdateHUD();
    await bulkPaintMap(frame);
    if (SH.over) await stopSHLive(true);
  } finally { shBusy = false; }
}
async function stopSHLive(done = false) {
  if (shTimer) { clearInterval(shTimer); shTimer = null; }
  document.querySelector("#b-sh-start").disabled = false;
  document.querySelector("#b-sh-stop").disabled = true;
  keysDown.clear();
  if (done) log(`Space shooter ended — score ${SH.score} still holds wall as ${me().name}`);
}
document.querySelector("#b-sh-start").addEventListener("click", async () => {
  stopAllModesQuiet(); shReset();
  document.querySelector("#b-sh-start").disabled = true;
  document.querySelector("#b-sh-stop").disabled = false;
  log("▶ Space shooter LIVE — ←/→ move, Space fire. Watch gyanl.com/wall");
  shUpdateHUD();
  const f0 = renderSH(); drawPreview(f0);
  try { await bulkPaintMap(f0); } catch (e) { log(e.message); }
  shTimer = setInterval(shTick, 150);
});
document.querySelector("#b-sh-stop").addEventListener("click", () => stopSHLive(false));
document.querySelector("#sh-fire").addEventListener("pointerdown", (e) => { e.preventDefault(); keysDown.add("Space"); setTimeout(() => keysDown.delete("Space"), 120); });

// ================= SPIDERMAN WEB SWING (playable runner, 32x18, LIVE) =================
let spTimer = null, spBusy = false;
const SP = { py: 13, vy: 0, scroll: 0, drones: [], score: 0, lives: 3, tick: 0, over: false, inv: 0, ground: 14, boosts: 0 };
function spReset() {
  SP.py = 26; SP.vy = 0; SP.scroll = 0; SP.drones = []; SP.score = 0; SP.lives = 3;
  SP.tick = 0; SP.over = false; SP.inv = 0; SP.ground = 28; SP.boosts = 0;
}
function spGroundAt(wx) {
  // pits every ~48px, width 10
  const period = 48, gx = ((wx % period) + period) % period;
  if (gx >= 30 && gx < 40) return -1;
  return 28;
}
function spSpawnDrone() {
  if (SP.tick % 22 !== 0 || SP.drones.length >= 3) return;
  SP.drones.push({ x: 66, y: 12 + Math.random() * 9, sp: 1 + SP.scroll / 600 });
}
function drawSpidey64(b, x, y) {
  x = Math.round(x); y = Math.round(y);
  setPx64(b, x - 1, y - 4, "#d42027"); setPx64(b, x, y - 4, "#d42027"); setPx64(b, x + 1, y - 4, "#d42027");
  setPx64(b, x - 1, y - 3, "#d42027"); setPx64(b, x, y - 3, "#ffffff"); setPx64(b, x + 1, y - 3, "#d42027"); // eyes
  setPx64(b, x - 1, y - 2, "#d42027"); setPx64(b, x, y - 2, "#d42027"); setPx64(b, x + 1, y - 2, "#d42027");
  setPx64(b, x - 1, y - 1, "#2E5DFF"); setPx64(b, x, y - 1, "#2E5DFF"); setPx64(b, x + 1, y - 1, "#2E5DFF");
  setPx64(b, x - 2, y, "#2E5DFF"); setPx64(b, x, y, "#2E5DFF"); setPx64(b, x + 2, y, "#2E5DFF");
  setPx64(b, x - 2, y + 1, "#2E5DFF"); setPx64(b, x + 2, y + 1, "#2E5DFF");
}
function renderSP() {
  const b = newBuf64("#0b1e3a");
  for (let i = 0; i < 50; i++) { const x = (i * 9 + 2) % 64, y = (i * 5) % 10; setPx64(b, x, y, "#445577"); }
  // distant skyline (parallax)
  for (let x = 0; x < 64; x++) {
    const wx = x + Math.floor(SP.scroll * 0.4);
    const h = 6 + (Math.abs(Math.sin(wx * 0.35)) * 8 | 0);
    for (let y = 24 - h; y < 26; y++) setPx64(b, x, y, "#1a2a4a");
    if (wx % 8 === 0) setPx64(b, x, 25 - h + 1, "#ffea00");
  }
  // ground with pits
  for (let x = 0; x < 64; x++) {
    const g = spGroundAt(x + SP.scroll);
    if (g < 0) { for (let y = 28; y < 36; y++) setPx64(b, x, y, "#000000"); }
    else { setPx64(b, x, 28, "#555555"); setPx64(b, x, 29, "#333333"); setPx64(b, x, 30, "#222222"); }
  }
  // drones (goblin pumpkins)
  for (const d of SP.drones) {
    disc64(b, Math.round(d.x), Math.round(d.y), 2, "#7CFC00");
    setPx64(b, Math.round(d.x), Math.round(d.y) - 2, "#ff9e00");
  }
  const sx = 12, sy = Math.round(SP.py);
  // web line when airborne
  const g0 = spGroundAt(sx + SP.scroll);
  if (SP.py < (g0 < 0 ? 28 : g0) - 1) linePx64(b, sx, sy - 4, sx + 10, 0, "#ffffff");
  if (!(SP.inv > 0 && SP.tick % 2 === 0)) drawSpidey64(b, sx, sy);
  for (let i = 0; i < SP.lives; i++) { setPx64(b, i * 4, 0, "#d42027"); setPx64(b, i * 4 + 1, 0, "#d42027"); }
  if (SP.over) {
    for (let y = 10; y <= 24; y++) for (let x = 8; x <= 54; x++) setPx64(b, x, y, "#000000");
    drawText64(b, "GAME", 22, 10, "#d42027");
    drawText64(b, "OVER", 22, 20, "#ffffff");
  }
  return pack64(b);
}
function spUpdateHUD() {
  document.querySelector("#sp-hud").textContent = `dist ${Math.floor(SP.score)}m • lives ${SP.lives}${SP.over ? " • GAME OVER" : ""}`;
}
async function spTick() {
  if (SP.over || spBusy) return;
  spBusy = true;
  try {
    SP.tick++;
    if (SP.inv > 0) SP.inv--;
    const speed = 2 + Math.min(3, SP.scroll / 500);
    if (SP.tick % 2 === 0) SP.scroll += speed;
    SP.score = SP.scroll / 4;
    const sx = 12, wx = sx + SP.scroll;
    const ground = spGroundAt(wx);
    // jump input
    if (jumpQueued) {
      jumpQueued = false;
      if (ground >= 0 && Math.abs(SP.py - (ground - 2)) < 2.4) { SP.vy = -3.8; SP.boosts = 0; }
      else if (SP.boosts < 1) { SP.vy = Math.min(SP.vy, -2.4); SP.boosts++; }
    }
    if (keysDown.has("Space") || keysDown.has("ArrowUp") || keysDown.has("KeyW")) {
      // hold = slightly lower gravity (higher float)
      SP.vy += 0.44;
    } else SP.vy += 0.6;
    SP.vy = Math.min(SP.vy, 4);
    SP.py += SP.vy;
    // land
    if (ground >= 0 && SP.py >= ground - 2 && SP.vy >= 0) { SP.py = ground - 2; SP.vy = 0; SP.boosts = 0; }
    // fell in pit
    if (SP.py > 34) {
      if (SP.inv <= 0) {
        SP.lives--; SP.inv = 12;
        log(`🕳️ pit! lives=${SP.lives}`);
        SP.py = 20; SP.vy = 0; SP.scroll += 12;
      } else { SP.py = 20; SP.vy = 0; }
    }
    spSpawnDrone();
    for (const d of SP.drones) d.x -= (2 + SP.scroll / 800);
    SP.drones = SP.drones.filter((d) => d.x > -4);
    for (const d of SP.drones) {
      if (Math.abs(d.x - sx) < 4 && Math.abs(d.y - SP.py) < 4 && SP.inv <= 0) {
        SP.lives--; SP.inv = 12;
        log(`🎃 pumpkin! lives=${SP.lives}`);
        d.x = -99;
      }
    }
    SP.drones = SP.drones.filter((d) => d.x > -4);
    if (SP.lives <= 0) { SP.over = true; log(`☠️ Spidey down — dist ${Math.floor(SP.score)}m`); }
    const frame = renderSP();
    drawPreview(frame);
    spUpdateHUD();
    await bulkPaintMap(frame);
    if (SP.over) await stopSPLive(true);
  } finally { spBusy = false; }
}
async function stopSPLive(done = false) {
  if (spTimer) { clearInterval(spTimer); spTimer = null; }
  document.querySelector("#b-sp-start").disabled = false;
  document.querySelector("#b-sp-stop").disabled = true;
  jumpQueued = false;
  if (done) log(`Spidey ended — ${Math.floor(SP.score)}m holds wall as ${me().name}`);
}
document.querySelector("#b-sp-start").addEventListener("click", async () => {
  stopAllModesQuiet(); spReset(); jumpQueued = false;
  document.querySelector("#b-sp-start").disabled = true;
  document.querySelector("#b-sp-stop").disabled = false;
  log("▶ Spidey LIVE — Space/WEB to swing. Watch gyanl.com/wall");
  spUpdateHUD();
  const f0 = renderSP(); drawPreview(f0);
  try { await bulkPaintMap(f0); } catch (e) { log(e.message); }
  spTimer = setInterval(spTick, 150);
});
document.querySelector("#b-sp-stop").addEventListener("click", () => stopSPLive(false));
document.querySelector("#sp-jump").addEventListener("pointerdown", (e) => { e.preventDefault(); jumpQueued = true; keysDown.add("Space"); });
for (const ev of ["pointerup", "pointerleave", "pointercancel"]) document.querySelector("#sp-jump").addEventListener(ev, (e) => { e.preventDefault(); keysDown.delete("Space"); });
