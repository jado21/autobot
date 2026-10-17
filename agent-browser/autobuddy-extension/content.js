// ====== CONFIG ======
// true  = simula respuestas (cada 3ra tarjeta sale FLAGGED) para la demo
// false = usa el webhook real de n8n
const MOCK_MODE = true;

const CARD_SELECTOR = [
  ".ui-search-layout__item",
  ".ui-search-result",
  ".poly-card"
].join(",");

const processed = new WeakSet();
let mockCounter = 0;

function getImageUrl(img) {
  const candidates = [
    img.getAttribute("data-src"),
    img.currentSrc,
    img.src
  ];
  return candidates.find((u) => u && /^https?:/i.test(u)) || null;
}

function mockResponse() {
  mockCounter++;
  if (mockCounter % 3 === 0) {
    return {
      status: "FLAGGED",
      plate: "BUS-086",
      isTampered: false,
      fineAmount: 1850,
      hasWarrant: true,
      reason: "Papeletas impagas y orden de captura vigente."
    };
  }
  if (mockCounter % 3 === 2) {
    return { status: "UNVERIFIED", reason: "No se pudo verificar." };
  }
  return { status: "CLEAN" };
}

function audit(imageUrl) {
  if (MOCK_MODE) {
    return new Promise((res) => setTimeout(() => res(mockResponse()), 600));
  }
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      { type: "AUDIT", imageUrls: [imageUrl], listingUrl: location.href },
      (resp) => {
        if (chrome.runtime.lastError) return reject(chrome.runtime.lastError);
        if (!resp?.ok) return reject(new Error(resp?.error || "Error"));
        resolve(resp.data);
      }
    );
  });
}

function el(tag, className, text) {
  const n = document.createElement(tag);
  if (className) n.className = className;
  if (text) n.textContent = text; // textContent: evita XSS
  return n;
}

function showFlagged(card, data) {
  card.classList.add("autobuddy-parent");

  const overlay = el("div", "autobuddy-flag-overlay");
  const panel = el("div", "autobuddy-flag-panel");

  panel.appendChild(el("span", "autobuddy-badge", "⚠️ Riesgo detectado"));
  if (data.plate) panel.appendChild(el("span", "autobuddy-plate", data.plate));

  panel.appendChild(
    el("p", "autobuddy-reason", data.reason || "Presenta inconsistencias graves.")
  );

  const facts = [];
  if (data.hasWarrant) facts.push("Orden de captura");
  if (data.fineAmount > 0) facts.push(`Multas: S/ ${data.fineAmount}`);
  if (data.isTampered) facts.push("Placa alterada");
  if (facts.length) panel.appendChild(el("p", "autobuddy-facts", facts.join(" · ")));

  const btn = el("button", "autobuddy-btn", "Ocultar alerta");
  btn.type = "button";
  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    overlay.remove();
    card.classList.remove("autobuddy-parent");
  });
  panel.appendChild(btn);

  overlay.appendChild(panel);
  card.appendChild(overlay);
}

function showUnverified(card) {
  card.classList.add("autobuddy-parent");
  card.appendChild(el("span", "autobuddy-tag-unverified", "No verificado"));
}

async function auditCard(card) {
  if (processed.has(card)) return;
  const img = card.querySelector("img");
  if (!img) return;
  const url = getImageUrl(img);
  if (!url) return; // imagen aún no cargada; se reintentará en el próximo escaneo

  processed.add(card);
  try {
    const data = await audit(url);
    if (data.status === "FLAGGED") showFlagged(card, data);
    else if (data.status === "UNVERIFIED") showUnverified(card);
  } catch (err) {
    console.error("[AutoSentinel] Error auditando vehículo:", err);
  }
}

function scanPage() {
  document.querySelectorAll(CARD_SELECTOR).forEach(auditCard);
}

let timer;
new MutationObserver(() => {
  clearTimeout(timer);
  timer = setTimeout(scanPage, 400);
}).observe(document.body, { childList: true, subtree: true });

scanPage();
