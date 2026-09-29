#!/usr/bin/env python3
"""
sources.json に書かれたフィード(RSS 2.0 / RSS 1.0(RDF) / Atom)を取得し、
data/feed.json (記事一覧)、data/feed.xml (無フィルタの Atom)、data/meta.json (取得状況) に書き出す。
GitHub Actions (.github/workflows/feed-sync.yml) から定期実行される。

ブラウザから他サイトのフィードを直接取得すると CORS で失敗するため、CI 側で取得して
同一オリジンの静的 JSON としてコミットし、ブラウザ側はそれを読むだけにする(hateb-tycoon と同じ方式)。

フィードは直近の数十件しか返さないため、取得結果は「上書き」ではなく「蓄積」する。
記事ごとに firstSeenAt(初出) / lastSeenAt(最終確認) を記録し、firstSeenAt の新しい順に並べ、
保持期間・ソースごとの件数上限でプルーニングする。

Python 標準ライブラリのみで動作する(Python 3.9 以上)。
"""
import html
import json
import re
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path

JST = timezone(timedelta(hours=9))

USER_AGENT = "feed-tycoon-bot/1.0 (+https://github.com/gosyujin/feed-tycoon)"
ROOT_DIR = Path(__file__).resolve().parent.parent
SOURCES_PATH = ROOT_DIR / "sources.json"
DATA_DIR = ROOT_DIR / "data"

RETENTION_DAYS = 14
MAX_ENTRIES_PER_SOURCE = 100
DESCRIPTION_MAX_CHARS = 200
ATOM_MAX_ENTRIES = 100
REQUEST_TIMEOUT_SEC = 15
REQUEST_INTERVAL_SEC = 1
NEXT_UPDATE_MINUTES = 30

ATOM_NS = "http://www.w3.org/2005/Atom"

HATENA_COUNT_API = "https://bookmark.hatenaapis.com/count/entries"
HATENA_COUNT_BATCH = 50  # APIが1リクエストで受け付けるURL数の上限


def local_name(tag):
    return tag.rsplit("}", 1)[-1] if isinstance(tag, str) else ""


def child_text(el, *names):
    """直下の子要素のうち、名前空間を無視して names のいずれかに一致する最初の非空テキストを返す。"""
    for name in names:
        for child in el:
            if local_name(child.tag) == name and child.text and child.text.strip():
                return child.text.strip()
    return ""


def clean_text(raw, max_chars=None):
    text = re.sub(r"<[^>]+>", " ", raw or "")
    text = re.sub(r"\s+", " ", html.unescape(text)).strip()
    if max_chars and len(text) > max_chars:
        text = text[:max_chars].rstrip() + "…"
    return text


def parse_date(raw):
    """RFC 822 / ISO 8601 の日時文字列を JST の ISO 8601 文字列にする。解釈できなければ None。"""
    if not raw:
        return None
    raw = raw.strip()
    dt = None
    try:
        dt = parsedate_to_datetime(raw)
    except (TypeError, ValueError, IndexError):
        pass
    if dt is None:
        try:
            dt = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        except ValueError:
            return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(JST).isoformat()


def safe_hostname(url):
    try:
        return urllib.parse.urlparse(url).netloc
    except ValueError:
        return ""


def entry_link(item):
    for child in item:
        if local_name(child.tag) != "link":
            continue
        if child.text and child.text.strip():
            return child.text.strip()
        href = child.attrib.get("href")
        if href and child.attrib.get("rel") in (None, "alternate"):
            return href.strip()
    return ""


def parse_feed(xml_bytes):
    """RSS 2.0 / RSS 1.0(RDF) / Atom のいずれかをパースし、共通形式のリストを返す。"""
    root = ET.fromstring(xml_bytes)
    entries = []
    for item in root.iter():
        if local_name(item.tag) not in ("item", "entry"):
            continue
        url = entry_link(item)
        if not url:
            continue
        description = child_text(item, "description", "summary") or child_text(item, "content", "encoded")
        entries.append(
            {
                "title": clean_text(child_text(item, "title")) or "(タイトル不明)",
                "url": url,
                "domain": safe_hostname(url),
                "description": clean_text(description, DESCRIPTION_MAX_CHARS) or None,
                "publishedAt": parse_date(child_text(item, "pubDate", "date", "published", "updated")),
            }
        )
    return entries


def fetch(url, etag=None, last_modified=None):
    """(status, body, etag, last_modified)。304 の場合 body は None。"""
    headers = {"User-Agent": USER_AGENT, "Accept": "application/atom+xml, application/rss+xml, application/xml, text/xml, */*"}
    if etag:
        headers["If-None-Match"] = etag
    if last_modified:
        headers["If-Modified-Since"] = last_modified
    req = urllib.request.Request(url, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT_SEC) as res:
            return res.status, res.read(), res.headers.get("ETag"), res.headers.get("Last-Modified")
    except urllib.error.HTTPError as e:
        if e.code == 304:
            return 304, None, etag, last_modified
        raise


def hatena_entry_url(url):
    """記事URLに対応する、はてなブックマークのエントリーページURL。"""
    scheme, sep, rest = url.partition("://")
    if not sep or scheme not in ("http", "https"):
        return None
    prefix = "https://b.hatena.ne.jp/entry/" + ("s/" if scheme == "https" else "")
    return prefix + rest.replace("#", "%23")


def fetch_bookmark_counts(urls):
    """{記事URL: ブックマーク数}。失敗したバッチ分は含めない(呼び出し側が前回値を維持する)。"""
    counts = {}
    for i in range(0, len(urls), HATENA_COUNT_BATCH):
        if i > 0:
            time.sleep(REQUEST_INTERVAL_SEC)
        batch = urls[i : i + HATENA_COUNT_BATCH]
        query = urllib.parse.urlencode([("url", u) for u in batch])
        req = urllib.request.Request(f"{HATENA_COUNT_API}?{query}", headers={"User-Agent": USER_AGENT})
        try:
            with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT_SEC) as res:
                counts.update(json.loads(res.read()))
        except (urllib.error.URLError, OSError, json.JSONDecodeError) as e:
            print(f"[warn] ブックマーク数の取得に失敗、前回値を維持します ({e})", file=sys.stderr)
    return counts


def apply_bookmark_info(entries, counts):
    for e in entries:
        e["bookmarkUrl"] = hatena_entry_url(e["url"])
        if e["url"] in counts:
            e["bookmarkCount"] = counts[e["url"]]
        else:
            e.setdefault("bookmarkCount", 0)


def load_json(path, default):
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return default


def write_json(path, data):
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def merge_entries(existing_by_url, fresh_entries, source, now_dt):
    """新規取得分を既存の蓄積にマージする。既存記事は firstSeenAt を保持し、新規はホールド期間外なら捨てる。"""
    now_iso = now_dt.isoformat()
    cutoff = now_dt - timedelta(days=RETENTION_DAYS)
    for fresh in fresh_entries:
        url = fresh["url"]
        prev = existing_by_url.get(url)
        if prev is None:
            published = fresh.get("publishedAt")
            if published and datetime.fromisoformat(published) < cutoff:
                continue
            first_seen = now_iso
        else:
            first_seen = prev.get("firstSeenAt", now_iso)
        existing_by_url[url] = {
            **fresh,
            "source": source["name"],
            "sourceId": source["id"],
            "tags": list(source.get("tags", [])),
            "firstSeenAt": first_seen,
            "lastSeenAt": now_iso,
        }
    return existing_by_url


def sort_key(entry):
    return (entry.get("firstSeenAt", ""), entry.get("publishedAt") or "")


def prune(existing_by_url, active_source_ids, now_dt):
    cutoff = now_dt - timedelta(days=RETENTION_DAYS)
    per_source = {}
    for entry in existing_by_url.values():
        if entry.get("sourceId") not in active_source_ids:
            continue
        try:
            first_seen = datetime.fromisoformat(entry["firstSeenAt"])
        except (KeyError, ValueError):
            first_seen = now_dt
        if first_seen < cutoff:
            continue
        per_source.setdefault(entry["sourceId"], []).append(entry)
    kept = []
    for entries in per_source.values():
        entries.sort(key=sort_key, reverse=True)
        kept.extend(entries[:MAX_ENTRIES_PER_SOURCE])
    kept.sort(key=sort_key, reverse=True)
    return kept


def build_atom(entries, now_iso):
    ET.register_namespace("", ATOM_NS)
    feed = ET.Element(f"{{{ATOM_NS}}}feed")
    ET.SubElement(feed, f"{{{ATOM_NS}}}title").text = "feed-tycoon"
    ET.SubElement(feed, f"{{{ATOM_NS}}}id").text = "urn:feed-tycoon"
    ET.SubElement(feed, f"{{{ATOM_NS}}}updated").text = now_iso
    author = ET.SubElement(feed, f"{{{ATOM_NS}}}author")
    ET.SubElement(author, f"{{{ATOM_NS}}}name").text = "feed-tycoon"
    for e in entries[:ATOM_MAX_ENTRIES]:
        node = ET.SubElement(feed, f"{{{ATOM_NS}}}entry")
        ET.SubElement(node, f"{{{ATOM_NS}}}title").text = e["title"]
        ET.SubElement(node, f"{{{ATOM_NS}}}id").text = e["url"]
        ET.SubElement(node, f"{{{ATOM_NS}}}link", href=e["url"])
        ET.SubElement(node, f"{{{ATOM_NS}}}updated").text = e.get("publishedAt") or e["firstSeenAt"]
        ET.SubElement(node, f"{{{ATOM_NS}}}category", term=e["source"])
        if e.get("description"):
            ET.SubElement(node, f"{{{ATOM_NS}}}summary").text = e["description"]
    ET.indent(feed)
    return ET.tostring(feed, encoding="unicode", xml_declaration=False)


def main():
    sources = load_json(SOURCES_PATH, {}).get("sources", [])
    if not sources:
        print(f"[error] {SOURCES_PATH} に sources がありません", file=sys.stderr)
        sys.exit(1)

    DATA_DIR.mkdir(parents=True, exist_ok=True)
    feed_path = DATA_DIR / "feed.json"
    meta_path = DATA_DIR / "meta.json"
    now_dt = datetime.now(timezone.utc).astimezone(JST)
    now_iso = now_dt.isoformat()

    existing_by_url = {e["url"]: e for e in load_json(feed_path, []) if e.get("url")}
    prev_meta_sources = load_json(meta_path, {}).get("sources", {})
    meta_sources = {}
    failures = 0

    for i, source in enumerate(sources):
        if i > 0:
            time.sleep(REQUEST_INTERVAL_SEC)
        sid = source["id"]
        prev = prev_meta_sources.get(sid, {})
        status = {"name": source["name"], "fetchedAt": now_iso}
        try:
            code, body, etag, last_modified = fetch(source["url"], prev.get("etag"), prev.get("lastModified"))
            status.update({"etag": etag, "lastModified": last_modified})
            if code == 304:
                status.update({"ok": True, "notModified": True, "count": prev.get("count", 0)})
                print(f"[ok] {sid}: 304 Not Modified")
            else:
                fresh = parse_feed(body)
                status.update({"ok": True, "count": len(fresh)})
                if not fresh:
                    print(f"[warn] {sid}: 0件取得(サイト構造・フィード形式が変わった可能性)", file=sys.stderr)
                before = len(existing_by_url)
                merge_entries(existing_by_url, fresh, source, now_dt)
                print(f"[ok] {sid}: {len(fresh)}件取得(新規+{max(len(existing_by_url) - before, 0)})")
        except (urllib.error.URLError, ET.ParseError, OSError) as e:
            print(f"[warn] {sid}: 取得/解析に失敗、既存データを維持します ({e})", file=sys.stderr)
            status.update({"ok": False, "error": str(e), "count": prev.get("count", 0)})
            # 失敗時は etag を捨てて次回は無条件で取得し直す
            status.update({"etag": None, "lastModified": None})
            failures += 1
        meta_sources[sid] = status

    entries = prune(existing_by_url, {s["id"] for s in sources}, now_dt)
    apply_bookmark_info(entries, fetch_bookmark_counts([e["url"] for e in entries]))
    write_json(feed_path, entries)
    (DATA_DIR / "feed.xml").write_text(
        '<?xml version="1.0" encoding="UTF-8"?>\n' + build_atom(entries, now_iso) + "\n", encoding="utf-8"
    )
    # 次回更新の目安(画面フッターに表示する)。実際の実行間隔は workflow_dispatch を叩く側の設定次第。
    next_estimate = (now_dt + timedelta(minutes=NEXT_UPDATE_MINUTES)).strftime("%H:%M")
    write_json(meta_path, {"updatedAt": now_iso, "nextEstimate": next_estimate, "sources": meta_sources})
    print(f"[done] 累計{len(entries)}件 -> {feed_path}")

    if failures == len(sources):
        print("[error] 全ソースの取得に失敗しました", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
