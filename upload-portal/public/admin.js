"use strict";
// David's review page: approve people, look over albums, approve or turn them down.

const $ = (s) => document.querySelector(s);

async function api(path, body) {
  const res = await fetch("/api/admin/" + path, body === undefined ? {} : {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  let data = {};
  try { data = await res.json(); } catch {}
  if (!res.ok) throw new Error(data.error || "Something went wrong (" + res.status + ").");
  return data;
}

function el(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") e.className = v; else if (k === "text") e.textContent = v; else e.setAttribute(k, v);
  }
  for (const k of kids) if (k != null) e.append(k);
  return e;
}

function button(text, quiet, fn, confirm) {
  const b = el("button", { type: "button", class: quiet ? "quiet" : "", text });
  b.onclick = async () => {
    if (confirm && !b.dataset.armed) {
      b.dataset.armed = "1";
      b.textContent = "Tap again to confirm";
      setTimeout(() => { delete b.dataset.armed; b.textContent = text; }, 4000);
      return;
    }
    b.disabled = true;
    try { await fn(); await load(); }
    catch (e) { showError(e.message); b.disabled = false; }
  };
  return b;
}

function showError(msg) { const e = $("#error"); e.textContent = msg; e.hidden = !msg; }

function when(iso) { return iso ? new Date(iso).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" }) : ""; }

function empty(list, text) { if (!list.children.length) list.append(el("li", { class: "hint", text })); }

async function reviewCard(a) {
  const wrap = el("div", { class: "review" });
  const label = el("input", { value: a.label, maxlength: "80", "aria-label": "Album name" });
  const year = el("input", { value: a.year ?? "", maxlength: "4", inputmode: "numeric", placeholder: "Year", "aria-label": "Year" });
  const note = el("input", { maxlength: "300", placeholder: "Reason, if you turn it down (they'll see this)", "aria-label": "Reason" });
  const thumbs = el("div", { class: "thumbs" });
  wrap.append(...[
    el("p", { class: "hint", text: "From " + a.ownerName + " (" + a.owner + ") · " + a.photoCount + " photos · sent " + when(a.submittedAt) }),
    el("div", { class: "fields" }, label, year),
    a.description ? el("p", { text: "“" + a.description + "”" }) : null,
    thumbs,
    note,
    el("div", { class: "actions" },
      button("Approve", false, () => api("albums/" + a.id + "/review", { action: "approve", label: label.value, year: year.value })),
      button("Turn down", true, () => api("albums/" + a.id + "/review", { action: "reject", note: note.value }), true)),
  ].filter(Boolean));
  try {
    const { photos } = await api("albums/" + a.id + "/photos");
    for (const p of photos) {
      if (p.file.endsWith(".heic")) { thumbs.append(el("span", { text: "iPhone photo" })); continue; }
      thumbs.append(el("img", { src: "/api/admin/albums/" + a.id + "/photos/" + p.file, alt: "", loading: "lazy" }));
    }
  } catch (e) { thumbs.append(el("span", { text: e.message })); }
  return wrap;
}

async function load() {
  showError("");
  const { requests, members, albums } = await api("overview");

  const rq = $("#requests");
  rq.replaceChildren();
  for (const r of requests) {
    rq.append(el("li", {},
      el("div", { class: "grow" }, el("strong", { text: r.name }),
        el("span", { class: "hint", text: r.email + (r.relation ? " · " + r.relation : "") + " · " + when(r.requestedAt) })),
      button("Approve", false, () => api("requests", { action: "approve", email: r.email, name: r.name })),
      button("Turn down", true, () => api("requests", { action: "deny", email: r.email }), true)));
  }
  empty(rq, "Nobody is waiting.");

  const pending = $("#pending");
  pending.replaceChildren();
  for (const a of albums.filter((a) => a.status === "pending")) pending.append(await reviewCard(a));
  if (!pending.children.length) pending.append(el("p", { class: "hint", text: "Nothing to review." }));

  const row = (a, ...actions) => el("li", {},
    el("div", { class: "grow" }, el("strong", { text: a.label + (a.year ? " (" + a.year + ")" : "") }),
      el("span", { class: "hint", text: a.ownerName + " · " + a.photoCount + " photos · " + when(a.reviewedAt || a.createdAt) + (a.note ? " · " + a.note : "") })),
    el("span", { class: "badge " + a.status, text: a.status }), ...actions);

  const approved = $("#approved");
  approved.replaceChildren();
  for (const a of albums.filter((a) => a.status === "approved")) {
    approved.append(row(a, button("Undo", true, () => api("albums/" + a.id + "/review", { action: "reject", note: "" }), true)));
  }
  empty(approved, "None right now.");

  const mem = $("#members");
  mem.replaceChildren();
  for (const m of members) {
    mem.append(el("li", {},
      el("div", { class: "grow" }, el("strong", { text: m.name }), el("span", { class: "hint", text: m.email + " · since " + when(m.approvedAt) })),
      button("Remove", true, () => api("requests", { action: "remove", email: m.email }), true)));
  }
  empty(mem, "No members yet.");

  const past = $("#past");
  past.replaceChildren();
  for (const a of albums.filter((a) => ["published", "rejected", "uploading"].includes(a.status))) {
    const acts = [];
    if (a.status === "rejected") acts.push(button("Approve after all", true, () => api("albums/" + a.id + "/review", { action: "approve" })));
    if (a.status !== "published") acts.push(button("Delete", true, () => api("albums/" + a.id + "/review", { action: "delete" }), true));
    past.append(row(a, ...acts));
  }
  empty(past, "None yet.");
}

load().catch((e) => showError(e.message));
