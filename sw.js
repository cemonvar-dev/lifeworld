// Service Worker for PWA and FCM
self.addEventListener("install", () => {
  console.log("Service worker installed");
  self.skipWaiting();
});

self.addEventListener("fetch", () => {});

// Handle push events (for FCM)
self.addEventListener('push', function(event) {
  let data = {};
  if (event.data) {
    data = event.data.json();
  }
  const title = data.notification?.title || 'Notification';
  const options = {
    body: data.notification?.body || '',
    icon: data.notification?.icon || '/logo.png',
    badge: data.notification?.badge || '/logo.png',
    data: data.notification?.data || {},
  };
  event.waitUntil(self.registration.showNotification(title, options));
});