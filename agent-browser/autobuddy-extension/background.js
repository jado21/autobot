const N8N_WEBHOOK_URL = "https://jado21.app.n8n.cloud/webhook/audit-vehicle";
const TIMEOUT_MS = 110000;

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== "AUDIT") return;

  // Evita que Chrome apague el service worker durante consultas largas
  const keepAlive = setInterval(() => chrome.runtime.getPlatformInfo(() => {}), 20000);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

  fetch(N8N_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ imageUrls: msg.imageUrls, listingUrl: msg.listingUrl }),
    signal: ctrl.signal
  })
    .then(async (r) => {
      if (!r.ok) return sendResponse({ ok: false, status: r.status });
      sendResponse({ ok: true, data: await r.json() });
    })
    .catch((err) => sendResponse({ ok: false, status: 0, error: String(err) }))
    .finally(() => { clearInterval(keepAlive); clearTimeout(timer); });

  return true;
});