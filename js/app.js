/**
 * feed-tycoon ビューア。data/feed.json(GitHub Actions が生成)を読み、
 * フィルタ(Filters)と既読(Visited)を適用して一覧表示する。
 *
 * 画面は 2 つ。ルーティングは location.hash。
 *   #/              一覧(自動継ぎ足し)
 *   #/entry?url=…   ブックマークページ(はてなブックマークのコメント一覧)
 * 一覧の DOM は、ブックマークページを開いている間も残し、戻ったときにスクロール位置を復元する。
 */
(function () {
  const PAGE_SIZE = 30;
  const REFRESH_AFTER_MS = 5 * 60 * 1000;
  const STARTUP_IMPORT_TIMEOUT_MS = 3000;
  const SYNC_WORKFLOW_URL = 'https://github.com/gosyujin/feed-tycoon/actions/workflows/feed-sync.yml';
  const LIST_SEARCH_PLACEHOLDER = 'タイトル・説明で絞り込み';
  const ENTRY_SEARCH_PLACEHOLDER = 'ユーザー・コメントで絞り込み';
  const KEYS = {
    hideRead: 'feed-tycoon:hideRead',
    lastVisit: 'feed-tycoon:lastVisit',
    commentLayout: 'feed-tycoon:commentLayout',
    importUrl: (kind) => `feed-tycoon:importUrl:${kind}`,
  };

  const state = {
    entries: [],
    meta: null,
    activeSource: '',
    query: '',
    entryQuery: '',
    hideRead: readStorage(KEYS.hideRead) === '1',
    showHidden: false,
    previousVisit: Number(readStorage(KEYS.lastVisit)) || 0,
    loadedAt: 0,
    settingsKind: 'mute',
    editingId: null,
    // 一覧
    items: [],
    renderedCount: 0,
    listDirty: false,
    listScrollY: 0,
    view: 'list',
    // ブックマークページ
    entryUrl: '',
    entryContext: null,
    entryComments: [],
    entryHiddenCount: 0,
    entryOfflineNote: '',
    entryPrevVisit: null,
    commentLayout: readStorage(KEYS.commentLayout) === 'rich' ? 'rich' : 'plain',
  };

  const $ = (id) => document.getElementById(id);
  let scrollObserver = null;
  let offlineCachingInProgress = false;

  function readStorage(key) {
    try {
      return localStorage.getItem(key);
    } catch (e) {
      return null;
    }
  }

  function writeStorage(key, value) {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch (e) {
      // localStorage が使えない環境では保存をあきらめる
    }
  }

  function el(tag, props, ...children) {
    const node = document.createElement(tag);
    Object.entries(props || {}).forEach(([k, v]) => {
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else node.setAttribute(k, v);
    });
    children.flat().forEach((c) => c != null && node.append(c));
    return node;
  }

  function safeHref(url) {
    return /^https?:\/\//i.test(url) ? url : '#';
  }

  function pad(n) {
    return String(n).padStart(2, '0');
  }

  function formatTime(iso) {
    const t = Date.parse(iso);
    if (Number.isNaN(t)) return '';
    const diffMin = Math.floor((Date.now() - t) / 60000);
    if (diffMin < 1) return 'たった今';
    if (diffMin < 60) return `${diffMin}分前`;
    if (diffMin < 60 * 24) return `${Math.floor(diffMin / 60)}時間前`;
    const d = new Date(t);
    return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  }

  // ---------------------------------------------------------------- ルーティング

  function parseRoute() {
    const hash = location.hash.replace(/^#/, '') || '/';
    const [path, queryStr] = hash.split('?');
    return { path, params: new URLSearchParams(queryStr || '') };
  }

  function entryHref(url) {
    return `#/entry?${new URLSearchParams({ url }).toString()}`;
  }

  function showRoute() {
    const { path, params } = parseRoute();
    const toEntry = path === '/entry';
    if (state.view === 'list' && toEntry) state.listScrollY = window.scrollY;

    $('view-list').hidden = toEntry;
    $('view-entry').hidden = !toEntry;
    state.view = toEntry ? 'entry' : 'list';

    const search = $('header-search');
    search.placeholder = toEntry ? ENTRY_SEARCH_PLACEHOLDER : LIST_SEARCH_PLACEHOLDER;
    search.value = toEntry ? state.entryQuery : state.query;

    if (toEntry) {
      renderEntryView(params.get('url') || '');
    } else {
      if (state.listDirty) render();
      window.scrollTo(0, state.listScrollY);
    }
  }

  // ---------------------------------------------------------------- データ取得

  async function loadData() {
    $('list-status').textContent = '読み込み中…';
    try {
      // Pages の CDN は max-age=600 で配信するため、cache: 'no-cache' だけでは CDN 上の古い JSON が返ることがある。
      // URL を毎回変えて CDN のキャッシュを避ける(取得しても数百KB程度)。
      const bust = Date.now();
      const [feedRes, metaRes] = await Promise.all([
        fetch(`data/feed.json?t=${bust}`, { cache: 'no-cache' }),
        fetch(`data/meta.json?t=${bust}`, { cache: 'no-cache' }),
      ]);
      if (!feedRes.ok) throw new Error(`feed.json: HTTP ${feedRes.status}`);
      state.entries = await feedRes.json();
      state.meta = metaRes.ok ? await metaRes.json() : null;
      state.loadedAt = Date.now();
    } catch (e) {
      $('list-status').textContent = `読み込みに失敗しました(${e.message})`;
      return;
    }
    render();
    renderFooter();
    // ブックマークページを直接開いた場合、一覧データが揃ってから概要(RSS の description)を出す。
    if (state.view === 'entry') applyEntryContext();
  }

  // ---------------------------------------------------------------- 一覧

  function matchesQuery(entry) {
    if (!state.query) return true;
    const q = state.query.toLowerCase();
    return (entry.title || '').toLowerCase().includes(q) || (entry.description || '').toLowerCase().includes(q);
  }

  function computeView() {
    const visible = [];
    const filtered = [];
    let readHidden = 0;
    const sourceCounts = new Map();

    for (const entry of state.entries) {
      const verdict = Filters.judge(entry);
      if (!verdict.hidden) {
        sourceCounts.set(entry.sourceId, (sourceCounts.get(entry.sourceId) || 0) + 1);
      }
      if (state.activeSource && entry.sourceId !== state.activeSource) continue;
      if (!matchesQuery(entry)) continue;
      if (verdict.hidden) {
        filtered.push({ entry, verdict });
      } else if (state.hideRead && Visited.isRead(entry.url)) {
        readHidden++;
      } else {
        visible.push({ entry });
      }
    }
    return { visible, filtered, readHidden, sourceCounts };
  }

  function renderSourceTabs(sourceCounts) {
    const nav = $('source-tabs');
    nav.replaceChildren();
    const total = [...sourceCounts.values()].reduce((a, b) => a + b, 0);
    const tab = (id, label, count) =>
      el(
        'button',
        {
          type: 'button',
          class: 'tab' + (state.activeSource === id ? ' tab--active' : ''),
          onclick: () => {
            state.activeSource = id;
            resetAndRender();
          },
        },
        `${label} (${count})`
      );
    nav.append(tab('', 'すべて', total));
    const seen = new Map();
    state.entries.forEach((e) => seen.set(e.sourceId, e.source));
    seen.forEach((name, id) => nav.append(tab(id, name, sourceCounts.get(id) || 0)));
  }

  function renderCard(item) {
    const { entry, verdict } = item;
    const isNew = state.previousVisit > 0 && Date.parse(entry.firstSeenAt) > state.previousVisit;
    const read = Visited.isRead(entry.url);
    const link = el('a', {
      class: 'entry-title',
      href: safeHref(entry.url),
      target: '_blank',
      rel: 'noopener noreferrer',
      text: entry.title,
    });
    const markRead = () => {
      Visited.markRead(entry.url);
      card.classList.add('entry--read');
    };
    link.addEventListener('click', markRead);
    link.addEventListener('auxclick', markRead);

    const presetButton = (text, type, value, hint) =>
      el('button', { type: 'button', class: 'meta-link', title: hint, onclick: () => openSettings('mute', type, value) }, text);

    const meta = el(
      'div',
      { class: 'entry-meta' },
      isNew ? el('span', { class: 'badge-new', text: 'NEW' }) : null,
      presetButton(entry.source, 'source', entry.source, 'この取得元のミュートを設定'),
      ' · ',
      presetButton(entry.domain, 'domain', entry.domain, 'このドメインのミュートを設定'),
      ' · ',
      el('span', { text: formatTime(entry.publishedAt || entry.firstSeenAt) }),
      // 自前のブックマークページへの内部リンク。b.hatena.ne.jp を href に持つ <a> は、
      // iPhone Safari のコンテンツブロッカーに隠される(README 参照)ので、外部リンクにはしない。
      entry.bookmarkUrl
        ? el('a', { class: 'bm-count', href: entryHref(entry.url), text: `${entry.bookmarkCount || 0} users →` })
        : null,
      (entry.tags || []).map((t) => el('span', { class: 'tag', text: t }))
    );

    const card = el(
      'article',
      { class: 'entry' + (read ? ' entry--read' : '') + (verdict ? ' entry--hidden' : '') },
      link,
      meta,
      entry.description ? el('p', { class: 'entry-desc', text: entry.description }) : null,
      verdict
        ? el('p', { class: 'entry-reason', text: `${Filters.KIND_LABELS[verdict.kind]}: ${Filters.TYPE_LABELS[verdict.rule.type]}「${verdict.rule.value}」に一致` })
        : el('button', {
            type: 'button',
            class: 'btn btn--x',
            title: 'この記事をミュート',
            'aria-label': 'この記事をミュート',
            onclick: () => {
              Filters.addRule('mute', 'url', entry.url);
              render();
            },
            text: '×',
          })
    );
    return card;
  }

  // ---- 自動継ぎ足し ----

  function disconnectScrollObserver() {
    if (scrollObserver) {
      scrollObserver.disconnect();
      scrollObserver = null;
    }
  }

  function renderNextPage() {
    const list = $('entry-list');
    const sentinel = $('scroll-sentinel');
    const next = state.items.slice(state.renderedCount, state.renderedCount + PAGE_SIZE);
    next.forEach((item) => list.insertBefore(renderCard(item), sentinel));
    state.renderedCount += next.length;
    if (state.renderedCount >= state.items.length) {
      disconnectScrollObserver();
      if (sentinel) sentinel.remove();
    }
  }

  function setupScrollObserver() {
    disconnectScrollObserver();
    if (state.renderedCount >= state.items.length) return;
    const sentinel = el('div', { id: 'scroll-sentinel' });
    $('entry-list').append(sentinel);
    scrollObserver = new IntersectionObserver(
      (records) => {
        if (!records.some((r) => r.isIntersecting)) return;
        renderNextPage();
        // IntersectionObserver は「交差状態が変わった時」しか発火しない。追加した分だけでは
        // sentinel が rootMargin 内に残る(画面が縦に長い等)と二度と発火せず継ぎ足しが止まるため、
        // 監視し直して現在の状態で再判定させる。この再監視を外さないこと。
        const current = $('scroll-sentinel');
        if (current && scrollObserver) {
          scrollObserver.unobserve(current);
          scrollObserver.observe(current);
        }
      },
      { rootMargin: '600px' }
    );
    scrollObserver.observe(sentinel);
  }

  // 描画済みの件数までは作り直す(継ぎ足し済みの位置を保つため)。最低でも 1 ページ分。
  function render() {
    state.listDirty = false;
    const { visible, filtered, readHidden, sourceCounts } = computeView();
    renderSourceTabs(sourceCounts);

    const keep = Math.max(state.renderedCount, PAGE_SIZE);
    state.items = state.showHidden ? filtered : visible;
    state.renderedCount = 0;
    const list = $('entry-list');
    list.replaceChildren();
    if (state.items.length === 0) {
      list.append(el('p', { class: 'empty', text: state.showHidden ? 'フィルタで隠れた記事はありません' : '表示する記事がありません' }));
    } else {
      setupScrollObserver();
      while (state.renderedCount < Math.min(keep, state.items.length)) renderNextPage();
    }

    const parts = [];
    if (filtered.length) parts.push(`フィルタ${filtered.length}件`);
    if (readHidden) parts.push(`既読${readHidden}件`);
    $('list-status').textContent = state.showHidden
      ? `フィルタで隠れた ${filtered.length} 件を表示中`
      : `${visible.length} 件を表示中` + (parts.length ? `(${parts.join('・')}を非表示)` : '');

    const btn = $('show-hidden-btn');
    btn.hidden = filtered.length === 0 && !state.showHidden;
    btn.textContent = state.showHidden ? '通常表示に戻る' : '隠した記事を見る';
  }

  // 一覧の絞り込み・切り替えが変わったときは、先頭から継ぎ足し直す。
  function resetAndRender() {
    state.renderedCount = 0;
    window.scrollTo(0, 0);
    render();
  }

  // ---------------------------------------------------------------- フッター

  // 「ビルド(日時) / 次回更新: HH:MM頃」。次回更新は、更新ワークフローのページへのリンクにする。
  function renderFooter() {
    const b = window.BUILD_INFO;
    const parts = [];
    if (b) parts.push(el('span', { text: `${b.sha} (${b.time})` }));
    const meta = state.meta;
    if (meta && meta.nextEstimate) {
      parts.push(el('a', { href: SYNC_WORKFLOW_URL, target: '_blank', rel: 'noopener noreferrer', text: `次回更新: ${meta.nextEstimate}頃` }));
    }
    const failed = Object.values((meta && meta.sources) || {}).filter((s) => s.ok === false).map((s) => s.name);
    if (failed.length) parts.push(el('span', { class: 'footer-warn', text: `取得失敗: ${failed.join(', ')}` }));

    const node = $('next-update-info');
    node.replaceChildren();
    parts.forEach((p, i) => {
      if (i > 0) node.append(' / ');
      node.append(p);
    });
  }

  // ---------------------------------------------------------------- ブックマークページ

  // jsonlite の timestamp("yyyy/MM/dd HH:mm"、JST)を ms に変換する。解釈できなければ null。
  function parseBookmarkTimestamp(ts) {
    const m = /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(ts || '');
    if (!m) return null;
    const t = Date.parse(`${m[1]}-${pad(m[2])}-${pad(m[3])}T${pad(m[4])}:${m[5]}:${m[6] || '00'}+09:00`);
    return Number.isNaN(t) ? null : t;
  }

  // 前回訪問より後に付いたコメントか。timestamp は分単位で秒が落ちているため、
  // 同じ分に付いたものを取りこぼさないよう 1 分の猶予を持たせて新着側に倒す。
  function isNewComment(b) {
    if (state.entryPrevVisit == null) return false;
    const t = parseBookmarkTimestamp(b.timestamp);
    return t != null && t + 60000 > state.entryPrevVisit;
  }

  // 前回訪問時点で既に付いていたコメント(=既読)。初訪問や時刻が解釈できないものは対象外。
  function isReadComment(b) {
    return state.entryPrevVisit != null && parseBookmarkTimestamp(b.timestamp) != null && !isNewComment(b);
  }

  function renderComment(b) {
    const date = (b.timestamp || '').split(' ')[0];
    const isNew = isNewComment(b);
    const badge = isNew ? el('span', { class: 'comment-badge-new', title: '前回このページを開いた後に付いたコメントです', text: 'NEW' }) : null;
    const user = el('button', { type: 'button', class: 'comment-user', 'data-user': b.user, text: b.user });
    const read = isReadComment(b) ? ' comment--read' : '';

    if (state.commentLayout !== 'rich') {
      return el('li', { class: read.trim() }, badge, badge ? ' ' : null, user, ' ', el('span', { class: 'comment-date', text: date }), ' ', b.comment);
    }
    // アイコン URL は API レスポンスに無いため、はてなの公開アイコン配信の命名規則から組み立てる。
    const icon = el('img', {
      class: 'comment-icon',
      src: `https://cdn.profile-image.st-hatena.com/users/${encodeURIComponent(b.user)}/profile.png`,
      alt: '',
      loading: 'lazy',
      width: '32',
      height: '32',
    });
    const tags = (b.tags || []).map((t) => el('span', { class: 'comment-tag', text: t }));
    return el(
      'li',
      { class: 'comment--rich' + read },
      icon,
      el(
        'div',
        { class: 'comment-rich-body' },
        el('div', { class: 'comment-rich-line1' }, badge, badge ? ' ' : null, user, ' ', b.comment),
        el('div', { class: 'comment-rich-line2' }, el('span', { class: 'comment-date', text: date }), tags.length ? el('span', { class: 'comment-tags' }, tags) : null)
      )
    );
  }

  // 検索欄の入力のたびに再取得はせず、フィルタ適用後のコメントから絞り込んで描画し直す。
  function renderComments() {
    const q = state.entryQuery.toLowerCase();
    const shown = q
      ? state.entryComments.filter((b) => (b.user || '').toLowerCase().includes(q) || (b.comment || '').toLowerCase().includes(q))
      : state.entryComments;

    const newCount = shown.filter(isNewComment).length;
    const notes = [];
    if (state.entryHiddenCount > 0) notes.push(`フィルタ${state.entryHiddenCount}件を非表示`);
    if (newCount > 0) notes.push(`前回訪問後の新着${newCount}件`);
    $('bm-status').textContent =
      state.entryOfflineNote + `${shown.length} 件のコメントを表示中` + (notes.length ? `(${notes.join('・')})` : '');

    const list = $('comment-list');
    list.className = state.commentLayout === 'rich' ? 'comment-list comment-list--rich' : 'comment-list';
    list.replaceChildren(...shown.map(renderComment));
    if (shown.length === 0) list.replaceChildren(el('p', { class: 'empty', text: 'コメントはありません。' }));
  }

  function updateLayoutToggleUI() {
    $('comment-layout-toggle').querySelectorAll('button[data-layout]').forEach((btn) => {
      btn.classList.toggle('tab--active', btn.dataset.layout === state.commentLayout);
    });
  }

  // 一覧データ(feed.json)にある記事なら、RSS の description などを流用する。
  function applyEntryContext() {
    const feedEntry = state.entries.find((e) => e.url === state.entryUrl) || null;
    state.entryContext = feedEntry;
    $('bm-description').textContent = feedEntry && feedEntry.description ? feedEntry.description : '';
  }

  // 直前のスクロール位置が残るため、表示のたびに先頭へ戻す。
  // モバイルでは慣性スクロールがまだ収束していないと 1 回では効かないので、数フレームにわたって戻す。
  function forceScrollTop() {
    window.scrollTo(0, 0);
    requestAnimationFrame(() => {
      window.scrollTo(0, 0);
      requestAnimationFrame(() => window.scrollTo(0, 0));
    });
  }

  function resetFilterButton() {
    const btn = $('entry-filter-btn');
    btn.textContent = 'このページをフィルタに登録する';
    btn.disabled = false;
  }

  async function renderEntryView(url) {
    forceScrollTop();
    state.entryUrl = url;
    state.entryComments = [];
    state.entryHiddenCount = 0;
    state.entryOfflineNote = '';
    state.entryPrevVisit = null;
    $('bm-header').replaceChildren();
    $('comment-list').replaceChildren();
    updateLayoutToggleUI();
    resetFilterButton();
    applyEntryContext();
    if (!url) {
      $('bm-status').textContent = 'URLが指定されていません。';
      return;
    }
    $('bm-status').textContent = '読み込み中…';
    try {
      const info = await HatenaAPI.getEntryInfo(url);
      if (state.entryUrl !== url) return; // 取得中に別の記事へ移動した

      const base = { ...(state.entryContext || {}), title: info.title, domain: info.domain, url: info.url };
      if (Filters.isHidden(base)) {
        $('bm-description').textContent = '';
        $('bm-status').textContent = 'このエントリーはフィルタ条件により非表示になっています。';
        return;
      }

      const commented = info.bookmarks.filter((b) => b.comment);
      // markBookmarkVisit が訪問時刻を上書きする前に、前回の訪問時刻を控えておく。
      state.entryPrevVisit = Visited.getLastBookmarkVisit(url);
      Visited.markBookmarkVisit(url);

      $('bm-header').replaceChildren(
        el('a', { class: 'bm-title', href: safeHref(info.url), target: '_blank', rel: 'noopener noreferrer', text: info.title }),
        el(
          'div',
          { class: 'bm-meta' },
          el('span', { text: info.domain }),
          el('span', { text: `${info.count} users` }),
          // b.hatena.ne.jp を href に持つ <a> は iPhone Safari で隠されるため、ボタンで開く。
          info.entryUrl
            ? el('button', {
                type: 'button',
                class: 'meta-link',
                onclick: () => window.open(safeHref(info.entryUrl), '_blank', 'noopener,noreferrer'),
                text: 'はてなブックマークページ →',
              })
            : null
        )
      );

      // コメント側は、記事自体の判定(URL 完全一致を含む)とは別に、title/domain/user/comment で評価する。
      // URL を含めると、記事をミュートしていないのに URL ルールが全コメントに当たってしまう。
      const visible = commented.filter((b) => !Filters.isHidden({ title: info.title, domain: info.domain, user: b.user, comment: b.comment }));
      state.entryComments = visible;
      state.entryHiddenCount = commented.length - visible.length;
      state.entryOfflineNote = info.fromOfflineCache ? '(オフラインのため前回取得時点の内容を表示中) ' : '';
      renderComments();
      forceScrollTop();
    } catch (err) {
      console.error(err);
      $('bm-status').textContent = `取得に失敗しました: ${err.message}`;
    }
  }

  // ---------------------------------------------------------------- 設定モーダル

  function openSettings(kind, type, value) {
    if (kind) state.settingsKind = kind;
    state.editingId = null;
    $('settings-modal').hidden = false;
    renderSettings();
    // 直前のプリセットが残らないよう、歯車から開き直したときは既定(先頭の種別・空)に戻す。
    $('rule-type').value = type || Filters.TYPES[0];
    $('rule-value').value = value !== undefined ? value : '';
    if (type) $('rule-value').focus();
  }

  function closeSettings() {
    $('settings-modal').hidden = true;
  }

  function setImportStatus(message) {
    $('import-status').textContent = message;
  }

  function renderSettings() {
    const kind = state.settingsKind;
    const tabs = $('settings-tabs');
    tabs.replaceChildren(
      ...Filters.KINDS.map((k) =>
        el(
          'button',
          {
            type: 'button',
            class: 'tab' + (k === kind ? ' tab--active' : ''),
            onclick: () => {
              state.settingsKind = k;
              state.editingId = null;
              setImportStatus('');
              renderSettings();
            },
          },
          `${Filters.KIND_LABELS[k]} (${Filters.loadRules(k).length})`
        )
      )
    );

    const typeSelect = $('rule-type');
    if (!typeSelect.options.length) {
      Filters.TYPES.forEach((t) => typeSelect.append(el('option', { value: t, text: Filters.TYPE_LABELS[t] })));
      $('type-list').textContent = Filters.TYPES.join(' / ');
    }

    const rules = Filters.loadRules(kind);
    $('rule-count').textContent = rules.length;
    $('rule-list').replaceChildren(...rules.map(renderRuleRow));
    $('import-url-input').value = readStorage(KEYS.importUrl(kind)) || '';
    $('export-text').hidden = true;
  }

  function renderRuleRow(rule) {
    const kind = state.settingsKind;
    if (state.editingId === rule.id) {
      const select = el('select', {}, Filters.TYPES.map((t) => el('option', { value: t, text: Filters.TYPE_LABELS[t] })));
      select.value = rule.type;
      const input = el('input', { type: 'text', value: rule.value, autocomplete: 'off' });
      return el(
        'li',
        { class: 'rule-row' },
        select,
        input,
        el(
          'button',
          {
            type: 'button',
            class: 'btn btn--small',
            onclick: () => {
              if (!Filters.updateRule(kind, rule.id, select.value, input.value)) {
                setImportStatus('保存できません(値が空、または同じルールが既にあります)');
                return;
              }
              setImportStatus('');
              state.editingId = null;
              renderSettings();
              onRulesChanged();
            },
          },
          '保存'
        ),
        el('button', { type: 'button', class: 'btn btn--small', onclick: () => { state.editingId = null; renderSettings(); } }, 'キャンセル')
      );
    }
    return el(
      'li',
      { class: 'rule-row' },
      el('span', { class: 'rule-type', text: Filters.TYPE_LABELS[rule.type] }),
      el('span', { class: 'rule-value', text: rule.value }),
      el('button', { type: 'button', class: 'btn btn--small', onclick: () => { state.editingId = rule.id; renderSettings(); } }, '編集'),
      el(
        'button',
        {
          type: 'button',
          class: 'btn btn--small',
          onclick: () => {
            Filters.removeRule(kind, rule.id);
            renderSettings();
            onRulesChanged();
          },
        },
        '削除'
      )
    );
  }

  // ルールが変わったら、表示中の画面に反映する(表示していない側は戻ったときに作り直す)。
  function onRulesChanged() {
    if (state.view === 'entry') {
      state.listDirty = true;
      renderEntryView(state.entryUrl);
    } else {
      render();
    }
  }

  function applyImport(rules) {
    const added = Filters.importRules(state.settingsKind, rules);
    setImportStatus(`${added}件を追加しました(重複${rules.length - added}件はスキップ)`);
    renderSettings();
    onRulesChanged();
  }

  // ---- オフライン用キャッシュ ----

  async function runOfflineCache() {
    const input = $('offline-cache-count');
    const requested = Math.floor(Number(input.value));
    const count = Number.isFinite(requested) ? Math.min(Math.max(requested, 1), 200) : 50;
    input.value = count;
    const setStatus = (text) => {
      $('offline-cache-status').textContent = text;
    };

    offlineCachingInProgress = true;
    $('offline-cache-btn').disabled = true;
    const targets = state.entries.filter((e) => !Filters.isHidden(e)).slice(0, count);

    let success = 0;
    let failed = 0;
    for (let i = 0; i < targets.length; i++) {
      setStatus(`${i + 1}/${targets.length}件処理中(成功${success}・失敗${failed})…`);
      try {
        await HatenaAPI.getEntryInfo(targets[i].url);
        success++;
      } catch (err) {
        failed++;
      }
    }
    setStatus(
      targets.length === 0
        ? '対象の記事がありません'
        : failed > 0
          ? `${targets.length}件中${success}件をキャッシュしました(失敗${failed}件)`
          : `${success}件をキャッシュしました`
    );
    $('offline-cache-btn').disabled = false;
    offlineCachingInProgress = false;
  }

  function bindSettings() {
    $('settings-btn').addEventListener('click', () => openSettings());
    $('settings-close').addEventListener('click', closeSettings);
    $('settings-modal').addEventListener('click', (e) => {
      if (e.target === $('settings-modal')) closeSettings();
    });
    $('offline-cache-btn').addEventListener('click', () => {
      if (!offlineCachingInProgress) runOfflineCache();
    });

    $('settings-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const added = Filters.addRule(state.settingsKind, $('rule-type').value, $('rule-value').value);
      setImportStatus(added ? '' : '追加できません(値が空、または同じルールが既にあります)');
      if (added) $('rule-value').value = '';
      renderSettings();
      onRulesChanged();
    });

    $('export-btn').addEventListener('click', () => {
      const csv = RulesIO.rulesToCsv(Filters.loadRules(state.settingsKind));
      const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
      const a = el('a', { href: url, download: `feed-tycoon-${state.settingsKind}.csv` });
      a.click();
      URL.revokeObjectURL(url);
    });
    $('copy-btn').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(RulesIO.rulesToCsv(Filters.loadRules(state.settingsKind)));
        setImportStatus('クリップボードにコピーしました');
      } catch (e) {
        setImportStatus('コピーに失敗しました。「テキストで表示」を使ってください');
      }
    });
    $('export-text-btn').addEventListener('click', () => {
      const box = $('export-text');
      box.value = RulesIO.rulesToCsv(Filters.loadRules(state.settingsKind));
      box.hidden = false;
      box.select();
    });

    $('import-file-input').addEventListener('change', async (e) => {
      const file = e.target.files[0];
      e.target.value = '';
      if (!file) return;
      const result = RulesIO.parseRulesCsv(await file.text());
      if (result.error) setImportStatus(result.error);
      else applyImport(result.rules);
    });

    $('import-url-form').addEventListener('submit', async (e) => {
      e.preventDefault();
      const url = $('import-url-input').value.trim();
      const key = KEYS.importUrl(state.settingsKind);
      if (!url) {
        writeStorage(key, null);
        setImportStatus('自動インポートのURLを解除しました');
        return;
      }
      setImportStatus('取得中…');
      try {
        const result = RulesIO.parseRulesCsv(await RulesIO.fetchText(url));
        if (result.error) {
          setImportStatus(result.error);
          return;
        }
        writeStorage(key, url);
        applyImport(result.rules);
      } catch (err) {
        setImportStatus(`取得に失敗しました(${err.message})`);
      }
    });
  }

  // 起動時に、登録済みの Gist から各リストを取り込む(最初の描画を待たせるのは最大3秒。失敗しても通常起動)。
  async function importOnStartup() {
    const tasks = Filters.KINDS.map(async (kind) => {
      const url = readStorage(KEYS.importUrl(kind));
      if (!url) return;
      const result = RulesIO.parseRulesCsv(await RulesIO.fetchText(url, STARTUP_IMPORT_TIMEOUT_MS));
      if (result.rules) Filters.importRules(kind, result.rules);
    });
    const timeout = new Promise((resolve) => setTimeout(resolve, STARTUP_IMPORT_TIMEOUT_MS));
    await Promise.race([Promise.allSettled(tasks), timeout]);
  }

  // ---------------------------------------------------------------- 初期化

  function bindViews() {
    $('header-search').addEventListener('input', (e) => {
      const value = e.target.value.trim();
      if (state.view === 'entry') {
        state.entryQuery = value;
        renderComments();
      } else {
        state.query = value;
        resetAndRender();
      }
    });
    $('hide-read-checkbox').checked = state.hideRead;
    $('hide-read-checkbox').addEventListener('change', (e) => {
      state.hideRead = e.target.checked;
      writeStorage(KEYS.hideRead, state.hideRead ? '1' : '0');
      resetAndRender();
    });
    $('show-hidden-btn').addEventListener('click', () => {
      state.showHidden = !state.showHidden;
      resetAndRender();
    });

    const goToList = () => {
      location.hash = '#/';
    };
    $('entry-back').addEventListener('click', goToList);
    $('entry-back-bottom').addEventListener('click', goToList);
    $('entry-filter-btn').addEventListener('click', () => {
      if (!state.entryUrl) return;
      Filters.addRule('mute', 'url', state.entryUrl);
      state.listDirty = true;
      $('entry-filter-btn').textContent = 'フィルタに登録しました';
      $('entry-filter-btn').disabled = true;
    });

    $('comment-layout-toggle').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-layout]');
      if (!btn || btn.dataset.layout === state.commentLayout) return;
      state.commentLayout = btn.dataset.layout;
      writeStorage(KEYS.commentLayout, state.commentLayout);
      updateLayoutToggleUI();
      renderComments();
    });
    // コメントのユーザー名をクリックすると、そのユーザーのミュート設定を開く。
    $('comment-list').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-user]');
      if (btn) openSettings('mute', 'user', btn.dataset.user);
    });

    window.addEventListener('hashchange', showRoute);
    // ページが前面に戻ったとき、しばらく経っていれば最新を読み直す(push の代わり)。
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && Date.now() - state.loadedAt > REFRESH_AFTER_MS) loadData();
    });
  }

  function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    const register = () =>
      navigator.serviceWorker.register('service-worker.js').catch((err) => {
        console.warn('[sw] register failed', err);
      });
    if (document.readyState === 'complete') register();
    else window.addEventListener('load', register);
  }

  async function init() {
    bindSettings();
    bindViews();
    updateLayoutToggleUI();
    showRoute();
    await importOnStartup();
    await loadData();
    writeStorage(KEYS.lastVisit, String(Date.now()));
    registerServiceWorker();
  }

  init();
})();
