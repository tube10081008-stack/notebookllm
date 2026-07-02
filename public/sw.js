// sw.js — BrainStation PWA 서비스 워커 (로컬 개발 친화형)
self.addEventListener('install', (e) => {
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(clients.claim());
});

self.addEventListener('fetch', (e) => {
  // 로컬 개발 환경에서 실시간 갱신을 위해 캐시하지 않고 네트워크에서 직접 응답을 가져옵니다.
  e.respondWith(fetch(e.request));
});
