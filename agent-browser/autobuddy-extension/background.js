// El service worker hace el fetch (evita problemas de CORS del content script).
const N8N_WEBHOOK_URL = "https://jado21.app.n8n.cloud/webhook/audit-vehicle";

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== "AUDIT") return;

  fetch(N8N_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ imageUrls: msg.imageUrls, listingUrl: msg.listingUrl })
  })
    .then((r) => r.json())
    .then((data) => sendResponse({ ok: true, data }))
    .catch((err) => sendResponse({ ok: false, error: String(err) }));

  return true; // respuesta asíncrona
});
