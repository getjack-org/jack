const docIdEl = document.getElementById("doc-id");
const docContentEl = document.getElementById("doc-content");
const indexBtn = document.getElementById("index-btn");
const indexStatus = document.getElementById("index-status");
const searchQueryEl = document.getElementById("search-query");
const searchBtn = document.getElementById("search-btn");
const resultsEl = document.getElementById("results");

// Index document
async function indexDocument() {
	const id = docIdEl.value.trim();
	const content = docContentEl.value.trim();

	if (!id || !content) {
		showStatus(indexStatus, "Please enter both ID and content", "error");
		return;
	}

	indexBtn.disabled = true;
	indexBtn.innerHTML = '<span class="loading"></span>Indexing...';

	try {
		const response = await fetch("/api/index", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ id, content }),
		});

		const data = await response.json();

		if (response.ok) {
			showStatus(indexStatus, `Document "${id}" indexed successfully!`, "success");
			docIdEl.value = "";
			docContentEl.value = "";
		} else {
			showStatus(indexStatus, data.error || "Failed to index document", "error");
		}
	} catch (err) {
		showStatus(indexStatus, "Network error. Please try again.", "error");
	} finally {
		indexBtn.disabled = false;
		indexBtn.textContent = "Index Document";
	}
}

// Search documents
async function searchDocuments() {
	const query = searchQueryEl.value.trim();

	if (!query) {
		resultsEl.innerHTML = '<div class="no-results">Please enter a search query</div>';
		return;
	}

	searchBtn.disabled = true;
	searchBtn.innerHTML = '<span class="loading"></span>Searching...';
	resultsEl.innerHTML = "";

	try {
		const response = await fetch("/api/search", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ query, limit: 5 }),
		});

		const data = await response.json();

		if (response.ok) {
			if (data.results && data.results.length > 0) {
				resultsEl.innerHTML = data.results
					.map(
						(result) => `
          <div class="result">
            <div class="result-header">
              <span class="result-id">${escapeHtml(result.id)}</span>
              <span class="result-score">Score: ${(result.score * 100).toFixed(1)}%</span>
            </div>
            <div class="result-preview">${escapeHtml(result.metadata?.preview || "No preview available")}</div>
          </div>
        `,
					)
					.join("");
			} else {
				resultsEl.innerHTML = '<div class="no-results">No matching documents found</div>';
			}
		} else {
			resultsEl.innerHTML = `<div class="no-results">${escapeHtml(data.error || "Search failed")}</div>`;
		}
	} catch (err) {
		resultsEl.innerHTML = '<div class="no-results">Network error. Please try again.</div>';
	} finally {
		searchBtn.disabled = false;
		searchBtn.textContent = "Search";
	}
}

// Helper functions
function showStatus(el, message, type) {
	el.textContent = message;
	el.className = `status ${type}`;
}

function escapeHtml(text) {
	const div = document.createElement("div");
	div.textContent = text;
	return div.innerHTML;
}

// Event listeners
indexBtn.addEventListener("click", indexDocument);
searchBtn.addEventListener("click", searchDocuments);

// Enter key support
docIdEl.addEventListener("keypress", (e) => {
	if (e.key === "Enter") docContentEl.focus();
});

searchQueryEl.addEventListener("keypress", (e) => {
	if (e.key === "Enter") searchDocuments();
});
