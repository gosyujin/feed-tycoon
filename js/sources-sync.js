/**
 * 取得元(フィード)一覧をシークレットGistで管理するモジュール。
 *
 * - 一覧は、フィルタと同じGist(js/filter-sync.js のGist ID)の feed-tycoon-sources.json に置く。
 *   取得側(scripts/fetch_feeds.py)は Actions の変数 FEED_GIST_ID の同じGistから読む。
 * - フィルタCSVと違い、削除も同期する必要があるため和集合ではなく「読む→変更→上書き」で保存する。
 *   保存の直前に必ず読み直すので、別端末での変更を巻き戻しにくい(同時編集は後勝ち)。
 * - Gistにファイルがまだ無いときは、リポジトリの sources.json(初期値)を一覧として出す。
 *   最初の追加・削除で、その一覧がGistへ書き込まれる。
 * - 読み取りは認証不要、書き込みは js/gist.js のトークンが必要。
 */
(function (global) {
  const FILE = 'feed-tycoon-sources.json';

  // 一覧を返す。fromGist: false はGistにファイルが無く、初期値(sources.json)を使ったことを表す。
  async function load(gistId) {
    const res = await Gist.get(gistId);
    const text = (await Gist.fileText(res.json, FILE)).trim();
    if (text) {
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch (e) {
        throw new Error(`${FILE} のJSONが壊れています`);
      }
      return { sources: Array.isArray(parsed.sources) ? parsed.sources : [], fromGist: true };
    }
    const seed = await fetch(`sources.json?t=${Date.now()}`, { cache: 'no-cache' });
    if (!seed.ok) throw new Error(`sources.json: HTTP ${seed.status}`);
    return { sources: (await seed.json()).sources || [], fromGist: false };
  }

  async function save(gistId, sources) {
    await Gist.update(gistId, { [FILE]: JSON.stringify({ sources }, null, 2) + '\n' });
  }

  // 取得側(normalize_source)と同じ条件: http(s) のみ、ローカル宛は不可。正常なら URL オブジェクトを返す。
  function parseFeedUrl(input) {
    let url;
    try {
      url = new URL(String(input || '').trim());
    } catch (e) {
      throw new Error('URLの形式が正しくありません');
    }
    const host = url.hostname.toLowerCase();
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('http(s) のURLだけ追加できます');
    if (host === 'localhost' || /\.(localhost|local|internal)$/.test(host) || /^[\d.]+$/.test(host) || host.includes(':')) {
      throw new Error('ローカルやIPアドレス宛のURLは追加できません');
    }
    return url;
  }

  function makeId(url, sources) {
    const path = url.pathname.split('/').filter(Boolean)[0] || '';
    const base = `${url.hostname}${path ? '-' + path : ''}`.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
    const taken = new Set(sources.map((s) => s.id));
    let id = base || 'feed';
    for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
    return id;
  }

  // 追加する1件を作る。URLの重複は拒否する。
  function buildSource(sources, urlInput, name) {
    const url = parseFeedUrl(urlInput);
    if (sources.some((s) => s.url === url.href)) throw new Error('すでに登録されています');
    return { id: makeId(url, sources), name: String(name || '').trim() || url.hostname, type: 'rss', url: url.href, tags: [] };
  }

  global.SourcesSync = { load, save, buildSource };
})(window);
