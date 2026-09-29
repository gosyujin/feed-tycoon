import sys
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "scripts"))
import fetch_feeds as ff  # noqa: E402

RSS2 = """<?xml version="1.0"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/"><channel><title>t</title>
<item><title>Rss &amp; Two</title><link>https://example.com/a</link>
<description>&lt;p&gt;hello   &lt;b&gt;world&lt;/b&gt;&lt;/p&gt;</description>
<pubDate>Tue, 29 Sep 2026 12:00:00 +0900</pubDate></item>
<item><title>no link</title></item>
</channel></rss>""".encode()

RDF = """<?xml version="1.0"?>
<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns="http://purl.org/rss/1.0/"
 xmlns:dc="http://purl.org/dc/elements/1.1/">
<channel><title>t</title></channel>
<item><title>Rdf item</title><link>https://example.org/b</link><description>d</description>
<dc:date>2026-09-29T03:00:00Z</dc:date></item></rdf:RDF>""".encode()

ATOM = """<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom"><title>t</title>
<link rel="self" href="https://example.net/feed"/>
<entry><title>Atom item</title><link rel="alternate" href="https://example.net/c"/>
<summary>s</summary><published>2026-09-29T00:00:00+09:00</published></entry></feed>""".encode()


class ParseFeedTest(unittest.TestCase):
    def test_rss2(self):
        entries = ff.parse_feed(RSS2)
        self.assertEqual(len(entries), 1)  # リンクの無い item は捨てる
        e = entries[0]
        self.assertEqual(e["title"], "Rss & Two")
        self.assertEqual(e["url"], "https://example.com/a")
        self.assertEqual(e["domain"], "example.com")
        self.assertEqual(e["description"], "hello world")
        self.assertEqual(e["publishedAt"], "2026-09-29T12:00:00+09:00")

    def test_rdf(self):
        e = ff.parse_feed(RDF)[0]
        self.assertEqual(e["url"], "https://example.org/b")
        self.assertEqual(e["publishedAt"], "2026-09-29T12:00:00+09:00")

    def test_atom(self):
        entries = ff.parse_feed(ATOM)
        self.assertEqual(len(entries), 1)  # rel="self" は記事リンクとして拾わない
        self.assertEqual(entries[0]["url"], "https://example.net/c")

    def test_description_is_truncated(self):
        self.assertEqual(len(ff.clean_text("x" * 500, 200)), 201)

    def test_parse_date_invalid(self):
        self.assertIsNone(ff.parse_date("not a date"))
        self.assertIsNone(ff.parse_date(None))


class MergePruneTest(unittest.TestCase):
    def setUp(self):
        self.now = datetime(2026, 9, 30, 12, 0, tzinfo=ff.JST)
        self.source = {"id": "s", "name": "S", "tags": ["t"]}

    def fresh(self, url, published=None):
        return {"title": url, "url": url, "domain": "example.com", "description": None, "publishedAt": published}

    def test_first_seen_is_kept_and_last_seen_updated(self):
        existing = {}
        ff.merge_entries(existing, [self.fresh("https://e/1")], self.source, self.now)
        later = self.now + timedelta(hours=1)
        ff.merge_entries(existing, [self.fresh("https://e/1")], self.source, later)
        e = existing["https://e/1"]
        self.assertEqual(e["firstSeenAt"], self.now.isoformat())
        self.assertEqual(e["lastSeenAt"], later.isoformat())
        self.assertEqual((e["source"], e["sourceId"], e["tags"]), ("S", "s", ["t"]))

    def test_old_new_items_are_skipped(self):
        old = (self.now - timedelta(days=ff.RETENTION_DAYS + 1)).isoformat()
        existing = {}
        ff.merge_entries(existing, [self.fresh("https://e/old", old)], self.source, self.now)
        self.assertEqual(existing, {})

    def test_prune_drops_expired_and_removed_sources_and_caps(self):
        existing = {}
        ff.merge_entries(existing, [self.fresh(f"https://e/{i}") for i in range(ff.MAX_ENTRIES_PER_SOURCE + 5)], self.source, self.now)
        existing["https://e/expired"] = {
            "url": "https://e/expired", "sourceId": "s",
            "firstSeenAt": (self.now - timedelta(days=ff.RETENTION_DAYS + 1)).isoformat(),
        }
        existing["https://e/gone"] = {"url": "https://e/gone", "sourceId": "removed", "firstSeenAt": self.now.isoformat()}
        kept = ff.prune(existing, {"s"}, self.now)
        self.assertEqual(len(kept), ff.MAX_ENTRIES_PER_SOURCE)
        self.assertNotIn("https://e/expired", [e["url"] for e in kept])
        self.assertNotIn("https://e/gone", [e["url"] for e in kept])

    def test_atom_output_is_well_formed(self):
        existing = {}
        ff.merge_entries(existing, [self.fresh("https://e/1", "2026-09-30T10:00:00+09:00")], self.source, self.now)
        xml = ff.build_atom(list(existing.values()), self.now.isoformat())
        self.assertIn("<title>https://e/1</title>", xml)
        ff.ET.fromstring(xml)


class BookmarkTest(unittest.TestCase):
    def test_entry_url(self):
        self.assertEqual(ff.hatena_entry_url("https://example.com/a?b=1"), "https://b.hatena.ne.jp/entry/s/example.com/a?b=1")
        self.assertEqual(ff.hatena_entry_url("http://example.com/a#x"), "https://b.hatena.ne.jp/entry/example.com/a%23x")
        self.assertIsNone(ff.hatena_entry_url("ftp://example.com/"))

    def test_apply_keeps_previous_count_when_missing(self):
        entries = [{"url": "https://e/1", "bookmarkCount": 7}, {"url": "https://e/2"}, {"url": "https://e/3"}]
        ff.apply_bookmark_info(entries, {"https://e/3": 12})
        self.assertEqual([e["bookmarkCount"] for e in entries], [7, 0, 12])
        self.assertEqual(entries[0]["bookmarkUrl"], "https://b.hatena.ne.jp/entry/s/e/1")


if __name__ == "__main__":
    unittest.main()
