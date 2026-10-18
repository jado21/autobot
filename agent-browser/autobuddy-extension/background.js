const N8N_WEBHOOK_URL = "https://jado21.app.n8n.cloud/webhook-test/audit-vehicle";

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== "AUDIT") return;

  fetch(N8N_WEBHOOK_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ imageUrls: msg.imageUrls, listingUrl: msg.listingUrl })
  })
    .then(async (r) => {
      if (!r.ok) return sendResponse({ ok: false, status: r.status });
      sendResponse({ ok: true, data: await r.json() });
    })
    .catch((err) => sendResponse({ ok: false, status: 0, error: String(err) }));

  return true;
});
