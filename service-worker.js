/**
 * オフライン(機内モード)でも、少なくとも一度取得できたものは見られるようにする Service Worker
 * (hateb-tycoon が元)。
 *
 * - アプリ本体(HTML/CSS/JS)と一覧データ(data/*.json)はオンライン時に先読みキャッシュする。
 * - 個別記事のコメント(b.hatena.ne.jp/entry/jsonlite/)は JSONP で callback 名が毎回変わるため
 *   ここではキャッシュできない。js/hatena-api.js が localStorage にキャッシュする(担当外)。
 * - 画像等はキャッシュ対象外(素通し)。オフラインで欠けても許容する。
 * - 「まずネットワーク、失敗したら前回キャッシュ」方式。オンライン中は常に最新を優先する。
 *
 * CACHE_VERSION はデプロイのたびにビルド SHA へ置換される(deploy-pages.yml)。
 * このファイルのバイト列が変わることで、ブラウザに新バージョンとして検知させる。
 */
const CACHE_VERSION = '__BUILD_SHA__';
const SHELL_CACHE = `feed-tycoon-shell-${CACHE_VERSION}`;
const DATA_CACHE = `feed-tycoon-data-${CACHE_VERSION}`;
const CURRENT_CACHES = [SHELL_CACHE, DATA_CACHE];

const SHELL_FILES = [
  'index.html',
  'css/style.css',
  'js/build-info.js',
  'js/filters.js',
  'js/rules-io.js',
  'js/visited.js',
  'js/gist.js',
  'js/filter-sync.js',
  'js/sources-sync.js',
  'js/hatena-api.js',
  'js/app.js',
];
const DATA_FILES = ['data/meta.json', 'data/feed.json'];

self.addEventListener('install', (event) => {
  event.waitUntil(
    (async () => {
      const shellCache = await caches.open(SHELL_CACHE);
      await shellCache.addAll(SHELL_FILES);

      const dataCache = await caches.open(DATA_CACHE);
      await Promise.all(
        DATA_FILES.map(async (path) => {
          try {
            const res = await fetch(path, { cache: 'no-store' });
            if (res && res.ok) await dataCache.put(path, res.clone());
          } catch (e) {
            // オフライン等で先読みできなくても致命的ではないため無視する
          }
        })
      );

      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((key) => !CURRENT_CACHES.includes(key)).map((key) => caches.delete(key)));
      await self.clients.claim();
    })()
  );
});

// ネットワークを優先し、成功したらキャッシュを更新する。失敗時(オフライン)は
// クエリ文字列違い(?v=<sha> や ?t=<時刻>)を無視してキャッシュから探す。
// data/*.json はビューアが CDN 回避のため毎回 ?t=<時刻> を付けて取得するので、
// キャッシュキーからクエリを外さないと、開くたびに別エントリが増え続ける。
async function networkFirstThenCache(request, cacheName) {
  const cache = await caches.open(cacheName);
  const url = new URL(request.url);
  const key = new Request(url.origin + url.pathname);
  try {
    const response = await fetch(request);
    if (response && response.ok) {
      cache.put(key, response.clone());
    }
    return response;
  } catch (err) {
    const cached = await cache.match(key, { ignoreSearch: true });
    if (cached) return cached;
    throw err;
  }
}

// ナビゲーション(トップページの読み込み)専用。実際のリクエスト URL(末尾スラッシュの有無、
// クエリ等)はそのままキャッシュキーにすると、オフライン時に見つからず FetchEvent が例外で
// 落ちる(hateb-tycoon で、アプリを完全終了してから機内モードで起動したときだけ再現した)。
// そのため常に固定キー 'index.html' で読み書きする。実 URL でのマッチングに戻さないこと。
async function handleNavigate(request) {
  const cache = await caches.open(SHELL_CACHE);
  try {
    const response = await fetch(request);
    if (response && response.ok) {
      cache.put('index.html', response.clone());
    }
    return response;
  } catch (err) {
    const cached = await cache.match('index.html');
    if (cached) return cached;
    throw err;
  }
}

function isShellRequest(pathname) {
  return SHELL_FILES.some((f) => pathname.endsWith(`/${f}`) || pathname.endsWith(f));
}

function isDataJsonRequest(pathname) {
  return /\/data\/[^/]+\.json$/.test(pathname);
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  if (request.mode === 'navigate') {
    event.respondWith(handleNavigate(request));
    return;
  }

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return; // クロスオリジンは素通し

  if (isShellRequest(url.pathname)) {
    event.respondWith(networkFirstThenCache(request, SHELL_CACHE));
  } else if (isDataJsonRequest(url.pathname)) {
    event.respondWith(networkFirstThenCache(request, DATA_CACHE));
  }
});
