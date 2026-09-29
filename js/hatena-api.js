/**
 * はてなブックマークの個別記事情報(コメント一覧含む)を取得するモジュール(hateb-tycoon が元)。
 *
 * https://b.hatena.ne.jp/entry/jsonlite/?url=... は CORS なしでも JSONP(<script> 挿入)で取得できる。
 * callback 名は呼び出しごとにランダムでなければならない(固定名にすると実際のはてな API が
 * 無応答になることを hateb-tycoon で実験確認済み)。そのため Service Worker ではキャッシュできず、
 * 取得に成功するたび解析済みデータを localStorage にキャッシュし、オフライン時など取得に失敗した
 * 場合は最後に見た内容へフォールバックする。
 */
(function (global) {
  const ENTRY_CACHE_KEY = 'feed-tycoon:entryCache';
  // コメント本文込みで 1 件あたりが大きいので、上限は少なめにする。
  const ENTRY_CACHE_MAX = 300;

  function loadEntryCache() {
    try {
      const raw = localStorage.getItem(ENTRY_CACHE_KEY);
      const parsed = raw ? JSON.parse(raw) : {};
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
    } catch (e) {
      return {};
    }
  }

  function cacheEntryInfo(pageUrl, info) {
    const map = loadEntryCache();
    map[pageUrl] = { time: Date.now(), info };
    const keys = Object.keys(map);
    if (keys.length > ENTRY_CACHE_MAX) {
      keys.sort((a, b) => map[a].time - map[b].time);
      keys.slice(0, keys.length - ENTRY_CACHE_MAX).forEach((k) => delete map[k]);
    }
    try {
      localStorage.setItem(ENTRY_CACHE_KEY, JSON.stringify(map));
    } catch (e) {
      // 容量超過等でも致命的ではない(オフライン復元をあきらめるだけ)
    }
  }

  function getCachedEntryInfo(pageUrl) {
    const rec = loadEntryCache()[pageUrl];
    return rec ? rec.info : null;
  }

  function jsonp(url, params, timeoutMs) {
    timeoutMs = timeoutMs || 10000;
    return new Promise((resolve, reject) => {
      const callbackName = `feedTycoonCb_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
      const query = new URLSearchParams(params || {});
      query.set('callback', callbackName);

      const script = document.createElement('script');
      let settled = false;
      let timer = null;

      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        delete global[callbackName];
        if (script.parentNode) script.parentNode.removeChild(script);
        clearTimeout(timer);
        fn(value);
      };

      global[callbackName] = (data) => finish(resolve, data);
      timer = setTimeout(() => finish(reject, new Error('リクエストがタイムアウトしました')), timeoutMs);
      script.onerror = () => finish(reject, new Error('データの取得に失敗しました(ネットワークエラー)'));
      script.src = `${url}?${query.toString()}`;
      document.head.appendChild(script);
    });
  }

  function safeHostname(url) {
    try {
      return new URL(url).hostname;
    } catch (e) {
      return '';
    }
  }

  function normalizeEntryInfo(raw, pageUrl) {
    const url = raw.url || pageUrl || '';
    const bookmarks = Array.isArray(raw.bookmarks) ? raw.bookmarks : [];
    return {
      title: raw.title || '(タイトル不明)',
      url,
      domain: safeHostname(url),
      count: raw.count != null ? raw.count : 0,
      entryUrl: raw.eid ? `https://b.hatena.ne.jp/entry/${raw.eid}` : null,
      bookmarks: bookmarks.map((b) => ({
        user: b.user || '(不明なユーザー)',
        comment: b.comment || '',
        timestamp: b.timestamp || '',
        tags: Array.isArray(b.tags) ? b.tags : [],
      })),
    };
  }

  async function getEntryInfo(pageUrl) {
    try {
      const data = await jsonp('https://b.hatena.ne.jp/entry/jsonlite/', { url: pageUrl });
      const info = normalizeEntryInfo(data, pageUrl);
      cacheEntryInfo(pageUrl, info);
      return info;
    } catch (err) {
      const cached = getCachedEntryInfo(pageUrl);
      if (cached) return { ...cached, fromOfflineCache: true };
      throw err;
    }
  }

  global.HatenaAPI = { getEntryInfo };
})(window);
