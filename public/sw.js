// Minimal service worker: lets the site install as an app and otherwise stays out of the way.
// Nothing is cached, so every deploy shows up immediately; offline page loads get a short notice.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => {
  if (event.request.mode !== "navigate") return;
  event.respondWith(
    fetch(event.request).catch(
      () =>
        new Response(
          '<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>مِرسال</title><body style="font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;margin:0;background:#eceff1;color:#333;text-align:center"><div><p style="font-size:18px;font-weight:600">لا يوجد اتصال بالإنترنت</p><p>تأكد من الاتصال ثم أعد فتح التطبيق.</p></div></body></html>',
          { headers: { "Content-Type": "text/html; charset=utf-8" } },
        ),
    ),
  );
});
