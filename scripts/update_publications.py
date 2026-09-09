"""Build the static site, optionally refreshing its Google Scholar snapshot."""

import argparse
import html
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
from datetime import date, datetime, timezone
from urllib.error import HTTPError
from urllib.request import Request, urlopen


ROOT = Path(__file__).resolve().parents[1]
AUTHOR_ID = "fcOP0tgAAAAJ"
SNAPSHOT_URL = "https://zwadhams.github.io/publications.json"
START = "<!-- publications:start -->"
END = "<!-- publications:end -->"


def nonnegative_int(value, name):
    if type(value) is not int or value < 0:
        raise ValueError(f"Missing or invalid {name}; refusing to replace citation data.")
    return value


def validate_snapshot(data):
    if data.get("schema_version") != 1 or data.get("scholar_id") != AUTHOR_ID:
        raise ValueError("Snapshot has an unexpected schema or Scholar profile ID.")
    checked = date.fromisoformat(data["checked_at"])
    if checked > datetime.now(timezone.utc).date():
        raise ValueError("Snapshot check date is in the future.")
    total = nonnegative_int(data.get("total_citations"), "total citations")
    hindex = nonnegative_int(data.get("h_index"), "h-index")
    papers = data.get("publications")
    if not isinstance(papers, list) or not papers:
        raise ValueError("The publication list is empty or invalid.")
    ids = set()
    for paper in papers:
        pub_id = paper.get("id", "")
        if not re.fullmatch(re.escape(AUTHOR_ID) + r":[A-Za-z0-9_-]+", pub_id):
            raise ValueError("A publication has an invalid Scholar ID.")
        if pub_id in ids:
            raise ValueError(f"Duplicate publication: {pub_id}")
        ids.add(pub_id)
        for field in ("title", "authors"):
            if not isinstance(paper.get(field), str) or not paper[field].strip():
                raise ValueError(f"Missing {field} for {pub_id}.")
        if not isinstance(paper.get("venue"), str):
            raise ValueError(f"Invalid venue for {pub_id}.")
        year = paper.get("year")
        if year is not None and (type(year) is not int or not 1800 <= year <= 2200):
            raise ValueError(f"Invalid publication year for {pub_id}.")
        count = nonnegative_int(paper.get("citations"), f"citations for {pub_id}")
        if count > total:
            raise ValueError("A paper has more citations than the profile total.")
    if hindex > len(papers):
        raise ValueError("The publication list is incomplete for the reported h-index.")
    return data


def load_snapshot(path):
    return validate_snapshot(json.loads(Path(path).read_text(encoding="utf-8")))


def load_previous(seed, url):
    """Reuse deployed data so source-only deployments do not reset live counts."""
    if not url:
        return seed
    if url != SNAPSHOT_URL:
        raise ValueError("The previous snapshot must come from this site's HTTPS URL.")
    request = Request(url, headers={"Cache-Control": "no-cache"})
    try:
        with urlopen(request, timeout=20) as response:
            body = response.read(2_000_001)
    except HTTPError as error:
        if error.code == 404:
            print("No deployed snapshot yet; using the checked-in baseline.")
            return seed
        raise
    if len(body) > 2_000_000:
        raise ValueError("Deployed snapshot is unexpectedly large.")
    previous = validate_snapshot(json.loads(body))
    # The repository baseline can be deliberately updated after a manual review.
    return previous if previous["checked_at"] >= seed["checked_at"] else seed


def normalize_author(author, previous, allow_removals=False):
    if author.get("scholar_id") != AUTHOR_ID:
        raise ValueError("Google Scholar returned a different author profile.")
    if not {"indices", "publications"}.issubset(author.get("filled", [])):
        raise ValueError("Google Scholar returned an incomplete profile.")
    old = {paper["id"]: paper for paper in previous["publications"]}
    papers = []
    for entry in author.get("publications", []):
        pub_id = entry.get("author_pub_id")
        prior = old.get(pub_id, {})
        bib = entry.get("bib", {})
        authors = bib.get("author") or prior.get("authors")
        if isinstance(authors, list):
            authors = ", ".join(authors)
        year = bib.get("pub_year", prior.get("year"))
        title = bib.get("title")
        # Scholar sometimes truncates long titles in the profile list.
        if isinstance(title, str) and title.endswith(("...", "\u2026")):
            title = prior.get("title", title)
        papers.append({
            "id": pub_id,
            "title": title,
            "authors": authors,
            "venue": prior.get("venue") or bib.get("citation") or bib.get("journal")
                     or bib.get("conference") or "",
            "year": int(year) if year not in (None, "") else None,
            "citations": entry.get("num_citations"),
        })
    data = validate_snapshot({
        "schema_version": 1,
        "scholar_id": AUTHOR_ID,
        "checked_at": datetime.now(timezone.utc).date().isoformat(),
        "total_citations": author.get("citedby"),
        "h_index": author.get("hindex"),
        "publications": papers,
    })
    missing = set(old) - {paper["id"] for paper in papers}
    if missing and not allow_removals:
        raise ValueError("Previously published papers are missing from Scholar. "
                         "Review the profile before allowing removals.")
    if previous["total_citations"] > 0 and data["total_citations"] == 0:
        raise ValueError("Refusing an unexpected reset of all citations to zero.")
    return data


def stop_on_block(response):
    """Exit the isolated worker before scholarly retries blocks or opens a browser."""
    if response.status_code >= 400:
        raise SystemExit(f"Google Scholar returned HTTP {response.status_code}.")
    response.read()
    if any(marker in response.text.lower() for marker in
           ("gs_captcha_ccl", "captcha-form", "g-recaptcha", "rc-doscaptcha-body")):
        raise SystemExit("Google Scholar requested a CAPTCHA; update skipped.")


def fetch_worker(previous_path):
    # Import only in the network worker; offline rendering and tests use stdlib.
    from scholarly import ProxyGenerator, scholarly

    class DirectConnection(ProxyGenerator):
        # Pin scholarly because these two noninteractive hooks extend its internals.
        def _new_session(self, **kwargs):
            session = super()._new_session(**kwargs)
            session.event_hooks["response"].append(stop_on_block)
            return session

        def _handle_captcha2(self, url):
            raise SystemExit("Google Scholar requested a CAPTCHA; update skipped.")

    previous = load_snapshot(previous_path)
    known = {paper["id"] for paper in previous["publications"]}
    direct = DirectConnection()
    # Passing both avoids scholarly's automatic free-proxy fallback.
    scholarly.use_proxy(direct, direct)
    scholarly.set_timeout(15)
    scholarly.set_retries(1)
    author = scholarly.search_author_id(AUTHOR_ID)
    author = scholarly.fill(author, sections=["indices", "publications"])
    # Version 1.7.11 omits authors from profile-list entries. Preserve existing
    # metadata and request details only for newly discovered papers.
    for paper in author.get("publications", []):
        if paper.get("author_pub_id") not in known:
            scholarly.fill(paper)
    print(json.dumps(author, ensure_ascii=True))


def fetch_author(previous, timeout=90):
    with tempfile.TemporaryDirectory(prefix="scholar-fetch-") as directory:
        previous_path = Path(directory) / "previous.json"
        previous_path.write_text(json.dumps(previous, ensure_ascii=True), encoding="ascii")
        result = subprocess.run(
            [sys.executable, str(Path(__file__).resolve()), "--fetch-worker", str(previous_path)],
            capture_output=True, text=True, encoding="utf-8", timeout=timeout,
            env={**os.environ, "PYTHONIOENCODING": "utf-8", "PYTHON_DOTENV_DISABLED": "1"},
        )
    if result.returncode:
        raise RuntimeError("Scholar fetch failed: " + result.stderr.strip()[-1000:])
    return json.loads(result.stdout)


def render_publications(snapshot):
    checked = date.fromisoformat(snapshot["checked_at"])
    label = f"{checked.strftime('%B')} {checked.day}, {checked.year}"
    papers = sorted(snapshot["publications"], key=lambda p:
                    (-p["citations"], -(p["year"] or 0), p["title"].casefold()))
    rows = [
        '    <p class="publication-note">'
        f'<a href="https://scholar.google.com/citations?user={AUTHOR_ID}&amp;hl=en" '
        'target="_blank" rel="noopener noreferrer">Google Scholar</a>: '
        f'{len(papers)} works, {snapshot["total_citations"]} citations, '
        f'h-index {snapshot["h_index"]}. Last checked {label}.</p>',
        '    <div class="pub-list">',
    ]
    for paper in papers:
        link = ("https://scholar.google.com/citations?view_op=view_citation&amp;hl=en"
                f"&amp;user={AUTHOR_ID}&amp;citation_for_view={paper['id']}")
        year = (f'<span class="badge badge-year">{paper["year"]}</span>'
                if paper["year"] else "")
        count = paper["citations"]
        citations = (f'<span class="citation-count">{count} '
                     f'{"citation" if count == 1 else "citations"}</span>' if count else "")
        rows.append(f'''      <div class="pub-card">
        <div>
          <h3 class="pub-title"><a href="{link}" target="_blank" rel="noopener noreferrer">{html.escape(paper["title"])} <span class="paper-arrow" aria-hidden="true">&nearr;</span></a></h3>
          <div class="pub-authors">{html.escape(paper["authors"])}</div>
          <div class="pub-venue">{html.escape(paper["venue"])}</div>
        </div>
        <div class="pub-badges">
          {year}
          {citations}
        </div>
      </div>''')
    rows.append('    </div>')
    # Preserve names while emitting ASCII-only HTML, including future Scholar text.
    rendered = "\n".join(line.rstrip() for line in "\n".join(rows).splitlines())
    return rendered.encode("ascii", "xmlcharrefreplace").decode("ascii")


def build_site(snapshot, output, root=ROOT):
    validate_snapshot(snapshot)
    template = (root / "index.html").read_text(encoding="utf-8")
    if template.count(START) != 1 or template.count(END) != 1:
        raise ValueError("Expected exactly one marked publication section in index.html.")
    before, rest = template.split(START)
    _, after = rest.split(END)
    page = before + START + "\n" + render_publications(snapshot) + "\n    " + END + after
    output = Path(output).resolve()
    if output == root.resolve() or output in root.resolve().parents:
        raise ValueError("Build output must be a separate directory, not the source tree.")
    # A fresh build folder prevents accidental publication of unrelated files.
    if output.exists() and any(output.iterdir()):
        raise ValueError(f"Output directory is not empty: {output}")
    for asset in ("styles.css", "headshot.jpg"):
        if not (root / asset).is_file():
            raise ValueError(f"Missing site asset: {asset}")
    output.mkdir(parents=True, exist_ok=True)
    (output / "index.html").write_text(page, encoding="utf-8")
    (output / "publications.json").write_text(
        json.dumps(snapshot, indent=2, ensure_ascii=True) + "\n", encoding="ascii")
    for asset in ("styles.css", "headshot.jpg"):
        shutil.copyfile(root / asset, output / asset)
    (output / ".nojekyll").touch()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--refresh", action="store_true", help="Fetch current Scholar data.")
    parser.add_argument("--previous-url", choices=[SNAPSHOT_URL],
                        help="Reuse the deployed snapshot and check for missing papers.")
    parser.add_argument("--allow-removals", action="store_true",
                        help="Allow reviewed Scholar merges/removals during a refresh.")
    parser.add_argument("--output-dir", type=Path, default=ROOT / "_site",
                        help="Empty directory to receive the generated website.")
    parser.add_argument("--fetch-worker", type=Path, help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.fetch_worker:
        fetch_worker(args.fetch_worker)
        return
    snapshot = load_previous(load_snapshot(ROOT / "data/publications.json"), args.previous_url)
    if args.refresh:
        snapshot = normalize_author(fetch_author(snapshot), snapshot, args.allow_removals)
    build_site(snapshot, args.output_dir)
    print(f"Built {len(snapshot['publications'])} publications; "
          f"{snapshot['total_citations']} citations; checked {snapshot['checked_at']}.")
    print(f"Site written to {args.output_dir.resolve()}")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError, TypeError, RuntimeError, OSError, subprocess.TimeoutExpired) as error:
        print(f"Update stopped; no deployment should be made. {error}", file=sys.stderr)
        sys.exit(1)
