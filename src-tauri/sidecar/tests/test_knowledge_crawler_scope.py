"""Offline regressions for document scope and lossless reading structure."""

from __future__ import annotations

import sys
from pathlib import Path
from types import SimpleNamespace

import pytest
from bs4 import BeautifulSoup

sys.path.insert(0, str(Path(__file__).parent.parent))

from knowledge.crawlers.generic import GenericCrawler, _extract_links, _extract_page
from knowledge.sources import _chunk_markdown, _split_long_section

BASH = "https://manpages.debian.org/bookworm/bash/bash.1.en.html"


def test_bash_links_stay_in_the_same_package_and_version():
    links = [
        "rbash.1.en.html", "bashbug.1.en.html#usage",
        "../emacs/emacs.1.en.html", "../index.html",
        "/trixie/bash/bash.1.en.html", "/bookworm/bash-other/bash.1.en.html",
        "/bookworm/bash/%2e%2e/emacs/emacs.1.en.html",
        "/bookworm/bash/%2e%2e%2femacs/emacs.1.en.html",
        "https://other.invalid/bookworm/bash/bash.1.en.html",
    ]
    soup = BeautifulSoup("".join(f'<a href="{url}">reference</a>' for url in links), "html.parser")
    assert _extract_links(soup, BASH, BASH) == [
        "https://manpages.debian.org/bookworm/bash/rbash.1.en.html",
        "https://manpages.debian.org/bookworm/bash/bashbug.1.en.html",
    ]


def test_other_sources_keep_their_existing_same_host_link_scope():
    soup = BeautifulSoup('<a href="/reference/cli">CLI</a><a href="/guide/start">Start</a>', "html.parser")
    base = "https://docs.example.invalid/guide/"
    assert _extract_links(soup, base, base) == [
        "https://docs.example.invalid/reference/cli", "https://docs.example.invalid/guide/start",
    ]


@pytest.mark.parametrize("final_url", [
    "https://manpages.debian.org/bookworm/emacs/emacs.1.en.html",
    "https://manpages.debian.org/trixie/bash/bash.1.en.html",
    "https://other.invalid/bookworm/bash/bash.1.en.html",
])
def test_redirected_wrong_document_is_not_cached_or_indexed(tmp_path, monkeypatch, final_url):
    import requests

    response = SimpleNamespace(url=final_url, text="Wrong document", raise_for_status=lambda: None)
    monkeypatch.setattr(requests, "get", lambda *_args, **_kwargs: response)
    crawler = GenericCrawler("bash-docs", BASH, cache_root=tmp_path, max_pages=1, delay=0)
    result = crawler.fetch()
    assert result.success is False
    assert result.entries == []
    assert list(crawler.cache_dir.glob("*.json")) == []


def test_same_package_redirect_is_still_readable(tmp_path, monkeypatch):
    import requests

    final_url = "https://manpages.debian.org/bookworm/bash/rbash.1.en.html"
    response = SimpleNamespace(url=final_url, text="Bash document", raise_for_status=lambda: None)
    monkeypatch.setattr(requests, "get", lambda *_args, **_kwargs: response)
    crawler = GenericCrawler("bash-docs", BASH, cache_root=tmp_path, delay=0)
    assert crawler._http_get(BASH) == "Bash document"


def test_long_extracted_document_keeps_tail_code_table_and_warning():
    html = (
        "<html><body><main><h1>Bash manual</h1>"
        f"<p>{'Configuration detail. ' * 800}</p>"
        "<pre>printf '%s\\n' \"$HOME\"\n\necho done</pre>"
        "<table><tr><th>Option</th><th>Meaning</th></tr><tr><td>--help</td><td>Show help</td></tr></table>"
        "<blockquote>Warning: verify the current host before changes.</blockquote>"
        "<p>END-OF-COMPLETE-DOCUMENT</p></main></body></html>"
    )
    page = _extract_page(BeautifulSoup(html, "html.parser"), BASH, ["bash"])
    assert len(page["content"]) > 12000
    assert "END-OF-COMPLETE-DOCUMENT" in page["content"]
    assert "printf '%s\\n' \"$HOME\"\n\necho done" in page["content"]
    assert "| --help | Show help |" in page["content"]
    assert "Warning: verify the current host before changes." in page["content"]


@pytest.mark.parametrize("fence", ["```", "~~~", "````"])
def test_long_code_with_blank_lines_stays_one_block(fence):
    code = f"{fence}sh\n" + "# comment\nprintf '%s\\n' safe\n" * 60 + "\n\n# second half\necho done\n" + fence
    body = "Introduction.\n\n" + code + "\n\nAfterword."
    parts = _split_long_section(body)
    assert len(parts) > 1
    assert sum(code in part for part in parts) == 1
    assert "\n\n".join(parts) == body


def test_short_inner_fence_does_not_end_outer_code_or_remove_code_lines():
    body = "# Notes\n\n````markdown\n```sh\n# not a chapter\nCopyright\n```\n````\n\n## Next\n\nBody"
    chunks = _chunk_markdown(body)
    assert [title for title, _ in chunks] == ["Notes", "Next"]
    assert "```sh\n# not a chapter\nCopyright\n```" in chunks[0][1]
