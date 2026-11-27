"use strict";
// The family upload page. Talks only to this portal's own /api.

const $ = (s) => document.querySelector(s);
const OK_TYPES = /\.(jpe?g|png|heic|heif)$/i;
let limits = { photoBytes: 30 * 1024 * 1024, photosPerAlbum: 300 };
let picked = []; // { file, fig }
let addTo = null; // album being added to, or null for a new album

async function api(path, opts = {}) {
  const res = await fetch("/api/" + path, {
    credentials: "same-origin",
    ...opts,
    headers: opts.body && !(opts.body instanceof Blob) ? { "content-type": "application/json" } : opts.headers,
  });
  let data = {};
  try { data = await res.json(); } catch {}
  if (!res.ok) throw new Error(data.error || "Something went wrong (" + res.status + "). Please try again.");
  return data;
}

function show(id) {
  for (const s of ["loading", "request", "waiting", "blocked", "upload", "mine"]) $("#" + s).hidden = !id.includes(s);
}

function el(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") e.className = v; else if (k === "text") e.textContent = v; else e.setAttribute(k, v);
  }
  for (const k of kids) e.append(k);
  return e;
}

const STATUS = {
  uploading: "Not finished",
  pending: "Waiting for David",
  approved: "Approved, going on the site soon",
  published: "On the site",
  rejected: "Not added",
};

async function loadMine() {
  const { albums } = await api("albums");
  const list = $("#mine-list");
  list.replaceChildren();
  $("#mine").hidden = !albums.length;
  for (const a of albums) {
    const title = a.addTo ? "More photos for " + a.label : a.label + (a.year ? " (" + a.year + ")" : "");
    const info = el("div", { class: "grow" },
      el("strong", { text: title }),
      el("span", { class: "hint", text: a.photoCount + " photos" + (a.note ? " · " + a.note : "") }));
    const li = el("li", {}, info, el("span", { class: "badge " + a.status, text: STATUS[a.status] || a.status }));
    if (a.status === "published") li.append(el("a", { class: "mail", href: "https://sibilia.us/home.html#family", text: "See it on the site" }));
    if (!a.addTo && ["pending", "approved", "published"].includes(a.status)) {
      const add = el("button", { class: "quiet", type: "button", text: "Add photos" });
      add.onclick = () => startAdding(a);
      li.append(add);
    }
    if (a.status === "uploading" || a.status === "pending") {
      const b = el("button", { class: "quiet", type: "button", text: "Withdraw" });
      b.onclick = async () => {
        if (!confirmInline(b)) return;
        await api("albums/" + a.id, { method: "DELETE" });
        loadMine();
      };
      li.append(b);
    }
    list.append(li);
  }
}

function startAdding(a) {
  addTo = a;
  $("#upload-title").textContent = "Add photos to \u201c" + a.label + "\u201d";
  $("#upload-intro").textContent = "David will look these over too, then they'll join the same album on the site.";
  $("#album-fields").hidden = true;
  $("#label").required = false;
  $("#send").textContent = "Upload photos";
  $("#cancel-add").hidden = false;
  $("#upload").scrollIntoView({ behavior: "smooth" });
}

function stopAdding() {
  addTo = null;
  $("#upload-title").textContent = "New album";
  $("#upload-intro").textContent = "Your photos become a new card on the family site once David has looked them over.";
  $("#album-fields").hidden = false;
  $("#label").required = true;
  $("#send").textContent = "Upload album";
  $("#cancel-add").hidden = true;
}

// Two taps to confirm, without a pop-up dialog.
function confirmInline(btn) {
  if (btn.dataset.armed) return true;
  btn.dataset.armed = "1";
  const old = btn.textContent;
  btn.textContent = "Tap again to confirm";
  setTimeout(() => { delete btn.dataset.armed; btn.textContent = old; }, 4000);
  return false;
}

function addFiles(files) {
  const err = $("#album-form .error");
  err.hidden = true;
  const skipped = [];
  for (const file of files) {
    if (!OK_TYPES.test(file.name) && !/^image\/(jpeg|png|heic|heif)$/.test(file.type)) { skipped.push(file.name + " (not a photo)"); continue; }
    if (file.size > limits.photoBytes) { skipped.push(file.name + " (too big)"); continue; }
    if (picked.length >= limits.photosPerAlbum) { skipped.push(file.name + " (album is full)"); continue; }
    const fig = el("figure");
    if (/^image\/(jpeg|png)$/.test(file.type)) {
      const img = el("img", { alt: "" });
      img.src = URL.createObjectURL(file);
      fig.append(img);
    } else fig.append(el("span", { text: file.name }));
    const entry = { file, fig };
    const rm = el("button", { type: "button", class: "quiet", "aria-label": "Remove", text: "×" });
    rm.onclick = () => { picked = picked.filter((p) => p !== entry); fig.remove(); summary(); };
    fig.append(rm);
    picked.push(entry);
    $("#picked").append(fig);
  }
  summary();
  if (skipped.length) { err.textContent = "Skipped: " + skipped.join(", "); err.hidden = false; }
}

function summary() {
  const mb = picked.reduce((s, p) => s + p.file.size, 0) / 1048576;
  $("#picked-summary").textContent = picked.length ? picked.length + " photos, " + mb.toFixed(1) + " MB" : "";
}

async function uploadOne(id, n, file) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await api("albums/" + id + "/photos/" + n + "?name=" + encodeURIComponent(file.name.slice(0, 120)), {
        method: "PUT",
        body: file,
        headers: { "content-type": "application/octet-stream" },
      });
    } catch (e) {
      if (attempt === 2 || /Only photos|under 30 MB/.test(e.message)) throw e;
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
}

async function sendAlbum(ev) {
  ev.preventDefault();
  const form = ev.target;
  const err = form.querySelector(".error");
  err.hidden = true;
  if (!picked.length) { err.textContent = "Please choose some photos first."; err.hidden = false; return; }
  const btn = $("#send");
  btn.disabled = true;
  const bar = $("#progress");
  bar.hidden = false;
  const status = $("#status");
  try {
    const fd = new FormData(form);
    const { album } = await api("albums", {
      method: "POST",
      body: JSON.stringify(addTo ? { addTo: addTo.id }
        : { label: fd.get("label"), year: fd.get("year"), description: fd.get("description") }),
    });
    let done = 0;
    const failed = [];
    const queue = picked.map((p, i) => ({ ...p, n: i + 1 }));
    async function worker() {
      while (queue.length) {
        const p = queue.shift();
        try { await uploadOne(album.id, p.n, p.file); p.fig.classList.add("done"); }
        catch (e) { failed.push(p.file.name + ": " + e.message); p.fig.classList.add("bad"); }
        done++;
        bar.firstElementChild.style.width = (100 * done / picked.length) + "%";
        status.textContent = "Uploading " + done + " of " + picked.length + "…";
      }
    }
    await Promise.all([worker(), worker(), worker()]);
    if (failed.length === picked.length) throw new Error("None of the photos could be uploaded. " + failed[0]);
    await api("albums/" + album.id + "/submit", { method: "POST", body: "{}" });
    status.textContent = addTo ? "Done! David will look over your new photos soon." : "Done! David will look over your album soon.";
    if (failed.length) { err.textContent = "Some photos were skipped: " + failed.join("; "); err.hidden = false; }
    form.reset();
    stopAdding();
    picked = [];
    $("#picked").replaceChildren();
    summary();
    loadMine();
  } catch (e) {
    err.textContent = e.message;
    err.hidden = false;
    status.textContent = "";
  } finally {
    btn.disabled = false;
    setTimeout(() => { bar.hidden = true; bar.firstElementChild.style.width = "0"; }, 1500);
  }
}

async function start() {
  try {
    const me = await api("me");
    limits = me.limits || limits;
    $("#who").textContent = "Signed in as " + me.email;
    if (me.admin) $("#who").append(" · ", el("a", { href: "/admin.html", text: "Review uploads" }));
    if (me.member) { show(["upload", "mine"]); loadMine(); }
    else if (me.blocked) show(["blocked"]);
    else if (me.requested) show(["waiting"]);
    else show(["request"]);
  } catch (e) {
    $("#loading").textContent = e.message;
  }
}

$("#request-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  const fd = new FormData(ev.target);
  const err = ev.target.querySelector(".error");
  try {
    await api("request", { method: "POST", body: JSON.stringify({ name: fd.get("name"), relation: fd.get("relation") }) });
    show(["waiting"]);
  } catch (e) { err.textContent = e.message; err.hidden = false; }
});
$("#album-form").addEventListener("submit", sendAlbum);
$("#cancel-add").addEventListener("click", stopAdding);
$("#files").addEventListener("change", (e) => { addFiles(e.target.files); e.target.value = ""; });
const drop = $("#drop");
drop.addEventListener("dragover", (e) => { e.preventDefault(); drop.classList.add("over"); });
drop.addEventListener("dragleave", () => drop.classList.remove("over"));
drop.addEventListener("drop", (e) => { e.preventDefault(); drop.classList.remove("over"); addFiles(e.dataTransfer.files); });
start();
