// ====== CONFIG ======
const MOCK_MODE_DETAIL = false;  // true = simula respuestas
const DWELL_MS = 700;            // la imagen debe quedarse as� antes de analizar
const MIN_WIDTH = 500;           // descarta im�genes de baja resoluci�n (px naturales)
const MIN_RENDERED = 300;        // ancho m�nimo en pantalla: descarta miniaturas
const MAX_PHOTOS = 8;            // tope de fotos analizadas por anuncio (cuida tu cuota)

const IS_DETAIL_PAGE = /\/MPE-\d+/i.test(location.pathname) || !!document.querySelector(".ui-pdp-gallery");

if (IS_DETAIL_PAGE) {
  const analyzed = new Map();   // url -> respuesta del backend
  let busy = false;
  let timer = null;
  let panel = null;

  function getMainImage() {
    const scope = document.querySelector(".ui-pdp-gallery") || document;
    let best = null, bestArea = 0;
    for (const img of scope.querySelectorAll("img")) {
      const r = img.getBoundingClientRect();
      if (r.width < MIN_RENDERED || !img.complete || !img.naturalWidth) continue;
      const area = r.width * r.height;
      if (area > bestArea) { best = img; bestArea = area; }
    }
    return best;
  }

  function getUrl(img) {
    const zoom = img.getAttribute("data-zoom");  // si existe, suele ser la versi�n grande
    return [zoom, img.currentSrc, img.src].find(u => u && /^https?:/i.test(u)) || null;
  }

  function callBackend(url) {
    if (MOCK_MODE_DETAIL) {
      return new Promise(res => setTimeout(() =>
        res({ ok: true, data: { status: "UNVERIFIED", reason: "Simulado." } }), 600));
    }
    return new Promise(resolve => {
      chrome.runtime.sendMessage(
        { type: "AUDIT", imageUrls: [url], listingUrl: location.href },
        resp => resolve(chrome.runtime.lastError ? { ok: false, status: 0 } : resp)
      );
    });
  }

  // Combina los resultados de todas las fotos vistas
  function combine() {
    const all = [...analyzed.values()];
    const withPlate = all.find(r => r.plate && ["FLAGGED", "WARNING", "CLEAN", "UNVERIFIED"].includes(r.status));
    const tampered = all.filter(r => r.isTampered);
    if (withPlate) return { ...withPlate, n: all.length };
    if (tampered.length) {
      return { status: "FLAGGED", isTampered: true, n: all.length,
               reason: `Placa oculta o editada en ${tampered.length} de ${all.length} fotos revisadas. ${tampered[0].reason || ""}` };
    }
    return { status: "UNVERIFIED", n: all.length,
             reason: "La placa no se ve en las fotos revisadas. Pasa el mouse por más fotos." };
  }

  function renderPanel() {
    const d = combine();
    if (!panel) { panel = document.createElement("div"); document.body.appendChild(panel); }
    panel.className = "autobuddy-detail autobuddy-detail-" + d.status.toLowerCase();
    panel.textContent = "";
    const add = (cls, text) => { const p = document.createElement("div"); p.className = cls; p.textContent = text; panel.appendChild(p); };
    const titles = { FLAGGED: "⛔ Riesgo detectado", WARNING: "⚠️ Multas pendientes",
                 CLEAN: "✅ Sin hallazgos", UNVERIFIED: "❓ No verificado" };
    add("autobuddy-detail-title", titles[d.status]);
    if (d.plate) add("autobuddy-detail-plate", d.plate);
    if (d.reason) add("autobuddy-detail-reason", d.reason);
    if (d.fineAmount > 0) add("autobuddy-detail-reason", `Multas: S/ ${d.fineAmount}`);
    add("autobuddy-detail-meta", `Fotos revisadas: ${d.n} · datos de multas de demostración`);
  }

  async function analyzeCurrent() {
    if (busy || analyzed.size >= MAX_PHOTOS) return;
    const img = getMainImage();
    if (!img || img.naturalWidth < MIN_WIDTH) return;
    const url = getUrl(img);
    if (!url || analyzed.has(url)) return;

    busy = true;
    const resp = await callBackend(url);
    busy = false;

    if (resp?.ok) { analyzed.set(url, resp.data); renderPanel(); }
    else console.error("[AutoSentinel] Error del webhook:", resp);
  }

  // Espera a que la imagen principal se estabilice antes de analizar
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(analyzeCurrent, DWELL_MS);
  }

  const gallery = document.querySelector(".ui-pdp-gallery") || document.body;
  gallery.addEventListener("mouseover", schedule);
  new MutationObserver(schedule).observe(gallery, {
    attributes: true, attributeFilter: ["src", "srcset", "class"], childList: true, subtree: true
  });
  schedule(); // primera foto al cargar
}
