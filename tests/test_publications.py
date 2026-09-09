"""Regression tests for publishing complete, correctly matched citation data."""

from copy import deepcopy
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch, MagicMock
from urllib.error import HTTPError, URLError

from scripts import update_publications as updater


class PublicationTests(unittest.TestCase):
    def setUp(self):
        self.previous = {
            "schema_version": 1, "scholar_id": updater.AUTHOR_ID,
            "checked_at": "2026-09-04", "total_citations": 9, "h_index": 2,
            "publications": [{
                "id": updater.AUTHOR_ID + f":paper{i}", "title": f"Example paper {i}",
                "authors": "Z. Wadhams, A. Researcher", "venue": "Example conference",
                "year": 2024 + i % 3, "citations": count,
            } for i, count in enumerate([4, 3, 2, 0])],
        }
        self.author = {
            "scholar_id": updater.AUTHOR_ID,
            "filled": ["indices", "publications"],
            "citedby": 9,
            "hindex": 2,
            "publications": [{
                "author_pub_id": paper["id"],
                "num_citations": paper["citations"],
                # scholarly's profile entries lack author metadata.
                "bib": {"title": paper["title"], "pub_year": str(paper["year"]),
                        "citation": paper["venue"]},
            } for paper in self.previous["publications"]],
        }

    def test_reordered_profile_matches_citations_by_id_and_adds_new_paper(self):
        self.author["publications"].reverse()
        self.author["publications"][-1]["num_citations"] = 31
        self.author["citedby"] = 61
        self.author["publications"].append({
            "author_pub_id": updater.AUTHOR_ID + ":newPaper",
            "num_citations": 1,
            "bib": {"title": "New security research", "author": "Z Wadhams and A Researcher",
                    "pub_year": "2026", "citation": "Example venue"},
        })
        data = updater.normalize_author(self.author, self.previous)
        by_id = {paper["id"]: paper for paper in data["publications"]}
        original = self.previous["publications"][0]
        self.assertEqual(by_id[original["id"]]["citations"], 31)
        self.assertEqual(by_id[original["id"]]["authors"], original["authors"])
        self.assertEqual(len(data["publications"]), 5)
        rendered = updater.render_publications(data)
        self.assertIn("1 citation</span>", rendered)
        self.assertNotIn("0 citations</span>", rendered)
        self.assertLess(rendered.index(original["title"]), rendered.index("New security research"))

    def test_missing_counts_are_rejected_instead_of_zeroed(self):
        del self.author["publications"][0]["num_citations"]
        with self.assertRaisesRegex(ValueError, "citations"):
            updater.normalize_author(self.author, self.previous)

    def test_missing_and_duplicate_papers_are_rejected(self):
        self.author["publications"].pop()
        with self.assertRaisesRegex(ValueError, "missing"):
            updater.normalize_author(self.author, self.previous)
        self.author["publications"].append(deepcopy(self.author["publications"][0]))
        with self.assertRaisesRegex(ValueError, "Duplicate"):
            updater.normalize_author(self.author, self.previous)

    def test_reviewed_removals_are_explicit(self):
        self.author["publications"].pop()
        data = updater.normalize_author(self.author, self.previous, allow_removals=True)
        self.assertEqual(len(data["publications"]), 3)

    def test_wrong_profile_empty_and_partial_results_are_rejected(self):
        for field, value in [("scholar_id", "anotherProfile"), ("publications", []),
                             ("filled", ["indices"]), ("citedby", None)]:
            with self.subTest(field=field):
                author = deepcopy(self.author)
                author[field] = value
                with self.assertRaises(ValueError):
                    updater.normalize_author(author, self.previous)

    def test_legitimate_citation_decrease_is_allowed(self):
        self.author["publications"][0]["num_citations"] = 2
        self.author["citedby"] = 7
        data = updater.normalize_author(self.author, self.previous)
        self.assertEqual(data["total_citations"], 7)

    def test_external_text_is_escaped_and_ascii(self):
        data = deepcopy(self.previous)
        data["publications"][0]["title"] = '<script>alert("x")</script> Jos\u00e9'
        rendered = updater.render_publications(data)
        self.assertNotIn("<script>", rendered)
        self.assertIn("&lt;script&gt;", rendered)
        self.assertIn("Jos&#233;", rendered)
        self.assertTrue(rendered.isascii())

    def test_blocks_stop_without_retrying_or_opening_browser(self):
        for status, body in [(403, "Forbidden"), (429, "Too many requests"),
                             (200, '<div class="g-recaptcha">')]:
            response = MagicMock(status_code=status, text=body)
            with self.subTest(status=status), self.assertRaises(SystemExit):
                updater.stop_on_block(response)

    def test_source_build_retains_newer_published_snapshot(self):
        live = deepcopy(self.previous)
        live["total_citations"] = 60
        response = MagicMock()
        response.__enter__.return_value.read.return_value = json.dumps(live).encode()
        with patch.object(updater, "urlopen", return_value=response):
            chosen = updater.load_previous(self.previous, updater.SNAPSHOT_URL)
        self.assertEqual(chosen["total_citations"], 60)

    def test_only_first_deployment_404_uses_baseline(self):
        missing = HTTPError(updater.SNAPSHOT_URL, 404, "Not found", {}, None)
        with patch.object(updater, "urlopen", side_effect=missing):
            self.assertEqual(updater.load_previous(self.previous, updater.SNAPSHOT_URL), self.previous)
        with patch.object(updater, "urlopen", side_effect=URLError("Unavailable")):
            with self.assertRaises(URLError):
                updater.load_previous(self.previous, updater.SNAPSHOT_URL)

    def test_failed_refresh_does_not_write_existing_output_or_source(self):
        source_before = (updater.ROOT / "index.html").read_bytes()
        with tempfile.TemporaryDirectory() as directory:
            sentinel = Path(directory) / "index.html"
            sentinel.write_text("Previously published site", encoding="ascii")
            with patch("sys.argv", ["update_publications.py", "--refresh", "--output-dir", directory]), \
                    patch.object(updater, "fetch_author", side_effect=RuntimeError("Blocked")):
                with self.assertRaises(RuntimeError):
                    updater.main()
            self.assertEqual(sentinel.read_text(), "Previously published site")
        self.assertEqual((updater.ROOT / "index.html").read_bytes(), source_before)

    def test_worker_has_a_hard_timeout(self):
        with patch.object(updater.subprocess, "run", side_effect=subprocess.TimeoutExpired("fetch", 1)) as run:
            with self.assertRaises(subprocess.TimeoutExpired):
                updater.fetch_author(self.previous, timeout=1)
        self.assertEqual(run.call_args.kwargs["timeout"], 1)

    def test_build_preserves_other_sections_and_only_packages_site_files(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "site"
            updater.build_site(self.previous, output)
            original = (updater.ROOT / "index.html").read_text(encoding="utf-8")
            generated = (output / "index.html").read_text(encoding="utf-8")
            self.assertEqual(original.split(updater.START)[0], generated.split(updater.START)[0])
            self.assertEqual(original.split(updater.END)[1], generated.split(updater.END)[1])
            self.assertEqual(set(p.name for p in output.iterdir()),
                             {"index.html", "styles.css", "headshot.jpg", "publications.json", ".nojekyll"})
            self.assertEqual(updater.load_snapshot(output / "publications.json"), self.previous)
            with self.assertRaisesRegex(ValueError, "not empty"):
                updater.build_site(self.previous, output)


if __name__ == "__main__":
    unittest.main()
