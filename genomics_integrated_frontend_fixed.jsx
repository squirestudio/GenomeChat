import { useState, useEffect, useCallback } from "react";

const API_BASE = "http://localhost:8000";

const SAMPLE_QUERIES = [
  "What are the pathogenic variants in BRCA1?",
  "Show me BRCA2 variants in European populations",
  "Which genes are associated with early-onset Alzheimer's?",
  "What genes cause hereditary breast cancer?",
  "TP53 variants",
  "Find genes linked to Parkinson's disease",
];

function Badge({ children, color = "gray" }) {
  const colors = {
    gray: "bg-gray-100 text-gray-700",
    blue: "bg-blue-100 text-blue-700",
    green: "bg-green-100 text-green-700",
    red: "bg-red-100 text-red-700",
    yellow: "bg-yellow-100 text-yellow-700",
    purple: "bg-purple-100 text-purple-700",
  };
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded text-xs font-medium ${colors[color]}`}>
      {children}
    </span>
  );
}

function VariantCard({ variant }) {
  const sigColor = {
    Pathogenic: "red",
    "Likely pathogenic": "red",
    Benign: "green",
    "Likely benign": "green",
    "Uncertain significance": "yellow",
  }[variant.clinical_significance] || "gray";

  return (
    <div className="border border-gray-200 rounded-lg p-3 hover:border-blue-300 transition-colors">
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <p className="font-mono text-sm font-medium text-gray-900 truncate">
            {variant.variant_id || "Unknown"}
          </p>
          {variant.condition && (
            <p className="text-xs text-gray-500 mt-0.5 truncate">{variant.condition}</p>
          )}
          {variant.consequence && (
            <p className="text-xs text-gray-400 mt-0.5">{variant.consequence}</p>
          )}
        </div>
        <div className="flex flex-col items-end gap-1 shrink-0">
          {variant.clinical_significance && (
            <Badge color={sigColor}>{variant.clinical_significance}</Badge>
          )}
          {variant.frequency != null && (
            <span className="text-xs text-gray-400">
              AF: {variant.frequency < 0.0001
                ? variant.frequency.toExponential(2)
                : variant.frequency.toFixed(4)}
            </span>
          )}
        </div>
      </div>
      <div className="mt-1.5 flex items-center gap-2">
        <Badge color="blue">{variant.source || "ClinVar"}</Badge>
        {variant.gene && <span className="text-xs text-gray-400">{variant.gene}</span>}
      </div>
    </div>
  );
}

function GeneCard({ gene }) {
  return (
    <div className="border border-gray-200 rounded-lg p-3 hover:border-purple-300 transition-colors">
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <p className="font-mono text-sm font-bold text-gray-900">{gene.gene_symbol}</p>
          {gene.description && (
            <p className="text-xs text-gray-500 mt-0.5 line-clamp-2">{gene.description}</p>
          )}
          {gene.disease_association && (
            <p className="text-xs text-blue-600 mt-0.5">↳ {gene.disease_association}</p>
          )}
        </div>
        <div className="flex flex-col items-end gap-1 shrink-0">
          {gene.chromosome && <Badge color="gray">Chr {gene.chromosome}</Badge>}
          {gene.publication_count != null && (
            <span className="text-xs text-gray-400">{gene.publication_count} pubs</span>
          )}
        </div>
      </div>
      <div className="mt-1.5">
        <Badge color="purple">{gene.source || "NCBI"}</Badge>
      </div>
    </div>
  );
}

function ResultsPanel({ response }) {
  if (!response) return null;

  const { interpreted, results, result_count, sources, cached, gene_info, protein_info } = response;
  const isGene = interpreted?.query_type === "gene_query";

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2 flex-wrap">
          <Badge color={isGene ? "blue" : "purple"}>
            {isGene ? "Gene Query" : "Disease Query"}
          </Badge>
          <span className="text-sm font-semibold text-gray-700">{interpreted?.target}</span>
          {interpreted?.population && (
            <Badge color="green">{interpreted.population}</Badge>
          )}
          {cached && <Badge color="yellow">Cached</Badge>}
        </div>
        <span className="text-sm text-gray-500">{result_count} results</span>
      </div>

      {sources?.length > 0 && (
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-xs text-gray-400">Sources:</span>
          {sources.map(s => <Badge key={s} color="gray">{s}</Badge>)}
        </div>
      )}

      {gene_info && (
        <div className="bg-blue-50 rounded-lg p-3 text-sm">
          <p className="font-semibold text-blue-800">{gene_info.symbol || interpreted?.target}</p>
          {gene_info.description && (
            <p className="text-blue-700 text-xs mt-1">{gene_info.description}</p>
          )}
          <div className="flex gap-3 mt-2 text-xs text-blue-600">
            {gene_info.chromosome && <span>Chr {gene_info.chromosome}</span>}
            {protein_info?.protein_name && <span>Protein: {protein_info.protein_name}</span>}
          </div>
          {protein_info?.function && (
            <p className="text-xs text-blue-600 mt-1 line-clamp-2">{protein_info.function}</p>
          )}
        </div>
      )}

      {results?.length === 0 ? (
        <div className="text-center py-8 text-gray-400">
          <p className="text-sm">No results found for this query.</p>
          <p className="text-xs mt-1">Try a different gene symbol or disease name.</p>
        </div>
      ) : (
        <div className="space-y-2 max-h-[60vh] overflow-y-auto pr-1">
          {results.map((item, i) =>
            isGene
              ? <VariantCard key={item.variant_id || i} variant={item} />
              : <GeneCard key={item.gene_symbol || i} gene={item} />
          )}
        </div>
      )}
    </div>
  );
}

function ProjectSidebar({ projects, activeProjectId, onSelect, onCreate, onDelete }) {
  const [newName, setNewName] = useState("");

  const handleCreate = (e) => {
    e.preventDefault();
    if (newName.trim()) {
      onCreate(newName.trim());
      setNewName("");
    }
  };

  return (
    <div className="w-64 shrink-0 border-r border-gray-200 flex flex-col bg-gray-50">
      <div className="p-4 border-b border-gray-200">
        <h2 className="text-sm font-semibold text-gray-700 mb-3">Projects</h2>
        <form onSubmit={handleCreate} className="flex gap-1.5">
          <input
            value={newName}
            onChange={e => setNewName(e.target.value)}
            placeholder="New project..."
            className="flex-1 text-xs border border-gray-300 rounded px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-blue-400"
          />
          <button
            type="submit"
            className="px-2 py-1.5 bg-blue-600 text-white rounded text-xs hover:bg-blue-700"
          >
            +
          </button>
        </form>
      </div>

      <div className="flex-1 overflow-y-auto p-2 space-y-1">
        <button
          onClick={() => onSelect(null)}
          className={`w-full text-left px-3 py-2 rounded text-xs transition-colors ${
            activeProjectId === null
              ? "bg-blue-100 text-blue-700 font-medium"
              : "text-gray-600 hover:bg-gray-100"
          }`}
        >
          All queries
        </button>
        {projects.map(p => (
          <div
            key={p.id}
            className={`flex items-center gap-1 rounded transition-colors ${
              activeProjectId === p.id ? "bg-blue-100" : "hover:bg-gray-100"
            }`}
          >
            <button
              onClick={() => onSelect(p.id)}
              className={`flex-1 text-left px-3 py-2 text-xs ${
                activeProjectId === p.id ? "text-blue-700 font-medium" : "text-gray-600"
              }`}
            >
              <span className="block truncate">{p.name}</span>
              <span className="text-gray-400">{p.query_count} queries</span>
            </button>
            <button
              onClick={() => onDelete(p.id)}
              className="px-1.5 py-1 text-gray-300 hover:text-red-400 text-xs"
            >
              ×
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}

function HistorySidebar({ history, onSelect }) {
  if (history.length === 0) return null;

  return (
    <div className="border-t border-gray-200 mt-4 pt-4">
      <h3 className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-2">
        Query History
      </h3>
      <div className="space-y-1">
        {history.slice(0, 10).map((item, i) => (
          <button
            key={i}
            onClick={() => onSelect(item)}
            className="w-full text-left px-2 py-1.5 rounded text-xs text-gray-600 hover:bg-gray-100 truncate"
          >
            {item.query}
          </button>
        ))}
      </div>
    </div>
  );
}

export default function GenomeChat() {
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [response, setResponse] = useState(null);
  const [error, setError] = useState(null);
  const [history, setHistory] = useState([]);
  const [projects, setProjects] = useState([]);
  const [activeProjectId, setActiveProjectId] = useState(null);
  const [apiStatus, setApiStatus] = useState("checking");

  useEffect(() => {
    checkHealth();
    loadProjects();
  }, []);

  const checkHealth = async () => {
    try {
      const r = await fetch(`${API_BASE}/health`);
      setApiStatus(r.ok ? "online" : "error");
    } catch {
      setApiStatus("offline");
    }
  };

  const loadProjects = async () => {
    try {
      const r = await fetch(`${API_BASE}/projects`);
      if (r.ok) setProjects(await r.json());
    } catch {}
  };

  const handleSubmit = useCallback(async (e) => {
    e?.preventDefault();
    if (!query.trim() || loading) return;

    setLoading(true);
    setError(null);

    try {
      const r = await fetch(`${API_BASE}/execute-query`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: query, project_id: activeProjectId }),
      });

      const data = await r.json();

      if (!r.ok) {
        setError(data.detail || "Query failed");
        return;
      }

      setResponse(data);
      setHistory(prev => [data, ...prev.filter(h => h.query !== data.query)]);
    } catch (err) {
      setError(`Network error: ${err.message}. Is the backend running?`);
    } finally {
      setLoading(false);
    }
  }, [query, loading, activeProjectId]);

  const handleKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const exportJSON = () => {
    if (!response) return;
    const blob = new Blob([JSON.stringify(response, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `genomechat-${response.interpreted?.target || "results"}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const exportCSV = () => {
    if (!response?.results?.length) return;
    const keys = Object.keys(response.results[0]);
    const rows = response.results.map(r => keys.map(k => JSON.stringify(r[k] ?? "")).join(","));
    const csv = [keys.join(","), ...rows].join("\n");
    const blob = new Blob([csv], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `genomechat-${response.interpreted?.target || "results"}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const createProject = async (name) => {
    try {
      const r = await fetch(`${API_BASE}/projects`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (r.ok) {
        await loadProjects();
        const data = await r.json();
        setActiveProjectId(data.id);
      }
    } catch {}
  };

  const deleteProject = async (id) => {
    try {
      await fetch(`${API_BASE}/projects/${id}`, { method: "DELETE" });
      if (activeProjectId === id) setActiveProjectId(null);
      await loadProjects();
    } catch {}
  };

  return (
    <div className="flex h-screen bg-white font-sans">
      <ProjectSidebar
        projects={projects}
        activeProjectId={activeProjectId}
        onSelect={setActiveProjectId}
        onCreate={createProject}
        onDelete={deleteProject}
      />

      <div className="flex-1 flex flex-col min-w-0">
        <header className="border-b border-gray-200 px-6 py-3 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <span className="text-xl">🧬</span>
            <div>
              <h1 className="text-lg font-bold text-gray-900">GenomeChat</h1>
              <p className="text-xs text-gray-400">Natural language genomics research</p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            {response && (
              <div className="flex gap-2">
                <button
                  onClick={exportJSON}
                  className="px-3 py-1.5 text-xs border border-gray-300 rounded hover:bg-gray-50"
                >
                  Export JSON
                </button>
                <button
                  onClick={exportCSV}
                  className="px-3 py-1.5 text-xs border border-gray-300 rounded hover:bg-gray-50"
                >
                  Export CSV
                </button>
              </div>
            )}
            <div className="flex items-center gap-1.5">
              <div className={`w-2 h-2 rounded-full ${
                apiStatus === "online" ? "bg-green-400" :
                apiStatus === "offline" ? "bg-red-400" : "bg-yellow-400"
              }`} />
              <span className="text-xs text-gray-400 capitalize">{apiStatus}</span>
            </div>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto p-6">
          {!response && !loading && !error && (
            <div className="max-w-2xl mx-auto">
              <p className="text-gray-500 text-sm mb-4 text-center">
                Ask anything about genes, variants, or genetic diseases.
              </p>
              <div className="grid grid-cols-2 gap-2">
                {SAMPLE_QUERIES.map(q => (
                  <button
                    key={q}
                    onClick={() => { setQuery(q); }}
                    className="text-left p-3 rounded-lg border border-gray-200 text-xs text-gray-600 hover:border-blue-300 hover:bg-blue-50 transition-colors"
                  >
                    {q}
                  </button>
                ))}
              </div>
            </div>
          )}

          {loading && (
            <div className="flex flex-col items-center justify-center py-16 gap-3">
              <div className="w-8 h-8 border-2 border-blue-600 border-t-transparent rounded-full animate-spin" />
              <p className="text-sm text-gray-500">Querying genomics databases...</p>
            </div>
          )}

          {error && (
            <div className="max-w-2xl mx-auto bg-red-50 border border-red-200 rounded-lg p-4">
              <p className="text-sm font-medium text-red-800">Error</p>
              <p className="text-xs text-red-600 mt-1">{error}</p>
            </div>
          )}

          {response && !loading && (
            <div className="max-w-3xl mx-auto">
              <ResultsPanel response={response} />
            </div>
          )}

          {history.length > 0 && (
            <div className="max-w-3xl mx-auto">
              <HistorySidebar
                history={history}
                onSelect={item => setResponse(item)}
              />
            </div>
          )}
        </div>

        <div className="border-t border-gray-200 p-4">
          <form onSubmit={handleSubmit} className="max-w-3xl mx-auto flex gap-3">
            <textarea
              value={query}
              onChange={e => setQuery(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Ask about a gene (e.g. 'BRCA1 variants') or disease (e.g. 'Alzheimer's genes')..."
              rows={2}
              className="flex-1 resize-none border border-gray-300 rounded-lg px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400 focus:border-transparent"
            />
            <button
              type="submit"
              disabled={loading || !query.trim()}
              className="px-5 py-2.5 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors shrink-0"
            >
              {loading ? "..." : "Search"}
            </button>
          </form>
          <p className="text-center text-xs text-gray-400 mt-2">
            Powered by Claude AI · Ensembl · ClinVar · gnomAD · UniProt · PubMed
          </p>
        </div>
      </div>
    </div>
  );
}
