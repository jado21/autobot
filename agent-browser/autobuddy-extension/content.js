const IS_FB = location.hostname.includes("facebook.com");
const IS_DETAIL = IS_FB
  ? /\/marketplace\/item\//.test(location.pathname)
  : (/\/MPE-\d+/i.test(location.pathname) || !!document.querySelector(".ui-pdp-gallery"));



// ====== CONFIG ======
const MOCK_MODE = false;          // true = simula respuestas; false = webhook real
const MAX_PER_MINUTE = 12;       // límite real: 15/min, dejamos margen
const MAX_CONCURRENT = 2;        // peticiones simultáneas
const RETRY_DELAY_MS = 20000;    // espera tras un 429
const VISIBLE_RATIO = 0.5;       // % de la tarjeta que debe verse

const CARD_SELECTOR = IS_FB
  ? 'a[href*="/marketplace/item/"]'
  : ".ui-search-layout__item, .ui-search-result, .poly-card";

// ====== ESTADO ======
const done = new WeakSet();          // tarjetas ya resueltas
const queue = [];                    // tarjetas visibles esperando turno
const sentTimestamps = [];           // ventana deslizante de 60 s
const observed = new WeakSet();
let inFlight = 0;
let pumpTimer = null;
let mockCounter = 0;

// ====== CACHÉ (por URL de imagen) ======
const memCache = new Map();
function cacheGet(url) {
  if (memCache.has(url)) return memCache.get(url);
  try {
    const raw = sessionStorage.getItem("autobuddy:" + url);
    if (raw) { const v = JSON.parse(raw); memCache.set(url, v); return v; }
  } catch (_) {}
  return null;
}
function cacheSet(url, data) {
  memCache.set(url, data);
  try { sessionStorage.setItem("autobuddy:" + url, JSON.stringify(data)); } catch (_) {}
}

// ====== UTILIDADES ======
function getImageUrl(card) {
  const img = card.querySelector("img");
  if (!img) return null;
  return [img.getAttribute("data-src"), img.currentSrc, img.src]
    .find((u) => u && /^https?:/i.test(u)) || null;
}

function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text) n.textContent = text;
  return n;
}

function mockResponse() {
  mockCounter++;
  if (mockCounter % 3 === 0) {
    return { status: "FLAGGED", plate: "BUS-086", isTampered: false, fineAmount: 1850,
             hasWarrant: true, reason: "Papeletas impagas y orden de captura vigente." };
  }
  if (mockCounter % 3 === 2) return { status: "UNVERIFIED", reason: "No se pudo verificar." };
  return { status: "CLEAN" };
}

function callWebhook(imageUrl, listingUrl) {
  if (MOCK_MODE) {
    return new Promise((res) => setTimeout(() => res({ ok: true, data: mockResponse() }), 600));
  }
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(
      { type: "AUDIT", imageUrls: [imageUrl], listingUrl },
      (resp) => resolve(chrome.runtime.lastError ? { ok: false, status: 0 } : resp)
    );
  });
}

// Identifica el anuncio por su código MPE (estable aunque cambie el enlace de rastreo)
function listingIdFromUrl(href) {
  const fb = /\/marketplace\/item\/(\d+)/.exec(href || "");
  if (fb) return "FB-" + fb[1];
  const m = /MPE-?(\d+)/i.exec(href || "");
  if (m) return "MPE-" + m[1];
  try { const u = new URL(href, location.href); return u.origin + u.pathname; }
  catch (_) { return null; }
}

function getListingUrl(card) {
  const a = card.matches("a[href]") ? card : card.querySelector("a[href]");
  return a ? listingIdFromUrl(a.href) : null;
}

// ====== UI ======
function showFlagged(card, data) {
  card.classList.add("autobuddy-parent");
  const overlay = el("div", "autobuddy-flag-overlay");
  const panel = el("div", "autobuddy-flag-panel");

  panel.appendChild(el("span", "autobuddy-badge", "⚠️ Alerta preventiva"));
  if (data.plate) panel.appendChild(el("span", "autobuddy-plate", data.plate));
  panel.appendChild(el("p", "autobuddy-reason", data.reason || "Presenta inconsistencias graves."));

  const facts = [];
  if (data.hasWarrant) facts.push("Orden de captura");
  if (data.fineAmount > 0) facts.push(`Multas: S/ ${data.fineAmount}`);
  if (data.isTampered) facts.push("Posible ocultamiento de placa");
  if (facts.length) panel.appendChild(el("p", "autobuddy-facts", facts.join(" · ")));
  if (data.plate && !data.isTampered)
  panel.appendChild(el("p", "autobuddy-facts", "Placa leída por IA: verifica que coincida con la foto"));

  const btn = el("button", "autobuddy-btn", "Ocultar alerta");
  btn.type = "button";
  btn.addEventListener("click", (e) => {
    e.preventDefault(); e.stopPropagation();
    overlay.remove();
    card.classList.remove("autobuddy-parent");
  });
  panel.appendChild(btn);

  overlay.appendChild(panel);
  card.appendChild(overlay);
}

function showPending(card) {
  card.classList.add("autobuddy-parent");
  const t = el("span", "autobuddy-tag autobuddy-tag-pending", "Consultando SAT…");
  card.appendChild(t);
  return t;
}

function showUnverified(card) {
  card.classList.add("autobuddy-parent");
  card.appendChild(el("span", "autobuddy-tag-unverified", "No verificado"));
}

function showTag(card, cls, text) {
  card.classList.add("autobuddy-parent");
  card.appendChild(el("span", "autobuddy-tag " + cls, text));
}

function render(card, data) {
  const p = data.plate || "?";
  if (data.status === "FLAGGED") showFlagged(card, data);
  else if (data.status === "UNVERIFIED") showUnverified(card);
  else if (data.status === "WARNING")
    showTag(card, "autobuddy-tag-warning", `Multas S/ ${data.fineAmount} · ${p} · confirma placa`);
  else if (data.status === "CLEAN")
    showTag(card, "autobuddy-tag-possible",
      data.dataSource === "SAT Lima" ? `Sin deuda · ${p} · confirma placa` : "Sin hallazgos (demo)");
}

// ====== COLA CON LÍMITE DE RITMO ======
function enqueue(card) {
  if (done.has(card) || queue.includes(card)) return;

  const url = getImageUrl(card);
  if (!url) return;

  const cached = cacheGet(url);
  if (cached) { done.add(card); render(card, cached); return; }

  queue.push(card);
  pump();
}

function dequeue(card) {
  const i = queue.indexOf(card);
  if (i !== -1) queue.splice(i, 1);
}

function pump() {
  clearTimeout(pumpTimer);
  const now = Date.now();
  while (sentTimestamps.length && now - sentTimestamps[0] > 60000) sentTimestamps.shift();

  while (queue.length && inFlight < MAX_CONCURRENT &&
         (MOCK_MODE || sentTimestamps.length < MAX_PER_MINUTE)) {
    const card = queue.pop(); // la última tarjeta vista tiene prioridad
    processCard(card);
  }

  // Si hay cola pero estamos topados por el límite, reprogramar
  if (queue.length && !MOCK_MODE && sentTimestamps.length >= MAX_PER_MINUTE) {
    const wait = 60000 - (now - sentTimestamps[0]) + 50;
    pumpTimer = setTimeout(pump, wait);
  }
}

async function processCard(card) {
  const url = getImageUrl(card);
  if (!url) return;

  inFlight++;
  sentTimestamps.push(Date.now());
  const pendingEl = showPending(card);

  const resp = await callWebhook(url, getListingUrl(card));
  pendingEl.remove();
  inFlight--;

  if (resp?.ok) {
    cacheSet(url, resp.data);
    done.add(card);
    render(card, resp.data);
  } else if (resp?.status === 429 || resp?.status === 0) {
    // Límite alcanzado o fallo de red: reintentar luego si sigue visible
    setTimeout(() => { if (visibleCards.has(card)) enqueue(card); }, RETRY_DELAY_MS);
  } else {
    console.error("[AutoSentinel] Error del webhook:", resp);
    done.add(card); // error definitivo: no insistir
  }
  pump();
}

// ====== DETECCIÓN DE TARJETAS VISIBLES ======
const visibleCards = new Set();

const io = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    const card = entry.target;
    if (entry.isIntersecting) {
      visibleCards.add(card);
      enqueue(card);
    } else {
      visibleCards.delete(card);
      dequeue(card); // salió de pantalla antes de enviarse: se descarta
    }
  }
}, { threshold: VISIBLE_RATIO });

function observeCards() {
  if (IS_DETAIL) return;
  document.querySelectorAll(CARD_SELECTOR).forEach((card) => {
    if (!observed.has(card)) { observed.add(card); io.observe(card); }
  });
}

let moTimer;
new MutationObserver(() => {
  clearTimeout(moTimer);
  moTimer = setTimeout(() => {
    observeCards();
    visibleCards.forEach(enqueue); // reintenta tarjetas visibles cuyo img cargó tarde
  }, 400);
}).observe(document.body, { childList: true, subtree: true });

observeCards();
