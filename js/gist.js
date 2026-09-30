/**
 * GitHub Gist APIの共通部分(フィルタ同期 js/filter-sync.js が使う。hateb-tycoon の js/gist.js が元)。
 *
 * - トークン(classic PATのgistスコープ)はここで一元管理する。端末のlocalStorageに保存される。
 * - 読み取り(シークレットGist)は認証不要。トークンが必要なのは作成・書き込みのみ。
 */
(function (global) {
  const API = 'https://api.github.com/gists';
  const TOKEN_KEY = 'feed-tycoon:gistToken';

  function getToken() {
    try {
      return localStorage.getItem(TOKEN_KEY) || '';
    } catch (e) {
      return '';
    }
  }

  function setToken(token) {
    try {
      localStorage.setItem(TOKEN_KEY, String(token || '').trim());
    } catch (e) {
      // localStorageが使えない環境ではあきらめる
    }
  }

  // Gist URL(https://gist.github.com/user/<id> 等)を貼られても ID を取り出せるようにする
  function parseGistId(input) {
    const m = /([0-9a-f]{20,40})(?![0-9a-f])/i.exec(String(input || ''));
    return m ? m[1].toLowerCase() : '';
  }

  // https://gist.github.com/<id> はユーザー名なしでも所有者のGistページへリダイレクトされる
  function pageUrl(gistId) {
    return gistId ? `https://gist.github.com/${gistId}` : '';
  }

  function describeHttpError(status) {
    if (status === 401) return 'トークンが無効です(失効の可能性)';
    if (status === 403) return 'アクセス拒否またはレート制限です';
    if (status === 404) return 'Gistが見つかりません(IDまたはトークンの権限を確認)';
    return `HTTP ${status}`;
  }

  function authHeaders() {
    const token = getToken();
    if (!token) throw new Error('先にトークンを入力してください');
    return {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    };
  }

  // Gistを取得する。etag指定で変更なし(304)なら null。
  async function get(gistId, etag) {
    const headers = { Accept: 'application/vnd.github+json' };
    if (etag) headers['If-None-Match'] = etag;
    const res = await fetch(`${API}/${gistId}`, { headers, cache: 'no-store' });
    if (res.status === 304) return null;
    if (!res.ok) throw new Error(describeHttpError(res.status));
    return { json: await res.json(), etag: res.headers.get('ETag') || '' };
  }

  // 取得したGistの指定ファイルの本文(無ければ空文字)
  async function fileText(json, name) {
    const file = json.files && json.files[name];
    if (!file) return '';
    if (file.truncated && file.raw_url) return (await fetch(file.raw_url)).text();
    return file.content || '';
  }

  // files: { ファイル名: 本文 }。指定したファイルだけ更新/追加される。
  async function update(gistId, files) {
    const body = { files: {} };
    for (const [name, content] of Object.entries(files)) body.files[name] = { content };
    const res = await fetch(`${API}/${gistId}`, {
      method: 'PATCH',
      headers: authHeaders(),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(describeHttpError(res.status));
  }

  // 新しいシークレットGistを作成してIDを返す
  async function create(description, files) {
    const body = { description, public: false, files: {} };
    for (const [name, content] of Object.entries(files)) body.files[name] = { content };
    const res = await fetch(API, { method: 'POST', headers: authHeaders(), body: JSON.stringify(body) });
    if (!res.ok) throw new Error(describeHttpError(res.status));
    return (await res.json()).id;
  }

  global.Gist = { getToken, setToken, parseGistId, pageUrl, describeHttpError, get, fileText, update, create };
})(window);
