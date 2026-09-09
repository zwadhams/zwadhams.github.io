# Personal website

This is a static GitHub Pages site with a weekly Google Scholar publication update.
The updater refreshes citation counts, adds papers found in Zachary Wadhams'
Scholar profile, sorts by citation count, and hides zero-citation labels.

Updates run every Monday at 08:23 UTC. They use `scholarly` directly without an
API key, a paid service, free proxies, or an interactive browser. Google Scholar
can still block requests. A blocked, timed-out, or invalid refresh fails the build
and leaves the deployed website intact.

## Enable publishing

You need permission to manage this repository's GitHub Pages settings.

1. Review, commit, and push the changes yourself to the repository's default branch.
2. In the GitHub repository, open **Settings > Pages** and select **GitHub Actions**
   as the build and deployment source.
3. Open **Actions > Publish site and refresh publications > Run workflow**. Select
   the default branch and leave **Fetch current Google Scholar data** checked.
4. Verify that both the build and deployment jobs succeed, then check the date and
   publication list on the live website.

If Scholar blocks the first refresh, run the workflow with **Fetch current Google
Scholar data** unchecked to publish the site using the saved baseline. The next
scheduled run will attempt a refresh again.

The workflow publishes a generated site artifact. It has no permission to write
repository contents and does not create commits or push changes.

See GitHub's [custom Pages workflow documentation](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages).

## Edit the website

- Edit `index.html` for the layout and biography, and `styles.css` for appearance.
- Keep the `publications:start` and `publications:end` comments in `index.html`.
  The build replaces only the content between them.
- [data/publications.json](data/publications.json) contains the initial verified
  publication snapshot, dated September 9, 2026. It is also the offline baseline.
- [scripts/update_publications.py](scripts/update_publications.py) generates the
  publication section and copies only the website's assets into the output folder.
- [publish-site.yml](.github/workflows/publish-site.yml) defines the schedule and deployment.
- The older `outputs/` directory is excluded from the generated website. Its nested
  workflow is inactive and should not be moved into the active workflow directory.

Pushing a source change rebuilds the site using the last deployed `publications.json`.
It does not contact Scholar or reset live counts to the older repository baseline.
If no deployed snapshot exists yet (HTTP 404), the build uses the baseline.
Other snapshot retrieval failures stop the build to avoid overwriting newer data.

## Build locally

Use Python 3.12. Run these commands from the repository root with your Python
executable; the examples assume it is available as `python`.

Build an offline preview without installing dependencies:

```powershell
python scripts/update_publications.py --output-dir _site/preview
python -m http.server 4174 --bind 127.0.0.1 --directory _site/preview
```

Open `http://127.0.0.1:4174/` to view the generated site. Stop the server with Ctrl+C.
The output directory must be empty; use a fresh subdirectory for each build.

Install the pinned dependencies, then request a live refresh into another folder:

```powershell
python -m pip install -r requirements-citations.txt
python scripts/update_publications.py --refresh --output-dir _site/refreshed
```

These commands do not edit the source HTML, baseline JSON, or Git history.
The fetch has a 90-second overall limit and stops on access-denied responses or
CAPTCHAs. It fetches details only for new papers because `scholarly` omits author
names from profile-list entries. Existing author and venue formatting is retained.

## Handle Scholar changes

New papers appear on the site after they appear in your specific Scholar profile
and a scheduled update succeeds. The updater does not search the whole Scholar
index for papers that have not been added to your profile.

Missing existing papers, duplicate IDs, a different profile, missing citation
counts, and unexpected resets to zero stop the refresh. Normal citation decreases
are allowed because Scholar can revise its counts.

If Scholar intentionally merges or removes a paper, review the change in your
profile, then run the workflow manually with **Allow paper removals after reviewing
Scholar merges or deletions** checked. The corresponding local option is
`--allow-removals`, used together with `--refresh`.

GitHub may delay scheduled runs. It also disables schedules in public repositories
after 60 days without repository activity. If updates stop, check the Actions page
and re-enable the workflow if needed. See [GitHub's schedule documentation](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#schedule).

## Run checks

The test suite runs without network access or third-party dependencies:

```powershell
python -m unittest discover -s tests -v
```

Tests cover matching by Scholar ID, adding papers, sorting, hiding zero counts,
HTML escaping, incomplete responses, timeouts, preserving the last snapshot, and
packaging the site without modifying its source files.
