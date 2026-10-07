/* 또랑또랑 서비스워커 — 앱 껍데기 오프라인 캐시 (오디오는 IndexedDB에 별도 저장) */
const CACHE = 'ttorang-v8';
const ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './config.js',
  './manifest.json',
  './icon.svg',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const { request } = e;
  if (request.method !== 'GET') return;
  e.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request)
        .then((res) => {
          // 같은 출처의 정적 파일만 캐시에 추가
          if (res.ok && new URL(request.url).origin === location.origin) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(request, copy));
          }
          return res;
        })
        .catch(() => cached);
    })
  );
});
