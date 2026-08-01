import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import jsPDF from "jspdf";
import html2canvas from "html2canvas";
import {
  parseDNAFile, saveDnaToSession, loadDnaFromSession,
  computeDnaSummary, variantsInLocus, selectRelevantVariants,
} from "./dna";
import { parseSSEChunk } from "./sse";
import { getPlan } from "./plan";
import { splitProseSections, norm, PROSE_PRIMARY, EXPLORE_LABELS, ALL_SECTION_KEYS, buildExploreItems } from "./response";
import { layoutSpans, spanLegend, svKind, formatBp } from "./spans";
import { buildNetwork, evidenceColor } from "./network";
import {
  consequenceClass, significanceClass, evidenceLevel,
  fullView, clampView, zoomView, panView, isFullView,
  positionVariants, filterVariants, facetCounts,
  assignLanes, domainAt, prepareDomains, matchUserGenotypes,
} from "./lollipop";

// Registry so exportPDF can grab a live protein viewer snapshot (WebGL → PNG)
const viewerRegistry = new Map(); // geneName -> $3Dmol viewer instance

// ─── Anonymous query counter ──────────────────────────────────────────────────
const ANON_QUERY_KEY = "genomechat_anon_queries";
const ANON_QUERY_LIMIT = 3;

function getAnonQueryCount() {
  try { return parseInt(localStorage.getItem(ANON_QUERY_KEY) || "0", 10); } catch { return 0; }
}
function incrementAnonQueryCount() {
  try { localStorage.setItem(ANON_QUERY_KEY, String(getAnonQueryCount() + 1)); } catch {}
}

// ─── "Glad you're here" nudge ─────────────────────────────────────────────────
// A lifetime tally kept separately from the counters above, which are billing
// state: the anonymous count resets on sign-in and the server-side total resets
// against nothing at all. Neither answers "has this person used MyDNA enough to
// be curious about it", which is the only question this nudge asks.
//
// Deliberately not shown on arrival. The instruction was to let people jump
// straight in, so this waits until someone has found the tool useful and then
// invites them to read about it once.
const QUERY_TALLY_KEY = "mydna_query_tally";
const ABOUT_NUDGE_KEY = "mydna_about_nudge_dismissed";
const ABOUT_NUDGE_AFTER = 5;

function getQueryTally() {
  try { return parseInt(localStorage.getItem(QUERY_TALLY_KEY) || "0", 10) || 0; } catch { return 0; }
}
function incrementQueryTally() {
  try { localStorage.setItem(QUERY_TALLY_KEY, String(getQueryTally() + 1)); } catch { /* private mode; the nudge simply never fires */ }
}
function aboutNudgeDismissed() {
  try { return localStorage.getItem(ABOUT_NUDGE_KEY) === "1"; } catch { return true; }
}
function dismissAboutNudge() {
  try { localStorage.setItem(ABOUT_NUDGE_KEY, "1"); } catch { /* cannot persist; it will reappear next session */ }
}

// ─── Settings (persisted to localStorage) ────────────────────────────────────
const SETTINGS_KEY = "genomechat_settings";

const DEFAULT_SETTINGS = {
  theme: "light",              // light | dark | system — light is the default brand look
  fontSize: "medium",          // small | medium | large
  responseDetail: "standard",  // concise | standard | detailed
  variantDefault: "collapsed", // collapsed | expanded
  defaultSort: "default",      // default | pathogenic_first | frequency
  apiKey: "",                  // optional user-supplied Anthropic key
};

const FONT_SIZE_MAP = { small: "14px", medium: "16px", large: "18px" };

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : { ...DEFAULT_SETTINGS };
  } catch { return { ...DEFAULT_SETTINGS }; }
}

function saveSettings(s) {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(s)); } catch {}
}

function applyFontSize(size) {
  document.documentElement.style.fontSize = FONT_SIZE_MAP[size] || "16px";
}

// Theme is a data-theme attribute on <html>; index.css defines the token values
// for each. "system" follows the OS preference and keeps following it, so a
// user who changes it mid-session sees the app update without a reload.
const prefersDark = () =>
  window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)").matches;

function resolveTheme(theme) {
  return theme === "system" ? (prefersDark() ? "dark" : "light") : (theme || "light");
}

/** Resolve a CSS custom property to a concrete colour.
 *  Needed for canvas/WebGL libraries (3Dmol, html2canvas) that parse colour
 *  strings themselves and have no idea what var() means. */
function cssVar(name, fallback) {
  return cssVarFrom(document.documentElement, name, fallback);
}

/** As cssVar, but resolved against a specific element.
 *  Needed wherever a subtree deliberately runs on a different palette than the
 *  document — PDF export forces light, and reading from documentElement there
 *  returns the on-screen theme's value instead. */
function cssVarFrom(el, name, fallback) {
  try {
    const v = getComputedStyle(el).getPropertyValue(name).trim();
    return v || fallback;
  } catch { return fallback; }
}

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", resolveTheme(theme));
}

const CATEGORY_META = {
  pharmacogenomics: { label: "Pharmacogenomics",     color: "var(--violet-faint)", bg: "rgb(var(--c-indigo) / 0.12)",  border: "rgb(var(--c-indigo) / 0.25)" },
  cardiovascular:   { label: "Cardiovascular",        color: "var(--danger)", bg: "rgb(var(--c-danger) / 0.1)",   border: "rgb(var(--c-danger) / 0.2)" },
  neurological:     { label: "Neurological",          color: "var(--violet)", bg: "rgb(var(--c-violet) / 0.12)", border: "rgb(var(--c-violet) / 0.25)" },
  cancer:           { label: "Cancer Risk",            color: "var(--warning-soft)", bg: "rgb(var(--c-warning) / 0.1)",  border: "rgb(var(--c-warning) / 0.2)" },
  hereditary:       { label: "Hereditary Conditions", color: "var(--success)", bg: "rgb(var(--c-success) / 0.1)",  border: "rgb(var(--c-success) / 0.2)" },
  metabolism:       { label: "Metabolism",             color: "var(--warning)", bg: "rgb(var(--c-warning) / 0.1)",  border: "rgb(var(--c-warning) / 0.2)" },
};

function DNASummaryDashboard({ dnaData, onQuery }) {
  const summary = computeDnaSummary(dnaData);
  const [expanded, setExpanded] = useState(null);
  if (!summary || summary.totalFound === 0) return null;

  const categories = Object.keys(summary.byCategory);

  return (
    <div style={{ maxWidth: 760, width: "100%", marginTop: 28 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
        <span style={{ fontSize: "1rem" }}>🧬</span>
        <p style={{ fontSize: "0.78rem", fontWeight: 700, color: "var(--text-faint)", margin: 0, textTransform: "uppercase", letterSpacing: "0.07em" }}>
          Your DNA — {summary.totalFound} notable variant{summary.totalFound !== 1 ? "s" : ""} found
        </p>
        <span style={{ fontSize: "0.65rem", color: "var(--text-dimmer)", marginLeft: "auto" }}>educational only · not medical advice</span>
      </div>

      {/* Category pills */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
        {categories.map(cat => {
          const meta = CATEGORY_META[cat];
          const count = summary.byCategory[cat].length;
          const isActive = expanded === cat;
          return (
            <button
              key={cat}
              onClick={() => setExpanded(isActive ? null : cat)}
              style={{ display: "flex", alignItems: "center", gap: 6, padding: "0.3rem 0.75rem", borderRadius: 100, background: isActive ? meta.bg : "rgb(var(--c-deep) / 0.5)", border: `1px solid ${isActive ? meta.border : "rgb(var(--c-border) / 0.35)"}`, cursor: "pointer", transition: "all 0.15s" }}
            >
              <span style={{ fontSize: "0.7rem", fontWeight: 600, color: isActive ? meta.color : "var(--text-dimmer)" }}>{meta.label}</span>
              <span style={{ fontSize: "0.62rem", padding: "0.05em 0.4em", borderRadius: 4, background: isActive ? meta.bg : "rgb(var(--c-surface) / 0.5)", color: isActive ? meta.color : "var(--text-disabled)", border: `1px solid ${isActive ? meta.border : "rgb(var(--c-border) / 0.3)"}` }}>{count}</span>
            </button>
          );
        })}
      </div>

      {/* Expanded category findings */}
      {expanded && summary.byCategory[expanded] && (
        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 4 }}>
          {summary.byCategory[expanded].map(f => {
            const meta = CATEGORY_META[f.category];
            return (
              <button
                key={f.rsid}
                onClick={() => onQuery(f.gene)}
                style={{ display: "flex", alignItems: "flex-start", gap: 12, padding: "0.75rem 1rem", borderRadius: 12, background: "rgb(var(--c-deep) / 0.5)", border: `1px solid ${meta.border}`, cursor: "pointer", textAlign: "left", transition: "border-color 0.15s", width: "100%" }}
                onMouseEnter={e => e.currentTarget.style.background = meta.bg}
                onMouseLeave={e => e.currentTarget.style.background = "rgb(var(--c-deep) / 0.5)"}
              >
                <div style={{ flexShrink: 0, marginTop: 2 }}>
                  <span style={{ fontFamily: "monospace", fontSize: "0.7rem", padding: "0.15em 0.5em", borderRadius: 5, background: f.hasRisk ? meta.bg : "rgb(var(--c-surface) / 0.5)", color: f.hasRisk ? meta.color : "var(--text-dimmer)", border: `1px solid ${f.hasRisk ? meta.border : "rgb(var(--c-border) / 0.3)"}` }}>
                    {f.genotype}
                  </span>
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <span style={{ fontSize: "0.78rem", fontWeight: 700, color: meta.color }}>{f.gene}</span>
                    <span style={{ fontSize: "0.7rem", color: "var(--text-dimmer)" }}>{f.name}</span>
                    <span style={{ fontFamily: "monospace", fontSize: "0.65rem", color: "var(--text-faintest)" }}>{f.rsid}</span>
                  </div>
                  <p style={{ fontSize: "0.72rem", color: "var(--text-dim)", marginTop: 3, lineHeight: 1.5 }}>{f.desc}</p>
                </div>
                <span style={{ fontSize: "0.65rem", color: "var(--text-faintest)", flexShrink: 0, marginTop: 2 }}>Ask →</span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── 3D Protein Viewer (AlphaFold) ───────────────────────────────────────────

function load3Dmol() {
  return new Promise((resolve) => {
    if (window.$3Dmol) { resolve(); return; }
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/3Dmol/2.0.1/3Dmol-min.js";
    s.onload = resolve;
    document.head.appendChild(s);
  });
}

const REPRESENTATIONS = ["Cartoon", "Surface", "Stick", "Ball+Stick", "Sphere"];
const COLOR_SCHEMES = ["pLDDT", "Secondary Structure", "Chain", "Hydrophobicity", "Spectrum"];

function applyStyle(viewer, rep, scheme) {
  viewer.setStyle({}, {});
  try { viewer.removeAllSurfaces(); } catch {}
  const colorscheme = (() => {
    if (scheme === "pLDDT") return { prop: "b", gradient: "linear", colors: ["#FF7D45","#FFDB13","#65CBF3","#0053D6"], min: 0, max: 100 };
    if (scheme === "Secondary Structure") return "ssJmol";
    if (scheme === "Chain") return "chainHetatm";
    if (scheme === "Hydrophobicity") return "hydrophobicity";
    return "spectrum";
  })();

  if (rep === "Cartoon") {
    viewer.setStyle({}, { cartoon: { colorscheme } });
  } else if (rep === "Surface") {
    viewer.setStyle({}, { cartoon: { colorscheme, opacity: 0.3 } });
    viewer.addSurface(window.$3Dmol.SurfaceType.VDW, { opacity: 0.75, colorscheme }, {});
  } else if (rep === "Stick") {
    viewer.setStyle({}, { stick: { colorscheme, radius: 0.15 } });
  } else if (rep === "Ball+Stick") {
    viewer.setStyle({}, { stick: { colorscheme, radius: 0.1 }, sphere: { colorscheme, scale: 0.3 } });
  } else if (rep === "Sphere") {
    viewer.setStyle({}, { sphere: { colorscheme, scale: 0.5 } });
  }
  viewer.render();
}

function generatePymolScript(pdbUrl, geneName) {
  const filename = pdbUrl.split("/").pop() || `${geneName}.pdb`;
  return `# PyMOL script for ${geneName}
# Generated by MyDNA

# Fetch structure
load ${pdbUrl}, ${geneName}

# Background and display settings
bg_color black
set ray_opaque_background, off

# Color by B-factor (pLDDT confidence)
spectrum b, blue_white_red, ${geneName}, minimum=0, maximum=100

# Set representation
hide everything, ${geneName}
show cartoon, ${geneName}

# Coloring reference:
# Blue  = High confidence (pLDDT > 90)
# White = Medium confidence (pLDDT 50-90)
# Red   = Low confidence  (pLDDT < 50)

# Optional: show as surface
# show surface, ${geneName}
# set transparency, 0.3, ${geneName}

# Zoom to fit
zoom ${geneName}
ray 1200, 900
`;
}

function ProteinViewer({ pdbUrl, geneName, entryId }) {
  const containerRef = useRef(null);
  const viewerRef = useRef(null);
  const [status, setStatus] = useState("loading");
  const [spinning, setSpinning] = useState(true);
  const [rep, setRep] = useState("Cartoon");
  const [scheme, setScheme] = useState("pLDDT");

  useEffect(() => {
    if (!pdbUrl || !containerRef.current) return;
    let cancelled = false;

    load3Dmol().then(() => {
      if (cancelled || !containerRef.current) return;
      try {
        const viewer = window.$3Dmol.createViewer(containerRef.current, {
          backgroundColor: cssVar("--bg-panel", "#ffffff"),
          antialias: true,
          preserveDrawingBuffer: true,
        });
        viewerRef.current = viewer;
        viewerRegistry.set(geneName, viewer);

        fetch(pdbUrl)
          .then(r => r.text())
          .then(pdbData => {
            if (cancelled) return;
            viewer.addModel(pdbData, "pdb");
            applyStyle(viewer, "Cartoon", "pLDDT");
            viewer.zoomTo();
            viewer.spin(true);
            setStatus("ready");
          })
          .catch(() => { if (!cancelled) setStatus("error"); });
      } catch {
        if (!cancelled) setStatus("error");
      }
    });

    return () => {
      cancelled = true;
      if (viewerRef.current) {
        try { viewerRef.current.spin(false); } catch {}
        viewerRegistry.delete(geneName);
      }
    };
  }, [pdbUrl]);

  const handleRep = (newRep) => {
    setRep(newRep);
    if (!viewerRef.current) return;
    try { applyStyle(viewerRef.current, newRep, scheme); } catch {}
  };

  const handleScheme = (newScheme) => {
    setScheme(newScheme);
    if (!viewerRef.current) return;
    try { applyStyle(viewerRef.current, rep, newScheme); } catch {}
  };

  const toggleSpin = () => {
    if (!viewerRef.current) return;
    try { viewerRef.current.spin(!spinning); viewerRef.current.render(); } catch {}
    setSpinning(s => !s);
  };

  const resetView = () => {
    if (!viewerRef.current) return;
    try {
      applyStyle(viewerRef.current, "Cartoon", "pLDDT");
      viewerRef.current.zoomTo();
    } catch {}
    setRep("Cartoon");
    setScheme("pLDDT");
  };

  const downloadPymol = () => {
    const script = generatePymolScript(pdbUrl, geneName);
    const blob = new Blob([script], { type: "text/plain" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `${geneName}_mydna.pml`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const openChimeraX = () => {
    window.open(`chimerax://open?url=${encodeURIComponent(pdbUrl)}`, "_self");
  };

  const btnStyle = (active) => ({
    fontSize: "0.68rem", padding: "0.2rem 0.55rem", borderRadius: 5, cursor: "pointer",
    background: active ? "rgb(var(--c-accent) / 0.25)" : "rgb(var(--c-surface) / 0.7)",
    border: `1px solid ${active ? "rgb(var(--c-accent) / 0.6)" : "rgb(var(--c-border) / 0.4)"}`,
    color: active ? "var(--accent)" : "var(--text-faint)",
    transition: "all 0.15s",
  });

  const actionBtnStyle = {
    fontSize: "0.68rem", padding: "0.2rem 0.55rem", borderRadius: 5, cursor: "pointer",
    background: "rgb(var(--c-surface) / 0.7)", border: "1px solid rgb(var(--c-border) / 0.4)",
    color: "var(--text-faint)", textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 3,
  };

  return (
    <div style={{ marginTop: "1rem", background: "rgb(var(--c-deep) / 0.8)", border: "1px solid rgb(var(--c-accent) / 0.2)", borderRadius: 12, overflow: "hidden" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0.6rem 0.875rem", borderBottom: "1px solid rgb(var(--c-accent) / 0.1)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: "0.78rem", fontWeight: 600, color: "var(--accent)" }}>{geneName} — 3D Structure</span>
          {entryId && <span style={{ fontSize: "0.65rem", color: "var(--text-faintest)", fontFamily: "monospace" }}>{entryId}</span>}
        </div>
        {status === "ready" && (
          <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <button onClick={toggleSpin} style={actionBtnStyle}>{spinning ? "⏸" : "▶"} {spinning ? "Stop" : "Spin"}</button>
            <button onClick={resetView} style={actionBtnStyle}>⟳ Reset</button>
          </div>
        )}
      </div>

      {/* Representation toggles */}
      {status === "ready" && (
        <div style={{ padding: "0.45rem 0.875rem", borderBottom: "1px solid rgb(var(--c-accent) / 0.07)", display: "flex", flexWrap: "wrap", gap: 5, alignItems: "center" }}>
          <span style={{ fontSize: "0.65rem", color: "var(--text-dimmer)", marginRight: 4 }}>View:</span>
          {REPRESENTATIONS.map(r => (
            <button key={r} onClick={() => handleRep(r)} style={btnStyle(rep === r)}>{r}</button>
          ))}
          <span style={{ fontSize: "0.65rem", color: "var(--text-dimmer)", marginLeft: 8, marginRight: 4 }}>Color:</span>
          {COLOR_SCHEMES.map(s => (
            <button key={s} onClick={() => handleScheme(s)} style={btnStyle(scheme === s)}>{s}</button>
          ))}
        </div>
      )}

      {/* 3D Canvas */}
      <div style={{ position: "relative", height: 340 }}>
        <div ref={containerRef} style={{ width: "100%", height: "100%" }} />
        {status === "loading" && (
          <div style={{ position: "absolute", inset: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10 }}>
            <div style={{ width: 28, height: 28, borderRadius: "50%", border: "2px solid var(--accent-strong)", borderTopColor: "transparent", animation: "spin 0.8s linear infinite" }} />
            <p style={{ fontSize: "0.75rem", color: "var(--text-dimmer)" }}>Loading AlphaFold structure…</p>
          </div>
        )}
        {status === "error" && (
          <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <p style={{ fontSize: "0.75rem", color: "var(--text-dimmer)" }}>Structure unavailable for this protein</p>
          </div>
        )}
      </div>

      {/* Footer: legend + export */}
      {status === "ready" && (
        <div style={{ padding: "0.5rem 0.875rem", borderTop: "1px solid rgb(var(--c-accent) / 0.1)" }}>
          {scheme === "pLDDT" && (
            <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: "0.4rem" }}>
              <span style={{ fontSize: "0.65rem", color: "var(--text-dimmer)" }}>pLDDT:</span>
              {[["#0053D6","Very high >90"], ["#65CBF3","High 70–90"], ["#FFDB13","Medium 50–70"], ["#FF7D45","Low <50"]].map(([color, label]) => (
                <div key={label} style={{ display: "flex", alignItems: "center", gap: 4 }}>
                  <div style={{ width: 8, height: 8, borderRadius: 2, background: color }} />
                  <span style={{ fontSize: "0.63rem", color: "var(--text-dimmer)" }}>{label}</span>
                </div>
              ))}
            </div>
          )}
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
            <span style={{ fontSize: "0.63rem", color: "var(--text-faintest)" }}>Export:</span>
            <a href={pdbUrl} download target="_blank" rel="noreferrer" style={actionBtnStyle}>↓ PDB file</a>
            <button onClick={downloadPymol} style={actionBtnStyle} title="Download PyMOL script to open in PyMOL desktop app">↓ PyMOL script (.pml)</button>
            <button onClick={openChimeraX} style={actionBtnStyle} title="Opens in ChimeraX if installed locally">⬡ Open in ChimeraX</button>
            <span style={{ marginLeft: "auto", fontSize: "0.62rem", color: "var(--text-faintest)" }}>AlphaFold DB</span>
          </div>
        </div>
      )}
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

// ─── Settings Panel ───────────────────────────────────────────────────────────

function SettingSegment({ value, options, onChange }) {
  return (
    <div style={{ display: "flex", gap: 4 }}>
      {options.map(opt => {
        const active = value === opt.value;
        return (
          <button key={opt.value} onClick={() => onChange(opt.value)}
            style={{ flex: 1, padding: "0.35rem 0.5rem", borderRadius: 8, fontSize: "0.72rem", fontWeight: active ? 600 : 400, cursor: "pointer", transition: "all 0.15s", border: `1px solid ${active ? "rgb(var(--c-accent) / 0.4)" : "rgb(var(--c-border) / 0.35)"}`, background: active ? "rgb(var(--c-accent) / 0.12)" : "rgb(var(--c-deep) / 0.5)", color: active ? "var(--accent)" : "var(--text-dimmer)" }}>
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

function SettingsPanel({ settings, onChange, onClose, currentUser, onUserRefresh }) {
  const [keyDraft, setKeyDraft] = useState("");
  const [keySaving, setKeySaving] = useState(false);

  const set = (key, val) => {
    const next = { ...settings, [key]: val };
    onChange(next);
    saveSettings(next);
    if (key === "fontSize") applyFontSize(val);
  };

  const saveServerKey = async () => {
    const trimmed = keyDraft.trim();
    if (!trimmed) return;
    setKeySaving(true);
    try {
      const r = await apiFetch("/user/api-key", { method: "POST", body: JSON.stringify({ api_key: trimmed }) });
      if (r.ok) { setKeyDraft(""); onUserRefresh(); }
      else { const e = await r.json(); alert(e.detail || "Failed to save key"); }
    } catch { alert("Network error saving key"); }
    finally { setKeySaving(false); }
  };

  const removeServerKey = async () => {
    try {
      await apiFetch("/user/api-key", { method: "DELETE" });
      onUserRefresh();
    } catch {}
  };

  return (
    <>
      {/* Backdrop */}
      <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 300, background: "rgb(var(--c-shadow) / 0.5)" }} />
      {/* Drawer */}
      <div style={{ position: "fixed", top: 0, right: 0, bottom: 0, zIndex: 301, width: 320, maxWidth: "100vw", background: "var(--bg-elevated)", borderLeft: "1px solid rgb(var(--c-surface) / 0.8)", display: "flex", flexDirection: "column", boxShadow: "-8px 0 32px rgb(var(--c-shadow) / 0.4)", animation: "slideInRight 0.2s ease-out" }}>
        <style>{`@keyframes slideInRight { from { transform: translateX(100%); } to { transform: translateX(0); } }`}</style>

        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "1rem 1.25rem", borderBottom: "1px solid rgb(var(--c-surface) / 0.6)", flexShrink: 0 }}>
          <p style={{ fontSize: "0.9rem", fontWeight: 700, color: "var(--text)", margin: 0 }}>Settings</p>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "var(--text-dimmer)", cursor: "pointer", fontSize: "1.2rem", lineHeight: 1, padding: 4 }}>×</button>
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflowY: "auto", padding: "1.25rem" }}>

          <Section label="Appearance" hint="Light is the default; system follows your OS setting">
            <SettingSegment value={settings.theme}
              options={[{ value: "light", label: "Light" }, { value: "dark", label: "Dark" }, { value: "system", label: "System" }]}
              onChange={v => set("theme", v)} />
          </Section>

          <Section label="Text Size" hint="Adjusts all text across the app">
            <SettingSegment value={settings.fontSize}
              options={[{ value: "small", label: "Small" }, { value: "medium", label: "Medium" }, { value: "large", label: "Large" }]}
              onChange={v => set("fontSize", v)} />
          </Section>

          <Section label="AI Response Detail" hint="Controls how thorough Claude's explanations are">
            <SettingSegment value={settings.responseDetail}
              options={[{ value: "concise", label: "Concise" }, { value: "standard", label: "Standard" }, { value: "detailed", label: "Detailed" }]}
              onChange={v => set("responseDetail", v)} />
            <p style={{ fontSize: "0.68rem", color: "var(--text-faintest)", marginTop: 6, lineHeight: 1.5 }}>
              {settings.responseDetail === "concise" && "Shorter summaries focused on key findings only."}
              {settings.responseDetail === "standard" && "Balanced explanations with clinical context and follow-up suggestions."}
              {settings.responseDetail === "detailed" && "In-depth analysis including population genetics, mechanisms, and research context."}
            </p>
          </Section>

          <Section label="Variant Cards" hint="Default state when results load">
            <SettingSegment value={settings.variantDefault}
              options={[{ value: "collapsed", label: "Collapsed" }, { value: "expanded", label: "Expanded" }]}
              onChange={v => set("variantDefault", v)} />
          </Section>

          <Section label="Default Variant Sort" hint="Applied whenever a gene query loads">
            <SettingSegment value={settings.defaultSort}
              options={[{ value: "default", label: "Default" }, { value: "pathogenic_first", label: "Pathogenic" }, { value: "frequency", label: "Rarest" }]}
              onChange={v => set("defaultSort", v)} />
          </Section>

          <PlanSection currentUser={currentUser} />

          <Section label="Your Anthropic API Key" hint="Use your own key — bypasses the query limit. Stored encrypted on your account.">
            {!currentUser?.has_stored_key && !currentUser?.byok_purchased ? (
              <p style={{ fontSize: "0.72rem", color: "var(--text-faint)", margin: 0, lineHeight: 1.55 }}>
                Bringing your own key is a one-time purchase — see{" "}
                <strong style={{ color: "var(--text-muted)" }}>Buy Queries</strong> above. Once purchased you can
                store an Anthropic key here and run unlimited queries billed to your own account.
              </p>
            ) : currentUser?.has_stored_key ? (
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: "0.72rem", color: "var(--success)", flex: 1 }}>✓ Key stored on your account</span>
                <button onClick={removeServerKey}
                  style={{ fontSize: "0.68rem", color: "var(--danger)", background: "none", border: "1px solid rgb(var(--c-danger) / 0.3)", borderRadius: 6, padding: "0.2rem 0.5rem", cursor: "pointer" }}>
                  Remove
                </button>
              </div>
            ) : (
              <div style={{ display: "flex", gap: 6 }}>
                <input
                  type="password"
                  value={keyDraft}
                  onChange={e => setKeyDraft(e.target.value)}
                  onKeyDown={e => e.key === "Enter" && saveServerKey()}
                  placeholder="sk-ant-..."
                  style={{ flex: 1, fontSize: "0.72rem", background: "rgb(var(--c-deep) / 0.7)", border: "1px solid rgb(var(--c-border) / 0.4)", borderRadius: 6, padding: "0.35rem 0.6rem", color: "var(--text-muted)", outline: "none" }}
                />
                <button onClick={saveServerKey} disabled={!keyDraft.trim() || keySaving}
                  style={{ fontSize: "0.68rem", color: keyDraft.trim() ? "var(--accent)" : "var(--text-disabled)", background: "none", border: `1px solid ${keyDraft.trim() ? "rgb(var(--c-accent) / 0.4)" : "rgb(var(--c-border) / 0.3)"}`, borderRadius: 6, padding: "0.35rem 0.65rem", cursor: keyDraft.trim() ? "pointer" : "default" }}>
                  {keySaving ? "…" : "Save"}
                </button>
              </div>
            )}
            <p style={{ fontSize: "0.65rem", color: "var(--text-dimmer)", marginTop: 6, lineHeight: 1.5 }}>
              Get a key at console.anthropic.com. Encrypted and never returned to the client.
            </p>
          </Section>

          <YourDataSection currentUser={currentUser} />

        </div>

        {/* Footer */}
        <div style={{ padding: "0.875rem 1.25rem", borderTop: "1px solid rgb(var(--c-surface) / 0.5)", flexShrink: 0 }}>
          <p style={{ fontSize: "0.65rem", color: "var(--text-dimmer)", margin: "0 0 8px", lineHeight: 1.5 }}>Preferences are saved locally in your browser and never sent to our servers.</p>
          <button onClick={() => { onChange({ ...DEFAULT_SETTINGS }); saveSettings(DEFAULT_SETTINGS); applyFontSize(DEFAULT_SETTINGS.fontSize); applyTheme(DEFAULT_SETTINGS.theme); }}
            style={{ fontSize: "0.68rem", color: "var(--text-faintest)", background: "none", border: "1px solid rgb(var(--c-border) / 0.35)", borderRadius: 6, padding: "0.25rem 0.6rem", cursor: "pointer" }}>
            Reset to defaults
          </button>
        </div>
      </div>
    </>
  );
}

/** Purchase buttons — rendered anywhere a user might want to buy, not only at the paywall. */
function PurchaseOptions({ compact, testMode, currentUserHasBilling }) {
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  // Prices come from Stripe, not from constants here. Hardcoding them means the
  // UI keeps quoting the old figure after a pricing change — which is exactly
  // what happened when Unlimited moved from $5 one-time to $10/month.
  const [prices, setPrices] = useState(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch("/billing/prices")
      .then(r => (r.ok ? r.json() : null))
      .then(d => { if (!cancelled && d) setPrices(d); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const buy = async (type) => {
    setError(null);
    setBusy(type);
    await startCheckout(type, (msg) => { setError(msg); setBusy(null); });
  };

  const opt = (key, title, blurb) => {
    const p = prices?.[key];
    if (prices && !p) return null;          // not configured in this mode
    const busyThis = busy === key;
    return (
      <button key={key} onClick={() => buy(key)} disabled={!!busy}
        style={{ padding: compact ? "0.6rem 0.75rem" : "0.8rem 1rem", borderRadius: 10,
                 background: key === "unlock"
                   ? "linear-gradient(135deg,rgb(var(--c-accent) / 0.15),rgb(var(--c-violet) / 0.15))"
                   : "rgb(var(--c-surface) / 0.5)",
                 border: `1px solid ${key === "unlock" ? "rgb(var(--c-accent) / 0.35)" : "rgb(var(--c-border) / 0.4)"}`,
                 cursor: busy ? "default" : "pointer", textAlign: "left",
                 opacity: busy && !busyThis ? 0.5 : 1, width: "100%" }}>
        <div style={{ display: "flex", alignItems: "baseline", gap: 6, marginBottom: 3, flexWrap: "wrap" }}>
          <span style={{ fontSize: compact ? "0.78rem" : "0.85rem", fontWeight: 700,
                         color: key === "unlock" ? "var(--accent)" : "var(--text-muted)" }}>
            {busyThis ? "Opening checkout…" : title}
          </span>
          {!busyThis && p && (
            <span style={{ fontSize: "0.72rem", fontWeight: 600, color: "var(--text-faint)" }}>— {p.label}</span>
          )}
        </div>
        <div style={{ fontSize: "0.7rem", color: "var(--text-faint)", lineHeight: 1.45 }}>{blurb}</div>
      </button>
    );
  };

  return (
    <div>
      {testMode && (
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 10, padding: "0.45rem 0.6rem", borderRadius: 8, background: "rgb(var(--c-warning) / 0.1)", border: "1px solid rgb(var(--c-warning) / 0.35)" }}>
          <span style={{ fontSize: "0.7rem", fontWeight: 700, color: "var(--warning)" }}>TEST MODE</span>
          <span style={{ fontSize: "0.68rem", color: "var(--text-faint)" }}>
            No real charge — use card 4242 4242 4242 4242
          </span>
        </div>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {opt("unlock", "Unlimited",
             prices?.unlock?.recurring
               ? "Unlimited queries every month, billed on your own card. Cancel any time."
               : "Unlimited queries.")}
        {opt("credits", "50 Queries",
             "A one-time top-up. No subscription, no renewal.")}
        {opt("byok", "Bring Your Own Key",
             "Store your own Anthropic API key and run unlimited queries billed directly to your Anthropic account. One-time purchase.")}
      </div>
      {currentUserHasBilling && (
        <button onClick={() => openBillingPortal(setError)}
          style={{ marginTop: 10, width: "100%", padding: "0.5rem", borderRadius: 8, background: "none",
                   border: "1px solid rgb(var(--c-border) / 0.45)", cursor: "pointer",
                   fontSize: "0.72rem", color: "var(--text-muted)" }}>
          Manage subscription &amp; payment method →
        </button>
      )}
      {error && (
        <p style={{ fontSize: "0.68rem", color: "var(--danger)", margin: "8px 0 0", lineHeight: 1.5 }}>{error}</p>
      )}
    </div>
  );
}

/** Plan status + usage meter + purchase options. Used in Settings. */
function PlanSection({ currentUser }) {
  const plan = getPlan(currentUser);

  if (!currentUser) {
    return (
      <Section label="Plan">
        <p style={{ fontSize: "0.72rem", color: "var(--text-dim)", margin: 0, lineHeight: 1.5 }}>
          Sign in to view your usage and purchase queries.
        </p>
      </Section>
    );
  }

  return (
    <>
      <Section label="Plan & Usage">
        <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: plan.kind === "free" ? 7 : 0 }}>
          <span style={{ width: 7, height: 7, borderRadius: "50%", background: plan.color, flexShrink: 0 }} />
          <span style={{ fontSize: "0.74rem", color: plan.kind === "free" ? "var(--text-muted)" : plan.color }}>{plan.label}</span>
        </div>
        {plan.kind === "free" && (
          <div style={{ height: 4, background: "rgb(var(--c-border) / 0.4)", borderRadius: 2, overflow: "hidden" }}>
            <div style={{ height: "100%", borderRadius: 2, background: plan.left === 0 ? "var(--danger)" : "linear-gradient(90deg,var(--accent-strong),var(--violet-soft))", width: `${Math.min(100, (plan.used / plan.limit) * 100)}%`, transition: "width 0.3s" }} />
          </div>
        )}
        {currentUser.stored_key_unusable && (
          <p style={{ fontSize: "0.68rem", color: "var(--warning)", margin: "8px 0 0", lineHeight: 1.5 }}>
            Your saved API key can no longer be read — please re-enter it below.
          </p>
        )}
      </Section>

      <Section
        label={plan.kind === "unlocked" ? "Add More" : "Buy Queries"}
        hint={plan.kind === "unlocked"
          ? "You already have unlimited access — credits aren't needed."
          : "Purchase any time. Credits are added the moment payment completes."}
      >
        <PurchaseOptions compact testMode={currentUser.stripe_test_mode} currentUserHasBilling={currentUser.has_billing_account} />
      </Section>
    </>
  );
}

/** Export and erasure, as buttons rather than as a promise in a policy.
 *
 *  GDPR Articles 15, 17 and 20, and the CCPA rights to know and delete. These
 *  could be fulfilled by hand on request — that is legitimate at this size —
 *  but a right that depends on someone remembering to run SQL is a weaker
 *  right than one the reader can exercise themselves at 2am without asking.
 *
 *  Deletion is guarded by typing the word rather than by an "are you sure",
 *  because it is genuinely irreversible and a mis-click should not be enough. */
function YourDataSection({ currentUser }) {
  const [busy, setBusy] = useState(null);      // "export" | "delete" | null
  const [confirm, setConfirm] = useState("");
  const [armed, setArmed] = useState(false);
  const [error, setError] = useState(null);

  if (!currentUser) return null;

  const exportData = async () => {
    setBusy("export"); setError(null);
    try {
      const r = await fetch(`${API}/user/export`, { headers: authHeaders() });
      if (!r.ok) throw new Error(`Export failed (${r.status})`);
      const blob = new Blob([JSON.stringify(await r.json(), null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `mydna-data-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      setError(e.message || "Could not export your data");
    } finally {
      setBusy(null);
    }
  };

  const deleteAccount = async () => {
    setBusy("delete"); setError(null);
    try {
      const r = await fetch(`${API}/user/account`, { method: "DELETE", headers: authHeaders() });
      if (!r.ok) throw new Error(`Deletion failed (${r.status})`);
      const body = await r.json();
      clearToken();
      // A full reload rather than clearing state piecemeal: the account this
      // session was built around no longer exists.
      window.alert(
        body.subscription_needs_cancelling
          ? "Your account has been deleted.\n\nYou had an active subscription — cancel it in Stripe as well. Deleting the account removes our record of it but does not stop billing."
          : "Your account and all of its data have been deleted.",
      );
      window.location.href = "/";
    } catch (e) {
      setError(e.message || "Could not delete your account");
      setBusy(null);
    }
  };

  return (
    <Section label="Your Data" hint="Export or erase everything held about your account">
      <button onClick={exportData} disabled={!!busy}
        style={{ width: "100%", fontSize: "0.72rem", padding: "0.45rem", borderRadius: 8,
                 background: "rgb(var(--c-surface) / 0.5)", border: "1px solid rgb(var(--c-border) / 0.4)",
                 color: "var(--text-muted)", cursor: busy ? "default" : "pointer" }}>
        {busy === "export" ? "Preparing…" : "Download my data"}
      </button>
      <p style={{ fontSize: "0.63rem", color: "var(--text-dimmer)", margin: "5px 0 0", lineHeight: 1.5 }}>
        Everything we hold about your account, as JSON. Your DNA file is not
        included because it is never stored.
      </p>

      <div style={{ marginTop: 14, paddingTop: 12, borderTop: "1px solid rgb(var(--c-border) / 0.3)" }}>
        {!armed ? (
          <button onClick={() => setArmed(true)}
            style={{ width: "100%", fontSize: "0.72rem", padding: "0.45rem", borderRadius: 8,
                     background: "none", border: "1px solid rgb(var(--c-danger) / 0.4)",
                     color: "var(--danger)", cursor: "pointer" }}>
            Delete my account
          </button>
        ) : (
          <>
            <p style={{ fontSize: "0.68rem", color: "var(--text-muted)", margin: "0 0 7px", lineHeight: 1.55 }}>
              This erases your account, your questions and your projects
              immediately. It cannot be undone. Type <strong>DELETE</strong> to
              confirm.
            </p>
            <input value={confirm} onChange={e => setConfirm(e.target.value)}
              placeholder="DELETE" autoComplete="off"
              style={{ width: "100%", padding: "0.4rem 0.55rem", borderRadius: 7, fontSize: "0.72rem",
                       background: "rgb(var(--c-surface) / 0.5)", border: "1px solid rgb(var(--c-border) / 0.45)",
                       color: "var(--text)", marginBottom: 7 }} />
            <div style={{ display: "flex", gap: 6 }}>
              <button onClick={deleteAccount} disabled={confirm !== "DELETE" || !!busy}
                style={{ flex: 1, fontSize: "0.72rem", padding: "0.45rem", borderRadius: 8,
                         background: confirm === "DELETE" ? "var(--danger)" : "rgb(var(--c-border) / 0.35)",
                         border: "none", color: confirm === "DELETE" ? "white" : "var(--text-disabled)",
                         cursor: confirm === "DELETE" && !busy ? "pointer" : "not-allowed" }}>
                {busy === "delete" ? "Deleting…" : "Delete permanently"}
              </button>
              <button onClick={() => { setArmed(false); setConfirm(""); }}
                style={{ fontSize: "0.72rem", padding: "0.45rem 0.7rem", borderRadius: 8, background: "none",
                         border: "1px solid rgb(var(--c-border) / 0.4)", color: "var(--text-dim)", cursor: "pointer" }}>
                Cancel
              </button>
            </div>
          </>
        )}
        {currentUser.byok_unlocked && armed && (
          <p style={{ fontSize: "0.63rem", color: "var(--warning)", margin: "7px 0 0", lineHeight: 1.5 }}>
            You have an active subscription. Cancel it in Stripe as well —
            deleting the account does not stop billing.
          </p>
        )}
      </div>

      {error && <p style={{ fontSize: "0.65rem", color: "var(--danger)", margin: "7px 0 0" }}>{error}</p>}
    </Section>
  );
}

function Section({ label, hint, children }) {
  return (
    <div style={{ marginBottom: "1.5rem" }}>
      <p style={{ fontSize: "0.72rem", fontWeight: 700, color: "var(--text-faint)", textTransform: "uppercase", letterSpacing: "0.07em", margin: "0 0 3px" }}>{label}</p>
      {hint && <p style={{ fontSize: "0.67rem", color: "var(--text-faintest)", margin: "0 0 10px", lineHeight: 1.4 }}>{hint}</p>}
      {children}
    </div>
  );
}

// ─── Sign-in Gate Modal (anonymous query limit) ───────────────────────────────

/** @param reason — "queries" when the free preview is spent, "dna" when someone
 *  tries to load a DNA file. The DNA case is not a paywall and must not read
 *  like one: it exists because processing genetic data requires consent that
 *  can be evidenced, and consent is recorded against an account. */
function SignInGateModal({ onClose, reason = "queries" }) {
  const dna = reason === "dna";
  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 400, background: "rgb(var(--c-shadow) / 0.7)" }} />
      <div style={{ position: "fixed", top: "50%", left: "50%", transform: "translate(-50%,-50%)", zIndex: 401, background: "var(--bg-elevated)", border: "1px solid rgb(var(--c-border) / 0.6)", borderRadius: 16, padding: "2rem", width: 360, maxWidth: "calc(100vw - 2rem)", boxShadow: "0 24px 64px rgb(var(--c-shadow) / 0.6)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "0.75rem" }}>
          <h2 style={{ fontSize: "1.05rem", fontWeight: 700, color: "var(--text)", margin: 0 }}>
            {dna ? "Sign in to use your DNA" : "Sign in to continue"}
          </h2>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "var(--text-dimmer)", cursor: "pointer", fontSize: "1.2rem", lineHeight: 1, padding: 4 }}>×</button>
        </div>
        {dna ? (
          <p style={{ fontSize: "0.78rem", color: "var(--text-dim)", margin: "0 0 1.25rem", lineHeight: 1.6 }}>
            Genetic data gets stricter treatment than everything else here, and
            we need a record that you agreed to it — which means an account to
            attach that record to.
            <br /><br />
            Your file still never leaves your device or gets stored. Signing in
            changes who consented, not what happens to the data.
          </p>
        ) : (
          <p style={{ fontSize: "0.78rem", color: "var(--text-dim)", margin: "0 0 1.25rem", lineHeight: 1.6 }}>
            You've used your {ANON_QUERY_LIMIT} free preview queries. Create a free account to get {20} queries — no credit card required.
          </p>
        )}
        <a href={`${API}/auth/google`} style={{ display: "block", padding: "0.75rem 1rem", borderRadius: 10, background: "linear-gradient(135deg,rgb(var(--c-accent) / 0.15),rgb(var(--c-violet) / 0.15))", border: "1px solid rgb(var(--c-accent) / 0.35)", cursor: "pointer", textAlign: "center", textDecoration: "none" }}>
          <span style={{ fontSize: "0.85rem", fontWeight: 700, color: "var(--accent)" }}>Sign in with Google — it's free</span>
        </a>
      </div>
    </>
  );
}

// ─── Upgrade / Billing Modal ──────────────────────────────────────────────────

/** Always-visible plan chip. Clicking it opens the purchase flow. */
function PlanBadge({ currentUser, onClick, mobile }) {
  if (!currentUser) return null;
  const plan = getPlan(currentUser);
  const interactive = plan.kind === "free" || plan.kind === "credits";
  const border = plan.kind === "free" && plan.left === 0 ? "rgb(var(--c-danger) / 0.45)" : "rgb(var(--c-border) / 0.4)";

  return (
    <button
      onClick={onClick}
      title={interactive ? `${plan.label} — click to buy more` : plan.label}
      style={{
        display: "flex", alignItems: "center", gap: 5,
        fontSize: mobile ? "0.66rem" : "0.72rem", color: plan.color,
        background: "rgb(var(--c-surface) / 0.6)", border: `1px solid ${border}`,
        borderRadius: 8, padding: mobile ? "0.22rem 0.45rem" : "0.3rem 0.6rem",
        cursor: "pointer", whiteSpace: "nowrap",
      }}
    >
      <span style={{ width: 6, height: 6, borderRadius: "50%", background: plan.color, flexShrink: 0 }} />
      {plan.short}
      {currentUser.stripe_test_mode && (
        <span style={{ color: "var(--warning)", fontSize: "0.82em", fontWeight: 700 }} title="Stripe test mode — purchases are not real">TEST</span>
      )}
      {interactive && <span style={{ color: "var(--text-dimmer)", fontSize: "0.9em" }}>+</span>}
    </button>
  );
}

function UpgradeModal({ currentUser, onClose, onOpenSettings, blocked }) {
  const plan = getPlan(currentUser);
  const used = currentUser?.total_queries || 0;
  const limit = currentUser?.free_limit || 20;
  const credits = currentUser?.query_credits || 0;

  // Reached either by hitting the limit (blocked) or by choosing to buy early.
  const title = blocked ? "You've used your free queries" : "Buy queries";

  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 400, background: "rgb(var(--c-shadow) / 0.7)" }} />
      <div style={{ position: "fixed", top: "50%", left: "50%", transform: "translate(-50%,-50%)", zIndex: 401, background: "var(--bg-elevated)", border: "1px solid rgb(var(--c-border) / 0.6)", borderRadius: 16, padding: "2rem", width: 380, maxWidth: "calc(100vw - 2rem)", boxShadow: "0 24px 64px rgb(var(--c-shadow) / 0.6)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "0.75rem" }}>
          <h2 style={{ fontSize: "1.05rem", fontWeight: 700, color: "var(--text)", margin: 0 }}>{title}</h2>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "var(--text-dimmer)", cursor: "pointer", fontSize: "1.2rem", lineHeight: 1, padding: 4 }}>×</button>
        </div>
        <p style={{ fontSize: "0.78rem", color: "var(--text-dim)", margin: "0 0 0.5rem", lineHeight: 1.6 }}>
          {plan.kind === "unlocked"
            ? "You already have unlimited access."
            : `You've used ${used} of ${limit} free queries${credits > 0 ? ` — ${credits} purchased credits remaining` : ""}. Choose how to continue:`}
        </p>

        <div style={{ margin: "1.25rem 0" }}>
          <PurchaseOptions testMode={currentUser?.stripe_test_mode} currentUserHasBilling={currentUser?.has_billing_account} />
        </div>

        {/* Only useful to someone who already bought the right to store a key but
            hasn't entered one — they're paid up and stuck. For everyone else the
            BYOK option above says the same thing, at its real price. */}
        {currentUser?.byok_purchased && !currentUser?.has_stored_key && (
          <p style={{ fontSize: "0.7rem", color: "var(--text-faintest)", margin: 0, lineHeight: 1.5 }}>
            You've already purchased Bring Your Own Key.{" "}
            <button onClick={() => { onClose(); onOpenSettings(); }}
              style={{ background: "none", border: "none", color: "var(--accent)", cursor: "pointer", fontSize: "0.7rem", padding: 0, textDecoration: "underline" }}>
              Add your Anthropic API key
            </button>{" "}in Settings to run unlimited queries, billed to your Anthropic account.
          </p>
        )}
      </div>
    </>
  );
}

// ─── DNA Upload UI Components ─────────────────────────────────────────────────

function ConsentModal({ onAccept, onClose }) {
  const [agreed, setAgreed] = useState(false);
  const [parsing, setParsing] = useState(false);
  const [error, setError] = useState(null);
  const fileRef = useRef(null);

  const handleFile = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setParsing(true);
    setError(null);
    try {
      const text = await file.text();
      const result = parseDNAFile(text);
      if (result.totalCount === 0) {
        setError("No variants found. Please upload a 23andMe, AncestryDNA, or VCF file.");
        setParsing(false);
        return;
      }
      onAccept(result, file.name);
    } catch {
      setError("Failed to parse file. Please check the format and try again.");
      setParsing(false);
    }
  };

  return (
    <div style={{ position: "fixed", inset: 0, background: "rgb(var(--c-shadow) / 0.75)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: "1rem" }}>
      <div style={{ background: "var(--bg-inset)", border: "1px solid rgb(var(--c-accent) / 0.25)", borderRadius: 16, padding: "1.75rem", maxWidth: 520, width: "100%", boxShadow: "0 25px 50px rgb(var(--c-shadow) / 0.6)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "1.25rem" }}>
          <div>
            <p style={{ fontSize: "1rem", fontWeight: 700, color: "var(--text)", margin: 0 }}>Upload DNA Data</p>
            <p style={{ fontSize: "0.72rem", color: "var(--text-dimmer)", marginTop: 3 }}>23andMe · AncestryDNA · VCF</p>
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "var(--text-dimmer)", cursor: "pointer", fontSize: "1.2rem", lineHeight: 1, padding: 4 }}>×</button>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: "1.25rem" }}>
          {[
            { icon: "🔒", title: "Processed in your browser", body: "Your file is parsed entirely on your device. The raw data never leaves your browser." },
            { icon: "🚫", title: "Nothing stored or transmitted", body: "Variants are held in browser session memory only and cleared automatically when you close the tab. They are never sent to our servers." },
            { icon: "💻", title: "Personal device only", body: "Do not upload your DNA data on a shared, public, or work computer. Session data persists until the tab is closed and could be accessed by the next user." },
            { icon: "⚕️", title: "Not medical advice", body: "This tool is for research and educational purposes. Consult a licensed genetic counselor for health decisions." },
          ].map(({ icon, title, body }) => (
            <div key={title} style={{ display: "flex", gap: 10, padding: "0.6rem 0.75rem", background: "rgb(var(--c-surface) / 0.4)", borderRadius: 10, border: "1px solid rgb(var(--c-border) / 0.3)" }}>
              <span style={{ fontSize: "0.95rem", flexShrink: 0, marginTop: 1 }}>{icon}</span>
              <div>
                <p style={{ fontSize: "0.73rem", fontWeight: 600, color: "var(--text-muted)", margin: 0 }}>{title}</p>
                <p style={{ fontSize: "0.68rem", color: "var(--text-dim)", marginTop: 2, lineHeight: 1.5 }}>{body}</p>
              </div>
            </div>
          ))}
        </div>

        <label style={{ display: "flex", alignItems: "flex-start", gap: 8, marginBottom: "1.25rem", cursor: "pointer" }}>
          <input type="checkbox" checked={agreed} onChange={e => setAgreed(e.target.checked)}
            style={{ width: 15, height: 15, marginTop: 2, accentColor: "var(--accent-strong)", flexShrink: 0 }} />
          <span style={{ fontSize: "0.72rem", color: "var(--text-faint)", lineHeight: 1.55 }}>
            I understand this tool does not provide medical diagnoses, and my raw genetic data will not be stored on any server, transmitted to any third party, or used for any purpose beyond this browser session. Data persists until I close this tab.
          </span>
        </label>

        {error && <p style={{ fontSize: "0.72rem", color: "var(--danger)", marginBottom: "0.75rem" }}>{error}</p>}

        <input ref={fileRef} type="file" accept=".txt,.csv,.vcf" style={{ display: "none" }} onChange={handleFile} />
        <button
          disabled={!agreed || parsing}
          onClick={() => fileRef.current?.click()}
          style={{ width: "100%", padding: "0.625rem", borderRadius: 10, background: agreed && !parsing ? "var(--accent-deep)" : "rgb(var(--c-border) / 0.4)", border: "none", color: agreed && !parsing ? "white" : "var(--text-disabled)", fontSize: "0.8rem", fontWeight: 600, cursor: agreed && !parsing ? "pointer" : "not-allowed", transition: "background 0.15s" }}
        >
          {parsing ? "Parsing file…" : "Choose File"}
        </button>
      </div>
    </div>
  );
}

function DNASessionBanner({ dnaData, onClear }) {
  if (!dnaData) return null;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "0.3rem 1.25rem", background: "rgb(var(--c-accent) / 0.35)", borderBottom: "1px solid rgb(var(--c-accent) / 0.1)", fontSize: "0.68rem", flexShrink: 0 }}>
      <span style={{ fontSize: "0.75rem" }}>🧬</span>
      <span style={{ color: "var(--accent)", fontWeight: 600 }}>DNA session active</span>
      <span style={{ color: "var(--text-dimmer)" }}>·</span>
      <span style={{ color: "var(--text-dimmer)" }}>{dnaData.totalCount.toLocaleString()} variants</span>
      <span style={{ color: "var(--text-dimmer)" }}>·</span>
      <span style={{ color: "var(--text-dimmer)" }}>{dnaData.format}</span>
      <span style={{ color: "var(--text-dimmer)" }}>·</span>
      <span style={{ color: "var(--text-dimmer)" }}>not stored · session only</span>
      <button onClick={onClear}
        style={{ marginLeft: "auto", background: "none", border: "none", color: "var(--text-faintest)", cursor: "pointer", fontSize: "0.9rem", padding: "0 2px", lineHeight: 1 }}
        title="Clear DNA data from session"
      >×</button>
    </div>
  );
}

const API = import.meta.env.VITE_API_URL || "http://localhost:8000";

// ── Auth helpers ──────────────────────────────────────────────────────────────
const getToken = () => localStorage.getItem("gc_token");
const setToken = (t) => localStorage.setItem("gc_token", t);
const clearToken = () => localStorage.removeItem("gc_token");
const authHeaders = () => {
  const t = getToken();
  return t ? { "Authorization": `Bearer ${t}` } : {};
};
const apiFetch = (path, opts = {}) => fetch(`${API}${path}`, {
  ...opts,
  headers: { "Content-Type": "application/json", ...authHeaders(), ...(opts.headers || {}) },
});

// ─── Billing ──────────────────────────────────────────────────────────────────

// Shared by every purchase entry point. Reports failures through onError rather
// than navigating: a non-ok response has no `url`, and assigning undefined to
// window.location.href sends the browser to a broken page instead of surfacing
// the problem (which is what a 501 from an unconfigured Stripe used to do).
async function startCheckout(type, onError) {
  const fail = (m) => (onError ? onError(m) : alert(m));
  let r;
  try {
    r = await apiFetch("/billing/checkout", { method: "POST", body: JSON.stringify({ type }) });
  } catch {
    return fail("Couldn't reach the server. Check your connection and try again.");
  }
  if (!r.ok) {
    if (r.status === 401) return fail("Please sign in before purchasing.");
    if (r.status === 501) return fail("Payments aren't set up on the server yet.");
    return fail("Couldn't start checkout. Please try again.");
  }
  const { url } = await r.json().catch(() => ({}));
  if (!url) return fail("Checkout session came back without a URL.");
  window.location.href = url;
}

/** Open Stripe's customer portal, where a subscriber cancels or updates payment. */
async function openBillingPortal(onError) {
  const fail = (m) => (onError ? onError(m) : alert(m));
  let r;
  try {
    r = await apiFetch("/billing/portal", { method: "POST" });
  } catch {
    return fail("Couldn't reach the server. Try again.");
  }
  if (!r.ok) {
    if (r.status === 404) return fail("No billing account yet — nothing to manage.");
    if (r.status === 401) return fail("Please sign in first.");
    return fail("Couldn't open the billing portal.");
  }
  const { url } = await r.json().catch(() => ({}));
  if (!url) return fail("Billing portal returned no URL.");
  window.location.href = url;
}


const SUGGESTIONS = [
  { label: "BRCA1 pathogenic variants" },
  { label: "What genes cause hereditary breast cancer?" },
  { label: "TP53 variants and cancer" },
  { label: "Alzheimer's disease genes" },
  { label: "EGFR variants in lung cancer" },
  { label: "Which genes are linked to Parkinson's?" },
];

function getPersonalizedSuggestions(dnaData) {
  if (!dnaData) return null;
  const summary = computeDnaSummary(dnaData);
  if (!summary || summary.totalFound === 0) return null;

  // Pick the most interesting finding per category, dedupe by gene
  const seen = new Set();
  const suggestions = [];
  const categoryOrder = ["neurological", "pharmacogenomics", "cardiovascular", "cancer", "hereditary", "metabolism"];

  for (const cat of categoryOrder) {
    const findings = summary.byCategory[cat] || [];
    // Prefer findings where user actually carries the risk allele
    const sorted = [...findings].sort((a, b) => (b.hasRisk ? 1 : 0) - (a.hasRisk ? 1 : 0));
    for (const f of sorted) {
      if (seen.has(f.gene)) continue;
      seen.add(f.gene);
      const meta = CATEGORY_META[cat];
      const zygosity = f.isHomozygous && f.hasRisk ? "homozygous " : f.hasRisk ? "heterozygous " : "";
      suggestions.push({
        label: `${f.gene} — I carry ${f.genotype} at ${f.rsid}`,
        sublabel: `${zygosity}${f.name}`,
        category: meta.label,
        color: meta.color,
        border: meta.border,
        bg: meta.bg,
        query: `${f.gene} variants — I have genotype ${f.genotype} at ${f.rsid} (${f.name})`,
      });
      if (suggestions.length === 6) break;
    }
    if (suggestions.length === 6) break;
  }
  return suggestions.length > 0 ? suggestions : null;
}

// ─── Markdown Renderer ───────────────────────────────────────────────────────

function renderInline(text) {
  const parts = [];
  const re = /(\*\*(.+?)\*\*|`(.+?)`|\*(.+?)\*)/g;
  let last = 0, m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    if (m[2]) parts.push(<strong key={m.index} style={{ color: "var(--text-secondary)", fontWeight: 600 }}>{m[2]}</strong>);
    else if (m[3]) parts.push(<code key={m.index} style={{ fontFamily: "monospace", fontSize: "0.78em", background: "var(--border-solid)", color: "var(--accent-soft)", padding: "0.1em 0.35em", borderRadius: 3 }}>{m[3]}</code>);
    else if (m[4]) parts.push(<em key={m.index} style={{ color: "var(--text-muted)" }}>{m[4]}</em>);
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}


/** The MyDNA mark. Kept as an image with live text beside it rather than a
 *  baked-in lockup, so the wordmark follows the theme instead of being a fixed
 *  slate that disappears on a dark background. */
function BrandMark({ size = 28, style }) {
  return (
    <img
      src="/logo-mark.png"
      alt=""
      width={size}
      height={size}
      style={{ objectFit: "contain", flexShrink: 0, display: "block", ...style }}
    />
  );
}

function Markdown({ content }) {
  if (!content) return null;
  const lines = content.split("\n");
  const elements = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith("## ")) {
      elements.push(
        <h2 key={i} style={{ fontSize: "0.875rem", fontWeight: 700, color: "var(--text)", margin: "1.25rem 0 0.5rem", paddingBottom: "0.375rem", borderBottom: "1px solid var(--border-solid)" }}>
          {renderInline(line.slice(3))}
        </h2>
      );
    } else if (line.startsWith("### ")) {
      elements.push(
        <h3 key={i} style={{ fontSize: "0.8rem", fontWeight: 600, color: "var(--text-muted)", margin: "0.875rem 0 0.25rem" }}>
          {renderInline(line.slice(4))}
        </h3>
      );
    } else if (line.startsWith("- ") || line.startsWith("• ")) {
      const items = [];
      while (i < lines.length && (lines[i].startsWith("- ") || lines[i].startsWith("• "))) {
        items.push(<li key={i} style={{ color: "var(--text-faint)", fontSize: "0.875rem", lineHeight: 1.65, marginBottom: "0.2rem" }}>{renderInline(lines[i].slice(2))}</li>);
        i++;
      }
      elements.push(<ul key={`ul${i}`} style={{ paddingLeft: "1.25rem", listStyle: "disc", margin: "0.5rem 0" }}>{items}</ul>);
      continue;
    } else if (line.trim() === "") {
      elements.push(<div key={i} style={{ height: "0.375rem" }} />);
    } else {
      elements.push(<p key={i} style={{ color: "var(--text-faint)", fontSize: "0.875rem", lineHeight: 1.7, margin: "0.25rem 0" }}>{renderInline(line)}</p>);
    }
    i++;
  }
  return <div>{elements}</div>;
}

// ─── Data Cards ──────────────────────────────────────────────────────────────

const SIG_COLORS = {
  "Pathogenic": { bg: "rgb(var(--c-danger) / 0.4)", color: "var(--danger-soft)", border: "rgb(var(--c-danger) / 0.3)" },
  "Likely pathogenic": { bg: "rgb(var(--c-warning) / 0.4)", color: "var(--warning-soft)", border: "rgb(var(--c-warning) / 0.3)" },
  "Benign": { bg: "rgb(var(--c-success) / 0.4)", color: "var(--success-soft)", border: "rgb(var(--c-success) / 0.3)" },
  "Likely benign": { bg: "rgb(var(--c-success) / 0.4)", color: "#5eead4", border: "rgb(var(--c-success) / 0.3)" },
  "Uncertain significance": { bg: "rgb(var(--c-warning) / 0.4)", color: "var(--warning-soft)", border: "rgb(var(--c-warning) / 0.3)" },
};

function VariantCard({ variant, userVariant, defaultExpanded }) {
  const [expanded, setExpanded] = useState(defaultExpanded || false);
  const sig = variant.clinical_significance || "Unknown";
  const c = SIG_COLORS[sig] || { bg: "rgb(var(--c-surface) / 0.6)", color: "var(--text-faint)", border: "rgb(var(--c-border) / 0.4)" };
  const hasDetail = variant.condition || variant.consequence || variant.frequency != null || variant.review_status || variant.hgvs;
  return (
    <div
      onClick={() => hasDetail && setExpanded(e => !e)}
      style={{ background: "rgb(var(--c-surface) / 0.35)", border: `1px solid ${userVariant ? "rgb(var(--c-accent) / 0.4)" : expanded ? "rgb(var(--c-accent) / 0.35)" : "rgb(var(--c-border) / 0.4)"}`, borderRadius: 10, padding: "0.75rem", cursor: hasDetail ? "pointer" : "default", transition: "border-color 0.15s" }}
    >
      {userVariant && (
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6, padding: "0.2rem 0.5rem", background: "rgb(var(--c-accent) / 0.1)", borderRadius: 6, border: "1px solid rgb(var(--c-accent) / 0.2)" }}>
          <span style={{ fontSize: "0.62rem", color: "var(--accent)", fontWeight: 600 }}>YOUR DATA</span>
          <span style={{ fontFamily: "monospace", fontSize: "0.7rem", color: "var(--accent-soft)", fontWeight: 700 }}>{userVariant.genotype}</span>
          {userVariant.chromosome && <span style={{ fontSize: "0.6rem", color: "var(--text-faintest)" }}>chr{userVariant.chromosome}</span>}
        </div>
      )}
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
        <div style={{ minWidth: 0 }}>
          <p style={{ fontFamily: "monospace", fontSize: "0.78rem", color: "var(--accent-soft)", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{variant.variant_id}</p>
          {!expanded && variant.condition && <p style={{ fontSize: "0.72rem", color: "var(--text-dim)", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{variant.condition}</p>}
        </div>
        <div style={{ textAlign: "right", flexShrink: 0 }}>
          <span style={{ fontSize: "0.7rem", padding: "0.2em 0.55em", borderRadius: 5, background: c.bg, color: c.color, border: `1px solid ${c.border}`, display: "inline-block" }}>{sig}</span>
          {!expanded && variant.frequency != null && (
            <p style={{ fontSize: "0.7rem", color: "var(--text-dimmer)", marginTop: 3 }}>
              AF {variant.frequency < 0.0001 ? variant.frequency.toExponential(1) : variant.frequency.toFixed(5)}
            </p>
          )}
          {hasDetail && <p style={{ fontSize: "0.6rem", color: "var(--text-faintest)", marginTop: 3 }}>{expanded ? "▲ less" : "▼ more"}</p>}
        </div>
      </div>
      {expanded && (
        <div style={{ marginTop: "0.6rem", paddingTop: "0.6rem", borderTop: "1px solid rgb(var(--c-border) / 0.3)", display: "flex", flexDirection: "column", gap: 4 }}>
          {variant.condition && <Row label="Condition" value={variant.condition} />}
          {variant.consequence && <Row label="Consequence" value={variant.consequence} mono />}
          {variant.hgvs && <Row label="HGVS" value={variant.hgvs} mono />}
          {variant.frequency != null && <Row label="Allele frequency" value={variant.frequency < 0.0001 ? variant.frequency.toExponential(3) : variant.frequency.toFixed(6)} mono />}
          {variant.review_status && <Row label="Review status" value={variant.review_status} />}
          {variant.gene && <Row label="Gene" value={variant.gene} mono />}
          {variant.source && (
            <a
              href={`https://www.ncbi.nlm.nih.gov/clinvar/variation/${variant.variant_id?.replace(/[^0-9]/g, "")}/`}
              target="_blank" rel="noreferrer"
              onClick={e => e.stopPropagation()}
              style={{ fontSize: "0.68rem", color: "var(--accent)", marginTop: 2 }}
            >
              View in ClinVar ↗
            </a>
          )}
        </div>
      )}
    </div>
  );
}

function Row({ label, value, mono }) {
  return (
    <div style={{ display: "flex", gap: 8, alignItems: "baseline" }}>
      <span style={{ fontSize: "0.65rem", color: "var(--text-faintest)", flexShrink: 0, width: 110 }}>{label}</span>
      <span style={{ fontSize: mono ? "0.68rem" : "0.72rem", color: "var(--text-faint)", fontFamily: mono ? "monospace" : "inherit", wordBreak: "break-all" }}>{value}</span>
    </div>
  );
}

function GeneCard({ gene }) {
  return (
    <div style={{ background: "rgb(var(--c-surface) / 0.35)", border: "1px solid rgb(var(--c-border) / 0.4)", borderRadius: 10, padding: "0.75rem" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
        <div style={{ minWidth: 0 }}>
          <p style={{ fontFamily: "monospace", fontSize: "0.85rem", color: "var(--violet-faint)", fontWeight: 700 }}>{gene.gene_symbol}</p>
          {gene.description && <p style={{ fontSize: "0.75rem", color: "var(--text-dim)", marginTop: 4, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{gene.description}</p>}
        </div>
        <div style={{ textAlign: "right", flexShrink: 0 }}>
          {gene.chromosome && <span style={{ fontSize: "0.7rem", padding: "0.2em 0.55em", borderRadius: 5, background: "rgb(var(--c-surface) / 0.7)", color: "var(--text-dim)", border: "1px solid rgb(var(--c-border) / 0.4)", display: "inline-block" }}>Chr {gene.chromosome}</span>}
          {gene.publication_count > 0 && <p style={{ fontSize: "0.7rem", color: "var(--text-dimmer)", marginTop: 3 }}>{gene.publication_count.toLocaleString()} pubs</p>}
        </div>
      </div>
    </div>
  );
}

/** A one-time, dismissible invitation to read about the project.
 *
 *  Appears above the input rather than as a dialog: nothing is blocked, and
 *  ignoring it costs the reader nothing. Once dismissed it does not return. */
function AboutNudge({ onOpen, onDismiss }) {
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 10, marginBottom: 8,
      padding: "0.55rem 0.75rem", borderRadius: 10,
      background: "rgb(var(--c-accent) / 0.08)",
      border: "1px solid rgb(var(--c-accent) / 0.25)",
    }}>
      <span style={{ fontSize: "0.8rem", flexShrink: 0 }}>🧬</span>
      <p style={{ fontSize: "0.72rem", color: "var(--text-muted)", lineHeight: 1.5, margin: 0, flex: 1, minWidth: 0 }}>
        Glad you&rsquo;re here. MyDNA is an independent project with a reason for
        existing —{" "}
        <button onClick={onOpen}
          style={{ background: "none", border: "none", padding: 0, cursor: "pointer",
                   font: "inherit", color: "var(--accent)", fontWeight: 600, textDecoration: "underline" }}>
          read why
        </button>.
      </p>
      <button onClick={onDismiss} title="Dismiss"
        style={{ background: "none", border: "none", cursor: "pointer",
                 color: "var(--text-dim)", fontSize: "0.9rem", lineHeight: 1, padding: "0 2px", flexShrink: 0 }}
      >×</button>
    </div>
  );
}

function GeneInfoBanner({ geneInfo, proteinInfo, pubCount }) {
  const [expanded, setExpanded] = useState(false);
  if (!geneInfo) return null;
  // UniProt function summaries run to a paragraph and carry the citations, so
  // clamping them silently — as this did — removed the substance and left the
  // reader with a sentence ending in an ellipsis and no way to continue.
  const summary = proteinInfo?.function || "";
  const clampable = summary.length > 190;
  return (
    <div style={{ background: "rgb(var(--c-accent) / 0.4)", border: "1px solid rgb(var(--c-accent) / 0.25)", borderRadius: 10, padding: "0.75rem", marginBottom: "1rem" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
        <div>
          <p style={{ fontFamily: "monospace", fontWeight: 700, color: "var(--accent-soft)", fontSize: "0.875rem" }}>{geneInfo.symbol}</p>
          {geneInfo.description && <p style={{ fontSize: "0.75rem", color: "var(--text-dim)", marginTop: 3 }}>{geneInfo.description}</p>}
          {proteinInfo?.protein_name && <p style={{ fontSize: "0.72rem", color: "var(--accent-strong)", opacity: 0.7, marginTop: 4 }}>Protein: {proteinInfo.protein_name}</p>}
        </div>
        <div style={{ textAlign: "right", flexShrink: 0 }}>
          {geneInfo.chromosome && <p style={{ fontSize: "0.72rem", color: "var(--text-dimmer)" }}>Chr {geneInfo.chromosome}</p>}
          {pubCount > 0 && <p style={{ fontSize: "0.72rem", color: "var(--text-dimmer)", marginTop: 3 }}>{pubCount.toLocaleString()} publications</p>}
        </div>
      </div>
      {summary && (
        <div style={{ marginTop: 8 }}>
          <p style={{
            fontSize: "0.72rem", color: "var(--text-dimmer)", lineHeight: 1.55,
            ...(clampable && !expanded
              ? { display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }
              : {}),
          }}>{summary}</p>
          {clampable && (
            <button onClick={() => setExpanded(v => !v)}
              style={{ background: "none", border: "none", padding: "3px 0 0", cursor: "pointer",
                       fontSize: "0.68rem", fontWeight: 600, color: "var(--accent)" }}>
              {expanded ? "Show less" : "Read more"}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

const SIG_FILTER_OPTIONS = ["All", "Pathogenic", "Likely pathogenic", "Uncertain significance", "Likely benign", "Benign"];
const SIG_FILTER_SHORT = { "All": "All", "Pathogenic": "Path.", "Likely pathogenic": "Likely path.", "Uncertain significance": "VUS", "Likely benign": "Likely benign", "Benign": "Benign" };


/** The sections deliberately not fetched up front. Each is one click away. */

/** An opened section. Collapsing is automatic for older ones, but a section the
 *  reader opened by hand is "pinned" and stays open until they close it. */
function OpenedSection({ label, open, pinned, onToggle, children }) {
  return (
    <div style={{ marginTop: 12, border: "1px solid rgb(var(--c-border) / 0.3)", borderRadius: 10, overflow: "hidden" }}>
      <button onClick={onToggle}
        style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "0.55rem 0.75rem",
                 background: open ? "rgb(var(--c-accent) / 0.08)" : "rgb(var(--c-surface) / 0.35)",
                 border: "none", cursor: "pointer", textAlign: "left" }}>
        <span style={{ fontSize: "0.68rem", color: "var(--text-dim)", width: 10 }}>{open ? "▾" : "▸"}</span>
        <span style={{ fontSize: "0.78rem", fontWeight: 600, color: open ? "var(--accent)" : "var(--text-muted)", flex: 1 }}>{label}</span>
        {pinned && open && (
          <span title="Kept open because you opened it" style={{ fontSize: "0.58rem", color: "var(--text-faintest)", letterSpacing: "0.05em" }}>PINNED</span>
        )}
      </button>
      {open && <div style={{ padding: "0 0.75rem 0.5rem" }}>{children}</div>}
    </div>
  );
}

function ExploreFurther({ items, opened, onLoadSection, onAsk, sectionState }) {
  if (!onLoadSection) return null;
  const remaining = items.filter(it => !opened.includes(it.key));
  if (!remaining.length) return null;
  const { loading = {}, errors = {}, idx } = sectionState || {};
  const costCount = remaining.filter(it => !it.instant).length;

  return (
    <div style={{ marginTop: 18 }}>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
        <p style={{ fontSize: "0.7rem", fontWeight: 700, letterSpacing: "0.06em", textTransform: "uppercase", color: "var(--text-dim)", margin: 0 }}>
          Explore further
        </p>
        <span style={{ fontSize: "0.65rem", color: "var(--text-faintest)" }}>
          {remaining.length} available{costCount > 0 ? ` · ${costCount} use a credit — only if data is found` : ""}
        </span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))", gap: 8 }}>
        {remaining.map(it => {
          const key = `${idx}:${it.key}`;
          const busy = !!loading[key];
          const failed = !!errors[key];
          return (
            <button key={it.key} disabled={busy}
              onClick={() => it.ask ? onAsk?.(it.ask) : onLoadSection(it.key, it.instant, it.label)}
              style={{
                display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 2,
                padding: "0.6rem 0.7rem", borderRadius: 10, textAlign: "left",
                background: busy ? "rgb(var(--c-accent) / 0.1)" : "rgb(var(--c-surface) / 0.4)",
                border: `1px solid ${failed ? "rgb(var(--c-danger) / 0.4)" : busy ? "rgb(var(--c-accent) / 0.35)" : "rgb(var(--c-border) / 0.35)"}`,
                cursor: busy ? "default" : "pointer", transition: "all 0.15s",
              }}
              onMouseEnter={e => { if (!busy) e.currentTarget.style.borderColor = "rgb(var(--c-accent) / 0.4)"; }}
              onMouseLeave={e => { if (!busy) e.currentTarget.style.borderColor = "rgb(var(--c-border) / 0.35)"; }}
            >
              <div style={{ display: "flex", alignItems: "flex-start", gap: 6, width: "100%" }}>
                <span style={{ flex: 1, minWidth: 0, fontSize: "0.74rem", fontWeight: 600, color: busy ? "var(--accent)" : "var(--text-muted)" }}>
                  {busy ? "Loading…" : failed ? "Retry" : it.label}
                </span>
                {/* Only the ones that cost anything are marked; absence of a
                    chip means free, which keeps sixteen cards from becoming a
                    wall of labels. */}
                {!it.instant && !busy && !it.ask && (
                  <span
                    title="Uses one query credit — only if data is found"
                    style={{
                      flexShrink: 0, fontSize: "0.58rem", fontWeight: 700, letterSpacing: "0.03em",
                      padding: "0.12em 0.4em", borderRadius: 5, whiteSpace: "nowrap",
                      color: "var(--accent)", background: "rgb(var(--c-accent) / 0.12)",
                      border: "1px solid rgb(var(--c-accent) / 0.3)",
                    }}
                  >
                    1 CREDIT
                  </span>
                )}
              </div>
              <span style={{ fontSize: "0.62rem", color: "var(--text-faintest)" }}>
                {failed ? "Could not load — click to retry" : it.source}
                {it.ask && !failed ? " · asks a new question" : ""}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function DataSection({ data, queryType, dnaData, settings }) {
  const [expanded, setExpanded] = useState(false);
  const [sigFilter, setSigFilter] = useState("All");
  const [sortBy, setSortBy] = useState(settings?.defaultSort || "default");
  const [myDataOnly, setMyDataOnly] = useState(false);

  if (!data) return null;
  const isGene = queryType === "gene_query";
  const allItems = isGene ? (data.variants || []) : (data.genes || []);
  if (allItems.length === 0) return null;

  const getUserVariant = (item) => {
    if (!dnaData) return null;
    const rsid = item.variant_id?.startsWith("rs") ? item.variant_id : item.rsid;
    return rsid ? dnaData.variants.get(rsid) : null;
  };

  // Filter
  let items = allItems;
  if (isGene) {
    if (sigFilter !== "All") items = items.filter(v => v.clinical_significance === sigFilter);
    if (myDataOnly && dnaData) items = items.filter(v => getUserVariant(v));
  }

  // Sort
  if (isGene) {
    if (sortBy === "my_data_first") {
      items = [...items].sort((a, b) => (getUserVariant(b) ? 1 : 0) - (getUserVariant(a) ? 1 : 0));
    } else if (sortBy === "pathogenic_first") {
      const order = { "Pathogenic": 0, "Likely pathogenic": 1, "Uncertain significance": 2, "Likely benign": 3, "Benign": 4 };
      items = [...items].sort((a, b) => (order[a.clinical_significance] ?? 5) - (order[b.clinical_significance] ?? 5));
    } else if (sortBy === "frequency") {
      items = [...items].sort((a, b) => (a.frequency ?? 1) - (b.frequency ?? 1));
    }
  }

  const matchCount = isGene && dnaData ? allItems.filter(v => getUserVariant(v)).length : 0;
  const shown = expanded ? items : items.slice(0, 6);
  const hasFilters = isGene && allItems.length > 3;

  return (
    <div style={{ marginTop: "1rem" }}>
      {/* Header row */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: hasFilters ? 10 : 8, flexWrap: "wrap", gap: 6 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <p style={{ fontSize: "0.7rem", fontWeight: 600, color: "var(--text-dimmer)", textTransform: "uppercase", letterSpacing: "0.08em" }}>
            {isGene
              ? `${items.length}${items.length !== allItems.length ? ` / ${allItems.length}` : ""} Variant${allItems.length !== 1 ? "s" : ""}`
              : `${allItems.length} Associated Genes`}
          </p>
          {matchCount > 0 && (
            <span style={{ fontSize: "0.62rem", padding: "0.15em 0.5em", borderRadius: 4, background: "rgb(var(--c-accent) / 0.15)", color: "var(--accent)", border: "1px solid rgb(var(--c-accent) / 0.25)" }}>
              {matchCount} in your data
            </span>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {items.length > 6 && (
            <button onClick={() => setExpanded(e => !e)} style={{ fontSize: "0.72rem", color: "var(--accent)", background: "none", border: "none", cursor: "pointer" }}>
              {expanded ? "Show less" : `Show all ${items.length}`}
            </button>
          )}
          {isGene && (
            <select value={sortBy} onChange={e => setSortBy(e.target.value)}
              style={{ fontSize: "0.68rem", color: "var(--text-dim)", background: "rgb(var(--c-deep) / 0.7)", border: "1px solid rgb(var(--c-border) / 0.4)", borderRadius: 6, padding: "0.2rem 0.4rem", cursor: "pointer", outline: "none" }}>
              <option value="default">Sort: Default</option>
              <option value="pathogenic_first">Pathogenic first</option>
              <option value="frequency">Rarest first</option>
              {matchCount > 0 && <option value="my_data_first">My data first</option>}
            </select>
          )}
        </div>
      </div>

      {/* Filter bar — significance pills + my data toggle */}
      {hasFilters && (
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
          {SIG_FILTER_OPTIONS.map(opt => {
            const active = sigFilter === opt;
            const c = opt === "All" ? null : SIG_COLORS[opt];
            return (
              <button key={opt} onClick={() => { setSigFilter(opt); setExpanded(false); }}
                style={{ fontSize: "0.65rem", padding: "0.18em 0.55em", borderRadius: 100, cursor: "pointer", fontWeight: active ? 700 : 400, transition: "all 0.12s",
                  background: active && c ? c.bg : active ? "rgb(var(--c-accent) / 0.15)" : "rgb(var(--c-deep) / 0.5)",
                  color: active && c ? c.color : active ? "var(--accent)" : "var(--text-dimmer)",
                  border: `1px solid ${active && c ? c.border : active ? "rgb(var(--c-accent) / 0.3)" : "rgb(var(--c-border) / 0.3)"}` }}>
                {SIG_FILTER_SHORT[opt]}
              </button>
            );
          })}
          {matchCount > 0 && dnaData && (
            <button onClick={() => { setMyDataOnly(v => !v); setExpanded(false); }}
              style={{ fontSize: "0.65rem", padding: "0.18em 0.6em", borderRadius: 100, cursor: "pointer", marginLeft: 4, transition: "all 0.12s",
                background: myDataOnly ? "rgb(var(--c-accent) / 0.15)" : "rgb(var(--c-deep) / 0.5)",
                color: myDataOnly ? "var(--accent)" : "var(--text-dimmer)",
                border: `1px solid ${myDataOnly ? "rgb(var(--c-accent) / 0.3)" : "rgb(var(--c-border) / 0.3)"}`,
                fontWeight: myDataOnly ? 700 : 400 }}>
              🧬 My data only
            </button>
          )}
          {(sigFilter !== "All" || myDataOnly) && (
            <button onClick={() => { setSigFilter("All"); setMyDataOnly(false); }}
              style={{ fontSize: "0.62rem", color: "var(--text-faintest)", background: "none", border: "none", cursor: "pointer", marginLeft: 2 }}>
              Clear
            </button>
          )}
        </div>
      )}

      {items.length === 0 ? (
        <p style={{ fontSize: "0.75rem", color: "var(--text-faintest)", padding: "0.75rem 0" }}>No variants match the current filter.</p>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))", gap: 8 }}>
          {shown.map((item, i) => {
            if (!isGene) return <GeneCard key={item.gene_symbol || i} gene={item} />;
            return <VariantCard key={item.variant_id || i} variant={item} userVariant={getUserVariant(item)} defaultExpanded={settings?.variantDefault === "expanded"} />;
          })}
        </div>
      )}

    </div>
  );
}

// ─── Pathway Viewer (Reactome) ───────────────────────────────────────────────

const PATHWAY_COLORS = [
  "var(--accent-strong)","#6366f1","#8b5cf6","#ec4899","#f59e0b",
  "#10b981","#14b8a6","#f97316","#ef4444","#84cc16",
];

function PathwayViewer({ pathways }) {
  const [expanded, setExpanded] = useState(false);
  if (!pathways?.length) return null;
  const shown = expanded ? pathways : pathways.slice(0, 8);

  return (
    <div style={{ marginTop: "1rem", background: "rgb(var(--c-deep) / 0.6)", border: "1px solid rgb(var(--c-indigo) / 0.2)", borderRadius: 12, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0.625rem 0.875rem", borderBottom: "1px solid rgb(var(--c-indigo) / 0.15)" }}>
        <span style={{ fontSize: "0.78rem", fontWeight: 600, color: "var(--violet-faint)" }}>Biological Pathways</span>
        <span style={{ fontSize: "0.68rem", color: "var(--text-faintest)" }}>Reactome · {pathways.length} pathways</span>
      </div>
      <div style={{ padding: "0.75rem", display: "flex", flexWrap: "wrap", gap: 6 }}>
        {shown.map((p, i) => (
          <a key={p.pathway_id || i} href={p.url} target="_blank" rel="noreferrer"
            style={{ display: "inline-flex", alignItems: "center", gap: 5, padding: "0.3rem 0.65rem", borderRadius: 100, border: `1px solid ${PATHWAY_COLORS[i % PATHWAY_COLORS.length]}30`, background: `${PATHWAY_COLORS[i % PATHWAY_COLORS.length]}12`, color: PATHWAY_COLORS[i % PATHWAY_COLORS.length], fontSize: "0.72rem", textDecoration: "none", cursor: "pointer" }}
            onMouseEnter={e => e.currentTarget.style.background = `${PATHWAY_COLORS[i % PATHWAY_COLORS.length]}25`}
            onMouseLeave={e => e.currentTarget.style.background = `${PATHWAY_COLORS[i % PATHWAY_COLORS.length]}12`}
          >
            <span style={{ width: 5, height: 5, borderRadius: "50%", background: PATHWAY_COLORS[i % PATHWAY_COLORS.length], flexShrink: 0 }} />
            {p.name}
            <span style={{ opacity: 0.5, fontSize: "0.65rem" }}>↗</span>
          </a>
        ))}
      </div>
      {pathways.length > 8 && (
        <div style={{ padding: "0 0.875rem 0.625rem" }}>
          <button onClick={() => setExpanded(e => !e)} style={{ fontSize: "0.72rem", color: "#6366f1", background: "none", border: "none", cursor: "pointer", padding: 0 }}>
            {expanded ? "Show less" : `+ ${pathways.length - 8} more pathways`}
          </button>
        </div>
      )}
    </div>
  );
}

// ─── Tissue Expression Chart (GTEx) ──────────────────────────────────────────

function ExpressionChart({ expression }) {
  if (!expression?.length) return null;
  const top = expression.slice(0, 12);
  const max = Math.max(...top.map(e => e.median_tpm));

  return (
    <div style={{ marginTop: "1rem", background: "rgb(var(--c-deep) / 0.6)", border: "1px solid rgb(var(--c-success) / 0.2)", borderRadius: 12, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0.625rem 0.875rem", borderBottom: "1px solid rgb(var(--c-success) / 0.15)" }}>
        <span style={{ fontSize: "0.78rem", fontWeight: 600, color: "var(--success-soft)" }}>Tissue Expression</span>
        <span style={{ fontSize: "0.68rem", color: "var(--text-faintest)" }}>GTEx v8 · median TPM</span>
      </div>
      <div style={{ padding: "0.75rem", display: "flex", flexDirection: "column", gap: 5 }}>
        {top.map((e, i) => {
          const pct = max > 0 ? (e.median_tpm / max) * 100 : 0;
          const intensity = Math.max(0.3, pct / 100);
          return (
            <div key={e.tissue} style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: "0.7rem", color: "var(--text-dim)", width: 140, flexShrink: 0, textAlign: "right", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.tissue}</span>
              <div style={{ flex: 1, height: 14, background: "rgb(var(--c-surface) / 0.5)", borderRadius: 3, overflow: "hidden" }}>
                <div style={{ width: `${pct}%`, height: "100%", background: `rgba(16,185,129,${intensity})`, borderRadius: 3, transition: "width 0.5s ease", minWidth: pct > 0 ? 2 : 0 }} />
              </div>
              <span style={{ fontSize: "0.68rem", color: "var(--text-dimmer)", width: 50, textAlign: "right", flexShrink: 0 }}>{e.median_tpm}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Protein Interaction Network (STRING) ────────────────────────────────────

function InteractionNetwork({ interactions, centerGene }) {
  if (!interactions?.length) return null;

  // Simple force-like circular layout
  const cx = 200, cy = 180, r = 130;
  const nodes = interactions.slice(0, 12);

  return (
    <div style={{ marginTop: "1rem", background: "rgb(var(--c-deep) / 0.6)", border: "1px solid rgb(var(--c-warning) / 0.2)", borderRadius: 12, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0.625rem 0.875rem", borderBottom: "1px solid rgb(var(--c-warning) / 0.15)" }}>
        <span style={{ fontSize: "0.78rem", fontWeight: 600, color: "var(--warning-soft)" }}>Protein Interactions</span>
        <span style={{ fontSize: "0.68rem", color: "var(--text-faintest)" }}>STRING DB · {interactions.length} partners</span>
      </div>
      <div style={{ display: "flex", gap: 0 }}>
        <svg width="400" height="360" style={{ flexShrink: 0 }}>
          {nodes.map((node, i) => {
            const angle = (i / nodes.length) * 2 * Math.PI - Math.PI / 2;
            const nx = cx + r * Math.cos(angle);
            const ny = cy + r * Math.sin(angle);
            const opacity = 0.3 + node.interaction_score * 0.7;
            return (
              <line key={`l${i}`} x1={cx} y1={cy} x2={nx} y2={ny}
                stroke={`rgba(245,158,11,${opacity})`} strokeWidth={1 + node.interaction_score * 2} />
            );
          })}
          <circle cx={cx} cy={cy} r={22} fill="rgb(var(--c-accent) / 0.2)" stroke="var(--accent-strong)" strokeWidth={1.5} />
          <text x={cx} y={cy + 4} textAnchor="middle" fill="var(--accent-soft)" fontSize={10} fontWeight={700} fontFamily="monospace">{centerGene}</text>
          {nodes.map((node, i) => {
            const angle = (i / nodes.length) * 2 * Math.PI - Math.PI / 2;
            const nx = cx + r * Math.cos(angle);
            const ny = cy + r * Math.sin(angle);
            return (
              <g key={`n${i}`}>
                <circle cx={nx} cy={ny} r={16} fill="rgb(var(--c-warning) / 0.12)" stroke={`rgba(245,158,11,${0.4 + node.interaction_score * 0.6})`} strokeWidth={1} />
                <text x={nx} y={ny + 4} textAnchor="middle" fill="var(--warning-soft)" fontSize={8} fontFamily="monospace">{node.gene}</text>
              </g>
            );
          })}
        </svg>
        <div style={{ flex: 1, padding: "0.75rem 0.75rem 0.75rem 0", overflowY: "auto", maxHeight: 360 }}>
          {nodes.map((node, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0.3rem 0", borderBottom: "1px solid rgb(var(--c-surface) / 0.4)" }}>
              <span style={{ fontFamily: "monospace", fontSize: "0.75rem", color: "var(--warning-soft)" }}>{node.gene}</span>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <div style={{ width: 40, height: 4, background: "rgb(var(--c-surface) / 0.5)", borderRadius: 2, overflow: "hidden" }}>
                  <div style={{ width: `${node.score_pct}%`, height: "100%", background: `rgba(245,158,11,${0.4 + node.interaction_score * 0.6})`, borderRadius: 2 }} />
                </div>
                <span style={{ fontSize: "0.65rem", color: "var(--text-dimmer)" }}>{node.score_pct}%</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Drug Panel (Open Targets) ───────────────────────────────────────────────

const PHASE_LABEL = { 4: "Approved", 3: "Phase III", 2: "Phase II", 1: "Phase I", 0: "Preclinical" };
const PHASE_COLOR = {
  4: { bg: "rgb(var(--c-success) / 0.4)", color: "var(--success-soft)", border: "rgb(var(--c-success) / 0.3)" },
  3: { bg: "rgb(var(--c-accent) / 0.4)", color: "var(--accent-soft)", border: "rgb(var(--c-accent) / 0.3)" },
  2: { bg: "rgb(var(--c-accent) / 0.4)", color: "var(--accent-soft)", border: "rgb(var(--c-accent) / 0.25)" },
  1: { bg: "rgb(var(--c-violet) / 0.4)", color: "var(--violet-faint)", border: "rgb(var(--c-violet) / 0.3)" },
  0: { bg: "rgb(var(--c-surface) / 0.5)", color: "var(--text-faint)", border: "rgb(var(--c-border) / 0.4)" },
};

function DrugPanel({ drugs }) {
  const [expanded, setExpanded] = useState(false);
  if (!drugs?.length) return null;
  const shown = expanded ? drugs : drugs.slice(0, 6);

  return (
    <div style={{ marginTop: "1rem", background: "rgb(var(--c-deep) / 0.6)", border: "1px solid rgb(var(--c-success) / 0.2)", borderRadius: 12, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0.625rem 0.875rem", borderBottom: "1px solid rgb(var(--c-success) / 0.12)" }}>
        <span style={{ fontSize: "0.78rem", fontWeight: 600, color: "var(--success-soft)" }}>Drug Interactions</span>
        <span style={{ fontSize: "0.68rem", color: "var(--text-faintest)" }}>Open Targets · {drugs.length} compounds</span>
      </div>
      <div style={{ padding: "0.75rem", display: "flex", flexDirection: "column", gap: 6 }}>
        {shown.map((drug, i) => {
          const phase = drug.phase ?? 0;
          const pc = PHASE_COLOR[Math.min(phase, 4)] || PHASE_COLOR[0];
          return (
            <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "0.5rem 0.6rem", background: "rgb(var(--c-surface) / 0.3)", borderRadius: 8, border: "1px solid rgb(var(--c-border) / 0.25)" }}>
              <span style={{ fontSize: "0.68rem", padding: "0.2em 0.55em", borderRadius: 5, background: pc.bg, color: pc.color, border: `1px solid ${pc.border}`, flexShrink: 0, whiteSpace: "nowrap" }}>
                {/* The backend names the stage: its vocabulary is an enum, and
                    a phase 4 trial is a post-approval study rather than an
                    approval, which this scale cannot express on its own. */}
                {drug.phase_label || PHASE_LABEL[Math.min(phase, 4)] || `Phase ${phase}`}
              </span>
              <div style={{ minWidth: 0, flex: 1 }}>
                <p style={{ fontFamily: "monospace", fontSize: "0.78rem", color: "var(--text-secondary)", fontWeight: 600 }}>{drug.name}</p>
                {drug.mechanism && <p style={{ fontSize: "0.7rem", color: "var(--text-dim)", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{drug.mechanism}</p>}
                {/* Open Targets no longer returns a per-drug indication; the
                    field is kept because older cached answers still carry it. */}
                {drug.indication && <p style={{ fontSize: "0.68rem", color: "var(--text-dimmer)", marginTop: 1 }}>{drug.indication}</p>}
              </div>
              {drug.drug_type && <span style={{ fontSize: "0.62rem", color: "var(--text-faintest)", flexShrink: 0, alignSelf: "center" }}>{drug.drug_type}</span>}
            </div>
          );
        })}
      </div>
      {drugs.length > 6 && (
        <div style={{ padding: "0 0.875rem 0.625rem" }}>
          <button onClick={() => setExpanded(e => !e)} style={{ fontSize: "0.72rem", color: "var(--success-soft)", background: "none", border: "none", cursor: "pointer", padding: 0 }}>
            {expanded ? "Show less" : `+ ${drugs.length - 6} more compounds`}
          </button>
        </div>
      )}
    </div>
  );
}

// ─── gnomAD Population Frequency Chart ───────────────────────────────────────

const POP_COLORS = {
  afr: "#f97316", amr: "#eab308", asj: "#a855f7",
  eas: "#06b6d4", fin: "#3b82f6", nfe: "#6366f1",
  sas: "#ec4899", mid: "#14b8a6",
};

function PopulationFrequencyChart({ populations }) {
  if (!populations?.length) return null;
  const max = Math.max(...populations.map(p => p.allele_frequency));

  return (
    <div style={{ marginTop: "1rem", background: "rgb(var(--c-deep) / 0.6)", border: "1px solid rgb(var(--c-indigo) / 0.15)", borderRadius: 12, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0.625rem 0.875rem", borderBottom: "1px solid rgb(var(--c-indigo) / 0.1)" }}>
        <span style={{ fontSize: "0.78rem", fontWeight: 600, color: "var(--violet-faint)" }}>Population Frequencies</span>
        <span style={{ fontSize: "0.68rem", color: "var(--text-faintest)" }}>gnomAD r4 · aggregated AF by ancestry</span>
      </div>
      <div style={{ padding: "0.75rem", display: "flex", flexDirection: "column", gap: 5 }}>
        {populations.map((pop) => {
          const pct = max > 0 ? (pop.allele_frequency / max) * 100 : 0;
          const color = POP_COLORS[pop.population_id] || "#6366f1";
          const afDisplay = pop.allele_frequency === 0 ? "0"
            : pop.allele_frequency < 0.0001 ? pop.allele_frequency.toExponential(2)
            : pop.allele_frequency.toFixed(5);
          return (
            <div key={pop.population_id} style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: "0.68rem", color: "var(--text-dim)", width: 160, flexShrink: 0, textAlign: "right", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{pop.population}</span>
              <div style={{ flex: 1, height: 14, background: "rgb(var(--c-surface) / 0.5)", borderRadius: 3, overflow: "hidden" }}>
                <div style={{ width: `${pct}%`, height: "100%", background: color, borderRadius: 3, opacity: 0.8, transition: "width 0.5s ease", minWidth: pct > 0 ? 2 : 0 }} />
              </div>
              <span style={{ fontSize: "0.65rem", color: "var(--text-dimmer)", width: 70, textAlign: "right", flexShrink: 0, fontFamily: "monospace" }}>{afDisplay}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Cancer Mutations Panel (COSMIC / NCI GDC) ───────────────────────────────

const CONSEQUENCE_COLORS = {
  "Missense": "#f97316", "Stop Gained": "#ef4444", "Frameshift": "var(--danger)",
  "Splice Acceptor": "#8b5cf6", "Splice Donor": "var(--violet-soft)", "Synonymous": "#22c55e",
  "Intron": "var(--text-dim)", "Start Lost": "#f59e0b", "Stop Lost": "var(--warning-soft)",
};

function CancerMutationsPanel({ data }) {
  if (!data?.cancer_types?.length) return null;
  const { cancer_types, consequence_types, total_mutations } = data;
  const max = Math.max(...cancer_types.map(c => c.mutation_count));

  return (
    <div style={{ marginTop: "1rem", background: "rgb(var(--c-deep) / 0.6)", border: "1px solid rgb(var(--c-danger) / 0.2)", borderRadius: 12, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0.625rem 0.875rem", borderBottom: "1px solid rgb(var(--c-danger) / 0.12)" }}>
        <span style={{ fontSize: "0.78rem", fontWeight: 600, color: "var(--danger-soft)" }}>Somatic Cancer Mutations</span>
        <span style={{ fontSize: "0.68rem", color: "var(--text-faintest)" }}>NCI GDC / TCGA · {total_mutations?.toLocaleString()} mutations</span>
      </div>

      <div style={{ display: "flex", gap: 0 }}>
        {/* Cancer type bars */}
        <div style={{ flex: 1, padding: "0.75rem", display: "flex", flexDirection: "column", gap: 5 }}>
          {cancer_types.map((c) => {
            const pct = max > 0 ? (c.mutation_count / max) * 100 : 0;
            return (
              <div key={c.project_id} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: "0.68rem", color: "var(--text-dim)", width: 150, flexShrink: 0, textAlign: "right", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.cancer_type}</span>
                <div style={{ flex: 1, height: 14, background: "rgb(var(--c-surface) / 0.5)", borderRadius: 3, overflow: "hidden" }}>
                  <div style={{ width: `${pct}%`, height: "100%", background: `rgba(239,68,68,${0.3 + (pct / 100) * 0.6})`, borderRadius: 3, transition: "width 0.5s ease", minWidth: pct > 0 ? 2 : 0 }} />
                </div>
                <span style={{ fontSize: "0.65rem", color: "var(--text-dimmer)", width: 40, textAlign: "right", flexShrink: 0 }}>{c.mutation_count}</span>
              </div>
            );
          })}
        </div>

        {/* Consequence type breakdown */}
        {consequence_types?.length > 0 && (
          <div style={{ width: 160, padding: "0.75rem", borderLeft: "1px solid rgb(var(--c-surface) / 0.5)", display: "flex", flexDirection: "column", gap: 5 }}>
            <p style={{ fontSize: "0.63rem", color: "var(--text-faintest)", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 4 }}>Mutation Type</p>
            {consequence_types.map((ct, i) => {
              const color = CONSEQUENCE_COLORS[ct.type] || "#6366f1";
              return (
                <div key={i} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 4 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 4, minWidth: 0 }}>
                    <div style={{ width: 6, height: 6, borderRadius: 1, background: color, flexShrink: 0 }} />
                    <span style={{ fontSize: "0.65rem", color: "var(--text-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{ct.type}</span>
                  </div>
                  <span style={{ fontSize: "0.63rem", color: "var(--text-dimmer)", flexShrink: 0 }}>{ct.count}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── ClinGen Panel ────────────────────────────────────────────────────────────

const CLINGEN_STYLE = {
  "Definitive":           { color: "var(--success-soft)", bg: "rgb(var(--c-success) / 0.5)",   border: "rgb(var(--c-success) / 0.4)" },
  "Strong":               { color: "var(--accent-soft)", bg: "rgb(var(--c-accent) / 0.5)",   border: "rgb(var(--c-accent) / 0.4)" },
  "Moderate":             { color: "var(--warning-soft)", bg: "rgb(var(--c-warning) / 0.4)",   border: "rgb(var(--c-warning) / 0.35)" },
  "Limited":              { color: "var(--warning-soft)", bg: "rgb(var(--c-warning) / 0.4)", border: "rgb(var(--c-warning) / 0.3)" },
  "Disputed":             { color: "var(--danger-soft)", bg: "rgb(var(--c-danger) / 0.4)", border: "rgb(var(--c-danger) / 0.3)" },
  "Refuted":              { color: "var(--danger)", bg: "rgb(var(--c-danger) / 0.5)", border: "rgb(var(--c-danger) / 0.4)" },
  "No Reported Evidence": { color: "var(--text-faint)", bg: "rgb(var(--c-surface) / 0.5)", border: "rgb(var(--c-border) / 0.4)" },
};

function ClinGenPanel({ curations }) {
  if (!curations?.length) return null;
  return (
    <div style={{ marginTop: "1rem", background: "rgb(var(--c-deep) / 0.6)", border: "1px solid rgb(var(--c-success) / 0.18)", borderRadius: 12, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0.625rem 0.875rem", borderBottom: "1px solid rgb(var(--c-success) / 0.1)" }}>
        <span style={{ fontSize: "0.78rem", fontWeight: 600, color: "var(--success-soft)" }}>ClinGen Gene-Disease Validity</span>
        <span style={{ fontSize: "0.68rem", color: "var(--text-faintest)" }}>Expert curated · {curations.length} associations</span>
      </div>
      <div style={{ padding: "0.75rem", display: "flex", flexDirection: "column", gap: 6 }}>
        {curations.map((c, i) => {
          const cs = CLINGEN_STYLE[c.classification] || CLINGEN_STYLE["No Reported Evidence"];
          return (
            <a key={i} href={c.url} target="_blank" rel="noreferrer" style={{ textDecoration: "none" }}>
              <div style={{ padding: "0.5rem 0.65rem", background: "rgb(var(--c-surface) / 0.3)", border: "1px solid rgb(var(--c-border) / 0.25)", borderRadius: 8, display: "flex", alignItems: "center", gap: 10 }}
                onMouseEnter={e => e.currentTarget.style.borderColor = "rgb(var(--c-success) / 0.3)"}
                onMouseLeave={e => e.currentTarget.style.borderColor = "rgb(var(--c-border) / 0.25)"}
              >
                <span style={{ fontSize: "0.68rem", padding: "0.2em 0.55em", borderRadius: 5, background: cs.bg, color: cs.color, border: `1px solid ${cs.border}`, flexShrink: 0, whiteSpace: "nowrap" }}>
                  {c.classification}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <p style={{ fontSize: "0.73rem", color: "var(--text-faint)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.disease}</p>
                  {(c.moi || c.gcep) && (
                    <p style={{ fontSize: "0.63rem", color: "var(--text-dimmer)", marginTop: 2 }}>
                      {[c.moi, c.gcep].filter(Boolean).join(" · ")}
                    </p>
                  )}
                </div>
                <span style={{ fontSize: "0.6rem", color: "var(--text-faintest)", flexShrink: 0 }}>↗</span>
              </div>
            </a>
          );
        })}
      </div>
      <div style={{ padding: "0.35rem 0.875rem 0.6rem", borderTop: "1px solid rgb(var(--c-surface) / 0.4)", display: "flex", flexWrap: "wrap", gap: 6 }}>
        {Object.entries(CLINGEN_STYLE).map(([label, s]) => (
          <div key={label} style={{ display: "flex", alignItems: "center", gap: 3 }}>
            <span style={{ fontSize: "0.58rem", padding: "0.1em 0.35em", borderRadius: 3, background: s.bg, color: s.color, border: `1px solid ${s.border}` }}>{label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── Structural variants (dbVar) ──────────────────────────────────────────────

/**
 * The disease–phenotype network.
 *
 * Diseases on the left, phenotypes on the right, links between. A
 * force-directed graph was the obvious choice and the wrong one: six diseases
 * and a hundred phenotypes settle into a hairball whose only legible message
 * is "there are many things". The finding here is which phenotypes several of
 * a gene's diseases *share*, and a bipartite layout states that outright.
 *
 * Layout is in network.js and tested. This is SVG and hover state.
 */
function DiseaseNetworkPanel({ data, geneName }) {
  const [focus, setFocus] = useState(null);   // {type:"disease"|"phenotype", index}

  const graph = useMemo(() => buildNetwork(data), [data]);
  if (!graph.diseases.length) return null;

  const W = 680;
  const ROW = 26;
  const H = Math.max(graph.diseases.length, graph.phenotypes.length) * ROW + 20;
  const LEFT = 250;         // right edge of the disease column
  const RIGHT = W - 250;    // left edge of the phenotype column

  const dY = (i) => i * ROW + (H - graph.diseases.length * ROW) / 2 + 12;
  const pY = (i) => i * ROW + (H - graph.phenotypes.length * ROW) / 2 + 12;

  const lit = (link) => {
    if (!focus) return false;
    return focus.type === "disease" ? link.disease === focus.index : link.phenotype === focus.index;
  };
  const dimmed = (kind, i) => {
    if (!focus) return false;
    if (focus.type === kind && focus.index === i) return false;
    return !graph.links.some(l => lit(l) && (kind === "disease" ? l.disease === i : l.phenotype === i));
  };

  return (
    <div style={{ marginTop: "1rem", background: "rgb(var(--c-deep) / 0.6)", border: "1px solid rgb(var(--c-success) / 0.18)", borderRadius: 12, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0.625rem 0.875rem", borderBottom: "1px solid rgb(var(--c-success) / 0.1)", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: "0.78rem", fontWeight: 600, color: "var(--success-soft)" }}>Disease &amp; Phenotype Relationships</span>
        <span style={{ fontSize: "0.68rem", color: "var(--text-faintest)" }}>
          {graph.diseases.length} conditions · {graph.phenotypes.length} features · HPO / ClinGen
        </span>
      </div>

      <p style={{ fontSize: "0.65rem", color: "var(--text-dimmer)", padding: "0.5rem 0.875rem 0", lineHeight: 1.5, margin: 0 }}>
        Conditions linked to {geneName || "this gene"}, and the features they
        produce.{graph.shared > 0 && (
          <> <strong style={{ color: "var(--text-dim)" }}>{graph.shared} feature{graph.shared === 1 ? " appears" : "s appear"} in more than one</strong> — hover anything to isolate its connections.</>
        )}
      </p>

      <div style={{ padding: "0.5rem 0.875rem 0", overflowX: "auto" }}>
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: "block", minWidth: 560 }}
          role="img" aria-label={`${graph.diseases.length} conditions linked to ${graph.phenotypes.length} clinical features`}>

          {graph.links.map((l, i) => {
            const y0 = dY(l.disease) ;
            const y1 = pY(l.phenotype);
            const on = lit(l);
            const mid = (LEFT + RIGHT) / 2;
            return (
              <path key={i}
                d={`M${LEFT} ${y0} C${mid} ${y0}, ${mid} ${y1}, ${RIGHT} ${y1}`}
                fill="none"
                stroke={l.shared ? "var(--accent)" : "var(--text-dim)"}
                strokeWidth={on ? 1.6 : 0.8}
                opacity={focus ? (on ? 0.85 : 0.06) : 0.1 + l.weight * 0.22} />
            );
          })}

          {graph.diseases.map((d, i) => {
            const y = dY(i);
            const faded = dimmed("disease", i);
            return (
              <g key={d.key} style={{ cursor: "pointer" }}
                onMouseEnter={() => setFocus({ type: "disease", index: i })}
                onMouseLeave={() => setFocus(null)}>
                <rect x={0} y={y - 11} width={LEFT} height={22} fill="transparent" />
                <circle cx={LEFT - 5} cy={y} r={focus?.type === "disease" && focus.index === i ? 5 : 4}
                  fill={evidenceColor(d.classification)} opacity={faded ? 0.25 : 1} />
                <text x={LEFT - 14} y={y + 3.5} textAnchor="end" fontSize={10.5}
                  fill="var(--text-muted)" opacity={faded ? 0.28 : 1}>
                  {d.name.length > 34 ? `${d.name.slice(0, 32)}…` : d.name}
                </text>
                <text x={LEFT - 14} y={y + 13.5} textAnchor="end" fontSize={7.5}
                  fill="var(--text-dimmer)" opacity={faded ? 0.25 : 1}>
                  {[d.classification, d.inheritance, d.geneTotal ? `${d.geneTotal} genes` : null]
                    .filter(Boolean).join(" · ") || "not curated by ClinGen"}
                </text>
              </g>
            );
          })}

          {graph.phenotypes.map((p, i) => {
            const y = pY(i);
            const faded = dimmed("phenotype", i);
            return (
              <g key={p.key} style={{ cursor: "pointer" }}
                onMouseEnter={() => setFocus({ type: "phenotype", index: i })}
                onMouseLeave={() => setFocus(null)}>
                <rect x={RIGHT} y={y - 10} width={W - RIGHT} height={20} fill="transparent" />
                <circle cx={RIGHT + 5} cy={y} r={p.shared ? 4.5 : 3}
                  fill={p.shared ? "var(--accent)" : "var(--text-dim)"} opacity={faded ? 0.25 : 1} />
                <text x={RIGHT + 14} y={y + 3.5} fontSize={10}
                  fill={p.shared ? "var(--text-muted)" : "var(--text-dim)"}
                  fontWeight={p.shared ? 600 : 400} opacity={faded ? 0.28 : 1}>
                  {p.name.length > 30 ? `${p.name.slice(0, 28)}…` : p.name}
                  {p.shared && (
                    <tspan fill="var(--accent)" fontSize={7.5}> ×{p.diseaseIndexes.length}</tspan>
                  )}
                </text>
              </g>
            );
          })}
        </svg>
      </div>

      <div style={{ padding: "0.35rem 0.875rem 0.75rem" }}>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginBottom: 8 }}>
          {["Definitive", "Strong", "Moderate", "Limited"].map(c => (
            <span key={c} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
              <span style={{ width: 7, height: 7, borderRadius: "50%", background: evidenceColor(c) }} />
              <span style={{ fontSize: "0.6rem", color: "var(--text-dimmer)" }}>{c}</span>
            </span>
          ))}
          <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
            <span style={{ width: 7, height: 7, borderRadius: "50%", background: evidenceColor(null) }} />
            <span style={{ fontSize: "0.6rem", color: "var(--text-dimmer)" }}>Not curated</span>
          </span>
        </div>

        {graph.hidden > 0 && (
          <p style={{ fontSize: "0.62rem", color: "var(--text-faintest)", margin: "0 0 8px" }}>
            Showing the {graph.phenotypes.length} most characteristic of {graph.phenotypes.length + graph.hidden} features.
          </p>
        )}

        {data.related_genes?.length > 0 && (
          <div style={{ paddingTop: 8, borderTop: "1px solid rgb(var(--c-border) / 0.25)" }}>
            <p style={{ fontSize: "0.68rem", color: "var(--text-muted)", margin: "0 0 5px", fontWeight: 600 }}>
              Other genes behind these same conditions
            </p>
            <p style={{ fontSize: "0.63rem", color: "var(--text-dimmer)", margin: "0 0 7px", lineHeight: 1.5 }}>
              Found through shared disease membership, not a curated panel — these
              are genes a clinician would often consider alongside {geneName}.
            </p>
            <div style={{ display: "flex", flexWrap: "wrap", gap: 5 }}>
              {data.related_genes.slice(0, 18).map(g => (
                <span key={g.symbol} title={g.shared_diseases.join(" · ")}
                  style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: "0.68rem",
                           fontFamily: "monospace", padding: "0.2em 0.5em", borderRadius: 100,
                           background: "rgb(var(--c-success) / 0.1)",
                           border: "1px solid rgb(var(--c-success) / 0.25)", color: "var(--success-soft)" }}>
                  {g.symbol}
                  {g.count > 1 && <span style={{ fontSize: "0.58rem", opacity: 0.75 }}>×{g.count}</span>}
                </span>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Structural variants, drawn to scale against the gene they affect.
 *
 * The lollipop map cannot express these: a whole-exon deletion has no single
 * residue, and its meaning lives entirely in how much of the gene it removes.
 * Here a 23 Mb copy-number loss and a 2.8% deletion look as different as they
 * are — which is the whole reason for a second, genomic axis.
 *
 * Geometry is in spans.js and tested. This is only SVG.
 */
function StructuralVariantsPanel({ data, locus, geneName }) {
  const [hover, setHover] = useState(null);

  const { rows, gene } = useMemo(
    () => layoutSpans(data?.variants, locus),
    [data, locus],
  );

  if (!data?.variants?.length) return null;

  // Without a GRCh37 locus there is nothing to draw against, so the panel
  // falls back to naming the variants rather than showing nothing at all.
  const drawable = rows.length > 0 && gene;
  const legend = spanLegend(rows);
  const shown = drawable ? rows.slice(0, 12) : [];
  const ROW_H = 17;
  const H = shown.length * ROW_H;

  return (
    <div style={{ marginTop: "1rem", background: "rgb(var(--c-deep) / 0.6)", border: "1px solid rgb(var(--c-violet) / 0.18)", borderRadius: 12, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0.625rem 0.875rem", borderBottom: "1px solid rgb(var(--c-violet) / 0.1)", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: "0.78rem", fontWeight: 600, color: "var(--violet)" }}>Structural Variants</span>
        <span style={{ fontSize: "0.68rem", color: "var(--text-faintest)" }}>
          dbVar · {data.variants.length} large pathogenic
          {data.matched > data.total ? ` of ${data.matched} reported` : ""}
        </span>
      </div>

      <p style={{ fontSize: "0.65rem", color: "var(--text-dimmer)", padding: "0.5rem 0.875rem 0", lineHeight: 1.5, margin: 0 }}>
        Deletions and duplications spanning 50 bp or more — the class of change
        that variant-by-variant testing does not detect. Drawn to scale against{" "}
        {geneName || "the gene"}; the bar behind them is the gene itself.
      </p>

      {drawable && (
        <div style={{ padding: "0.7rem 0.875rem 0", position: "relative" }}>
          <svg viewBox={`0 0 100 ${H + 16}`} preserveAspectRatio="none"
            width="100%" height={H + 16} role="img"
            aria-label={`${shown.length} structural variants drawn against ${geneName}`}
            style={{ display: "block", overflow: "visible" }}>

            {/* The gene body, behind everything, as the reference extent. */}
            <rect x={gene.x0 * 100} y={0} width={(gene.x1 - gene.x0) * 100} height={H}
              fill="rgb(var(--c-accent) / 0.10)" stroke="rgb(var(--c-accent) / 0.35)"
              strokeWidth={0.15} vectorEffect="non-scaling-stroke" />

            {shown.map((v, i) => {
              const y = i * ROW_H + 3;
              const on = hover?.accession === v.accession;
              return (
                <g key={v.accession} style={{ cursor: "pointer" }}
                  onMouseEnter={() => setHover(v)} onMouseLeave={() => setHover(null)}>
                  {/* Full-width hit target: the bars are thin. */}
                  <rect x={0} y={y - 3} width={100} height={ROW_H} fill="transparent" />
                  <rect x={v.x0 * 100} y={y} width={(v.x1 - v.x0) * 100} height={ROW_H - 7}
                    rx={0.4} fill={v.kind.color} opacity={on ? 1 : 0.75} />
                  {/* A variant running past the window is marked, not silently
                      squared off — otherwise a 23 Mb loss reads as ending here. */}
                  {v.clippedLeft && (
                    <path d={`M0 ${y}L0 ${y + ROW_H - 7}`} stroke={v.kind.color}
                      strokeWidth={1.2} vectorEffect="non-scaling-stroke" strokeDasharray="2 2" />
                  )}
                  {v.clippedRight && (
                    <path d={`M100 ${y}L100 ${y + ROW_H - 7}`} stroke={v.kind.color}
                      strokeWidth={1.2} vectorEffect="non-scaling-stroke" strokeDasharray="2 2" />
                  )}
                </g>
              );
            })}
          </svg>

          {/* Gene label sits outside the SVG so it is not stretched by
              preserveAspectRatio="none". */}
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: "0.6rem", color: "var(--text-faintest)", marginTop: 2 }}>
            <span>chr{locus.chromosome}:{Number(gene.start).toLocaleString()}</span>
            <span style={{ color: "var(--accent)" }}>{geneName} · GRCh37</span>
            <span>{Number(gene.end).toLocaleString()}</span>
          </div>

          {hover && (
            <div style={{ position: "absolute", top: 4, left: "50%", transform: "translateX(-50%)", zIndex: 10,
                          background: "rgb(var(--c-deep) / 0.97)", border: `1px solid ${hover.kind.color}66`,
                          borderRadius: 8, padding: "0.45rem 0.65rem", pointerEvents: "none",
                          minWidth: 200, boxShadow: "0 4px 20px rgb(var(--c-shadow) / 0.5)" }}>
              <p style={{ fontFamily: "monospace", fontSize: "0.72rem", color: "var(--violet-faint)", fontWeight: 600 }}>
                {hover.accession}
              </p>
              <p style={{ fontSize: "0.68rem", color: hover.kind.color, marginTop: 2 }}>{hover.kind.label}</p>
              <p style={{ fontSize: "0.65rem", color: "var(--text-dim)", marginTop: 2 }}>
                {formatBp(hover.span_bp) || "size unknown"}
                {" · covers "}
                <strong style={{ color: "var(--text-muted)" }}>
                  {hover.coverage >= 0.995 ? "all" : `${Math.round(hover.coverage * 100)}%`}
                </strong>
                {" of "}{geneName}
              </p>
            </div>
          )}
        </div>
      )}

      <div style={{ padding: "0.6rem 0.875rem 0.75rem" }}>
        {drawable && legend.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 9, marginBottom: 8 }}>
            {legend.map(k => (
              <span key={k.key} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                <span style={{ width: 9, height: 6, borderRadius: 1, background: k.color }} />
                <span style={{ fontSize: "0.6rem", color: "var(--text-dimmer)" }}>{k.label}</span>
              </span>
            ))}
          </div>
        )}

        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          {(drawable ? shown : rows.length ? rows : data.variants).map((v) => (
            <a key={v.accession} href={v.url} target="_blank" rel="noreferrer"
              style={{ textDecoration: "none" }}
              onMouseEnter={() => drawable && setHover(v)} onMouseLeave={() => setHover(null)}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "0.3rem 0.5rem",
                            background: hover?.accession === v.accession ? "rgb(var(--c-surface) / 0.6)" : "rgb(var(--c-surface) / 0.28)",
                            border: "1px solid rgb(var(--c-border) / 0.22)", borderRadius: 6 }}>
                <span style={{ width: 9, height: 6, borderRadius: 1, flexShrink: 0,
                               background: (v.kind || svKind(v.variant_type)).color }} />
                <span style={{ fontFamily: "monospace", fontSize: "0.65rem", color: "var(--text-dim)", flexShrink: 0 }}>{v.accession}</span>
                <span style={{ fontSize: "0.65rem", color: "var(--text-dimmer)", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {v.variant_type || "structural variant"}
                </span>
                <span style={{ fontSize: "0.63rem", color: "var(--text-dim)", flexShrink: 0, fontVariantNumeric: "tabular-nums" }}>
                  {formatBp(v.span_bp) || "—"}
                </span>
              </div>
            </a>
          ))}
        </div>

        {drawable && rows.length > shown.length && (
          <p style={{ fontSize: "0.62rem", color: "var(--text-faintest)", margin: "6px 0 0" }}>
            Showing the {shown.length} largest of {rows.length}.
          </p>
        )}
        {!drawable && (
          <p style={{ fontSize: "0.62rem", color: "var(--text-faintest)", margin: "6px 0 0" }}>
            Positions unavailable for this gene, so these are listed rather than mapped.
          </p>
        )}
      </div>
    </div>
  );
}

// ─── Clinically available tests (GTR) ─────────────────────────────────────────

function GeneticTestsPanel({ data }) {
  const [expanded, setExpanded] = useState(false);
  if (!data?.tests?.length) return null;
  const shown = expanded ? data.tests : data.tests.slice(0, 5);
  return (
    <div style={{ marginTop: "1rem", background: "rgb(var(--c-deep) / 0.6)", border: "1px solid rgb(var(--c-accent) / 0.18)", borderRadius: 12, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0.625rem 0.875rem", borderBottom: "1px solid rgb(var(--c-accent) / 0.1)", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: "0.78rem", fontWeight: 600, color: "var(--accent)" }}>Clinical Tests Available</span>
        <span style={{ fontSize: "0.68rem", color: "var(--text-faintest)" }}>
          GTR · {data.total} registered
        </span>
      </div>
      <div style={{ padding: "0.75rem", display: "flex", flexDirection: "column", gap: 6 }}>
        {shown.map((t) => (
          <a key={t.id} href={t.url} target="_blank" rel="noreferrer" style={{ textDecoration: "none" }}>
            <div style={{ padding: "0.5rem 0.65rem", background: "rgb(var(--c-surface) / 0.3)", border: "1px solid rgb(var(--c-border) / 0.25)", borderRadius: 8 }}
              onMouseEnter={e => e.currentTarget.style.borderColor = "rgb(var(--c-accent) / 0.3)"}
              onMouseLeave={e => e.currentTarget.style.borderColor = "rgb(var(--c-border) / 0.25)"}
            >
              <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                <p style={{ fontSize: "0.73rem", color: "var(--text-faint)", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{t.name}</p>
                {t.test_type && (
                  <span style={{ fontSize: "0.6rem", color: "var(--text-faintest)", flexShrink: 0 }}>{t.test_type}</span>
                )}
              </div>
              {t.lab && <p style={{ fontSize: "0.63rem", color: "var(--text-dimmer)", marginTop: 2 }}>{t.lab}</p>}
              {t.conditions?.length > 0 && (
                <p style={{ fontSize: "0.63rem", color: "var(--text-dimmer)", marginTop: 2 }}>
                  {t.conditions.slice(0, 2).join(" · ")}
                  {t.genes_tested?.length > 1 ? ` · ${t.genes_tested.length} genes on panel` : ""}
                </p>
              )}
            </div>
          </a>
        ))}
      </div>
      <div style={{ padding: "0 0.875rem 0.7rem", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
        {data.tests.length > 5 && (
          <button onClick={() => setExpanded(v => !v)}
            style={{ background: "none", border: "none", color: "var(--accent)", cursor: "pointer", fontSize: "0.66rem", padding: 0 }}>
            {expanded ? "Show fewer" : `Show all ${data.tests.length} shown`}
          </button>
        )}
        <a href={data.registry_url} target="_blank" rel="noreferrer" style={{ fontSize: "0.63rem", color: "var(--text-dimmer)", marginLeft: "auto" }}>
          Full registry ↗
        </a>
      </div>
      <p style={{ fontSize: "0.62rem", color: "var(--text-faintest)", padding: "0 0.875rem 0.7rem", margin: 0, lineHeight: 1.5 }}>
        Listing a test is not a recommendation. Ordering one generally requires a
        clinician or genetic counsellor.
      </p>
    </div>
  );
}

// ─── Medical genetics concepts (MedGen) ───────────────────────────────────────

function MedGenPanel({ data }) {
  if (!data?.concepts?.length) return null;
  return (
    <div style={{ marginTop: "1rem", background: "rgb(var(--c-deep) / 0.6)", border: "1px solid rgb(var(--c-border) / 0.35)", borderRadius: 12, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0.625rem 0.875rem", borderBottom: "1px solid rgb(var(--c-border) / 0.2)" }}>
        <span style={{ fontSize: "0.78rem", fontWeight: 600, color: "var(--text-muted)" }}>Linked Conditions</span>
        <span style={{ fontSize: "0.68rem", color: "var(--text-faintest)" }}>MedGen · {data.concepts.length}</span>
      </div>
      <div style={{ padding: "0.75rem", display: "flex", flexDirection: "column", gap: 6 }}>
        {data.concepts.map((c, i) => (
          <a key={i} href={c.url} target="_blank" rel="noreferrer" style={{ textDecoration: "none" }}>
            <div style={{ padding: "0.5rem 0.65rem", background: "rgb(var(--c-surface) / 0.3)", border: "1px solid rgb(var(--c-border) / 0.25)", borderRadius: 8 }}
              onMouseEnter={e => e.currentTarget.style.borderColor = "rgb(var(--c-border) / 0.5)"}
              onMouseLeave={e => e.currentTarget.style.borderColor = "rgb(var(--c-border) / 0.25)"}
            >
              <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                <p style={{ fontSize: "0.73rem", color: "var(--text-faint)", flex: 1, minWidth: 0 }}>{c.name}</p>
                {c.concept_id && (
                  <span style={{ fontSize: "0.6rem", color: "var(--text-faintest)", fontFamily: "monospace", flexShrink: 0 }}>{c.concept_id}</span>
                )}
              </div>
              {c.definition && (
                <p style={{ fontSize: "0.64rem", color: "var(--text-dimmer)", marginTop: 3, lineHeight: 1.5 }}>
                  {c.definition.length > 220 ? `${c.definition.slice(0, 220)}…` : c.definition}
                </p>
              )}
            </div>
          </a>
        ))}
      </div>
    </div>
  );
}

// ─── Open-access full text (PMC) ──────────────────────────────────────────────

function FullTextPanel({ data }) {
  if (!data?.articles?.length) return null;
  return (
    <div style={{ marginTop: "1rem", background: "rgb(var(--c-deep) / 0.6)", border: "1px solid rgb(var(--c-border) / 0.35)", borderRadius: 12, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0.625rem 0.875rem", borderBottom: "1px solid rgb(var(--c-border) / 0.2)", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: "0.78rem", fontWeight: 600, color: "var(--text-muted)" }}>Full-Text Papers</span>
        <span style={{ fontSize: "0.68rem", color: "var(--text-faintest)" }}>
          PMC · {data.total.toLocaleString()} open access
        </span>
      </div>
      <div style={{ padding: "0.75rem", display: "flex", flexDirection: "column", gap: 6 }}>
        {data.articles.map((a) => (
          <a key={a.pmcid} href={a.url} target="_blank" rel="noreferrer" style={{ textDecoration: "none" }}>
            <div style={{ padding: "0.5rem 0.65rem", background: "rgb(var(--c-surface) / 0.3)", border: "1px solid rgb(var(--c-border) / 0.25)", borderRadius: 8 }}
              onMouseEnter={e => e.currentTarget.style.borderColor = "rgb(var(--c-border) / 0.5)"}
              onMouseLeave={e => e.currentTarget.style.borderColor = "rgb(var(--c-border) / 0.25)"}
            >
              <p style={{ fontSize: "0.72rem", color: "var(--text-faint)", lineHeight: 1.45 }}>{a.title}</p>
              <p style={{ fontSize: "0.62rem", color: "var(--text-dimmer)", marginTop: 3 }}>
                {[
                  a.authors?.length
                    ? `${a.authors[0]}${a.author_count > a.authors.length ? " et al." : ""}`
                    : null,
                  a.journal,
                  a.pubdate,
                ].filter(Boolean).join(" · ")}
              </p>
            </div>
          </a>
        ))}
      </div>
    </div>
  );
}

// ─── The reader's own variants in this gene ───────────────────────────────────

/**
 * Which of an uploaded file's variants fall inside the gene being discussed.
 *
 * The intersection happens in the browser against GRCh37 coordinates — no part
 * of the reader's file is sent anywhere to compute it. Annotation is opt-in and
 * explicit, because that request does disclose which variants they carry.
 */
function MyVariantsPanel({ dnaData, locus, gene }) {
  const [annotations, setAnnotations] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const hits = useMemo(() => variantsInLocus(dnaData, locus), [dnaData, locus]);
  if (!hits.length) return null;

  const annotate = async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(`${API}/dna/annotate`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ rsids: hits.slice(0, 200).map(h => h.rsid) }),
      });
      if (!r.ok) throw new Error(`dbSNP lookup failed (${r.status})`);
      const { annotations: got } = await r.json();
      setAnnotations(got || {});
    } catch (e) {
      setError(e.message || "Could not reach dbSNP");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div style={{ marginTop: "1rem", background: "rgb(var(--c-deep) / 0.6)", border: "1px solid rgb(var(--c-accent) / 0.25)", borderRadius: 12, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0.625rem 0.875rem", borderBottom: "1px solid rgb(var(--c-accent) / 0.12)", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: "0.78rem", fontWeight: 600, color: "var(--accent)" }}>
          🧬 Your Variants in {gene}
        </span>
        <span style={{ fontSize: "0.68rem", color: "var(--text-faintest)" }}>
          {hits.length} of your file · GRCh37
        </span>
      </div>

      <div style={{ padding: "0.75rem", display: "flex", flexDirection: "column", gap: 5 }}>
        {hits.slice(0, 40).map((h) => {
          const a = annotations?.[h.rsid];
          const sig = a?.clinical_significance?.filter(s => /pathogenic|risk|association|drug/i.test(s)) || [];
          return (
            <div key={h.rsid} style={{ padding: "0.45rem 0.6rem", background: "rgb(var(--c-surface) / 0.3)", border: "1px solid rgb(var(--c-border) / 0.25)", borderRadius: 8, display: "flex", alignItems: "center", gap: 10 }}>
              <span style={{ fontFamily: "monospace", fontSize: "0.7rem", color: "var(--text-muted)", flexShrink: 0, minWidth: 88 }}>{h.rsid}</span>
              <span style={{ fontFamily: "monospace", fontSize: "0.72rem", fontWeight: 700, color: "var(--accent)", flexShrink: 0, minWidth: 30 }}>{h.genotype}</span>
              <div style={{ flex: 1, minWidth: 0 }}>
                {a ? (
                  <p style={{ fontSize: "0.63rem", color: "var(--text-dimmer)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {[a.consequences?.[0]?.replace(/_/g, " "),
                      a.maf != null ? `${(a.maf * 100).toFixed(1)}% population` : null,
                     ].filter(Boolean).join(" · ") || "no annotation"}
                  </p>
                ) : (
                  <p style={{ fontSize: "0.63rem", color: "var(--text-faintest)", fontFamily: "monospace" }}>chr{h.chromosome}:{h.position}</p>
                )}
              </div>
              {sig.length > 0 && (
                <span style={{ fontSize: "0.6rem", padding: "0.15em 0.45em", borderRadius: 4, background: "rgb(var(--c-warning) / 0.12)", color: "var(--warning)", border: "1px solid rgb(var(--c-warning) / 0.3)", flexShrink: 0, whiteSpace: "nowrap" }}>
                  {sig[0].replace(/-/g, " ")}
                </span>
              )}
              {a && (
                <a href={a.url} target="_blank" rel="noreferrer" style={{ fontSize: "0.6rem", color: "var(--text-faintest)", flexShrink: 0 }}>↗</a>
              )}
            </div>
          );
        })}
        {hits.length > 40 && (
          <p style={{ fontSize: "0.63rem", color: "var(--text-faintest)", margin: "2px 0 0" }}>
            …and {hits.length - 40} more in this gene.
          </p>
        )}
      </div>

      <div style={{ padding: "0 0.875rem 0.75rem" }}>
        {!annotations && (
          <button onClick={annotate} disabled={loading}
            style={{ width: "100%", padding: "0.45rem", borderRadius: 8, background: "rgb(var(--c-accent) / 0.1)", border: "1px solid rgb(var(--c-accent) / 0.3)", color: "var(--accent)", cursor: loading ? "default" : "pointer", fontSize: "0.68rem", opacity: loading ? 0.6 : 1 }}>
            {loading ? "Looking up…" : "Look up what these mean (dbSNP)"}
          </button>
        )}
        {error && <p style={{ fontSize: "0.65rem", color: "var(--danger)", margin: "6px 0 0" }}>{error}</p>}
        <p style={{ fontSize: "0.61rem", color: "var(--text-faintest)", margin: "6px 0 0", lineHeight: 1.5 }}>
          {annotations
            ? "Annotations from NCBI dbSNP. Carrying a variant is not a diagnosis — significance depends on context a raw file cannot supply."
            : "Matched on your device — nothing from your file has been sent. Looking these up sends only these rsIDs to NCBI."}
        </p>
      </div>
    </div>
  );
}

// ─── Publication Timeline ─────────────────────────────────────────────────────

function PublicationTimeline({ timeline }) {
  if (!timeline?.length) return null;
  const hasData = timeline.some(t => t.count > 0);
  if (!hasData) return null;

  const max = Math.max(...timeline.map(t => t.count), 1);
  const BAR_H = 80;

  return (
    <div style={{ marginTop: "1rem", background: "rgb(var(--c-deep) / 0.6)", border: "1px solid rgb(var(--c-warning) / 0.18)", borderRadius: 12, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0.625rem 0.875rem", borderBottom: "1px solid rgb(var(--c-warning) / 0.1)" }}>
        <span style={{ fontSize: "0.78rem", fontWeight: 600, color: "var(--warning)" }}>Publication Timeline</span>
        <span style={{ fontSize: "0.68rem", color: "var(--text-faintest)" }}>PubMed · papers per year</span>
      </div>
      <div style={{ padding: "0.75rem 0.875rem 0.6rem" }}>
        <div style={{ display: "flex", alignItems: "flex-end", gap: 4, height: BAR_H + 24 }}>
          {timeline.map(({ year, count }) => {
            const barH = count > 0 ? Math.max(4, Math.round((count / max) * BAR_H)) : 2;
            const opacity = count > 0 ? 0.7 + 0.3 * (count / max) : 0.15;
            return (
              <div key={year} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 3 }}
                title={`${year}: ${count.toLocaleString()} publications`}>
                <span style={{ fontSize: "0.58rem", color: count > 0 ? "var(--warning)" : "var(--text-disabled)", lineHeight: 1 }}>
                  {count > 0 ? (count >= 1000 ? `${(count/1000).toFixed(1)}k` : count) : ""}
                </span>
                <div style={{ width: "100%", height: barH, background: `rgba(251,191,36,${opacity})`, borderRadius: "3px 3px 0 0", transition: "height 0.3s" }} />
                <span style={{ fontSize: "0.58rem", color: "var(--text-dimmer)", transform: "rotate(-45deg)", transformOrigin: "top center", marginTop: 2, whiteSpace: "nowrap" }}>
                  {String(year).slice(2)}
                </span>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ─── GWAS Panel ──────────────────────────────────────────────────────────────

function GWASPanel({ gwas }) {
  if (!gwas?.length) return null;

  const sigColor = (p) => {
    if (p === null || p === undefined) return "var(--text-faint)";
    if (p < 5e-8) return "var(--danger)";   // genome-wide significant
    if (p < 1e-5) return "var(--warning-soft)";   // suggestive
    return "var(--warning)";                  // nominal
  };

  return (
    <div style={{ marginTop: "1rem", background: "rgb(var(--c-deep) / 0.6)", border: "1px solid rgb(var(--c-danger) / 0.18)", borderRadius: 12, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0.625rem 0.875rem", borderBottom: "1px solid rgb(var(--c-danger) / 0.1)" }}>
        <span style={{ fontSize: "0.78rem", fontWeight: 600, color: "var(--danger)" }}>GWAS Catalog</span>
        <span style={{ fontSize: "0.68rem", color: "var(--text-faintest)" }}>Trait associations · {gwas.length} results</span>
      </div>
      <div style={{ padding: "0.75rem", display: "flex", flexDirection: "column", gap: 5 }}>
        {gwas.map((a, i) => (
          <a key={i} href={a.url} target="_blank" rel="noreferrer" style={{ textDecoration: "none" }}>
            <div style={{ padding: "0.45rem 0.65rem", background: "rgb(var(--c-surface) / 0.3)", border: "1px solid rgb(var(--c-border) / 0.25)", borderRadius: 8, display: "flex", alignItems: "center", gap: 10 }}
              onMouseEnter={e => e.currentTarget.style.borderColor = "rgb(var(--c-danger) / 0.3)"}
              onMouseLeave={e => e.currentTarget.style.borderColor = "rgb(var(--c-border) / 0.25)"}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <p style={{ fontSize: "0.73rem", color: "var(--text-secondary)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.trait}</p>
                <div style={{ display: "flex", gap: 8, marginTop: 2, alignItems: "center" }}>
                  {a.risk_allele && <span style={{ fontSize: "0.62rem", color: "var(--text-dim)" }}>{a.risk_allele}</span>}
                  {a.or_beta != null && <span style={{ fontSize: "0.62rem", color: "var(--text-dim)" }}>OR/β={a.or_beta.toFixed(2)}</span>}
                  {a.pmid && <span style={{ fontSize: "0.62rem", color: "var(--text-dimmer)" }}>PMID:{a.pmid}</span>}
                </div>
              </div>
              <span style={{ fontSize: "0.65rem", fontFamily: "monospace", color: sigColor(a.p_value), flexShrink: 0, whiteSpace: "nowrap" }}>
                {a.p_value_str !== "N/A" ? `p=${a.p_value_str}` : "p=N/A"}
              </span>
            </div>
          </a>
        ))}
      </div>
      <div style={{ padding: "0.35rem 0.875rem 0.5rem", borderTop: "1px solid rgb(var(--c-surface) / 0.4)", display: "flex", gap: 12, alignItems: "center" }}>
        {[["< 5×10⁻⁸", "var(--danger)", "Genome-wide"], ["< 1×10⁻⁵", "var(--warning-soft)", "Suggestive"], ["other", "var(--warning)", "Nominal"]].map(([thr, col, lbl]) => (
          <div key={lbl} style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <div style={{ width: 7, height: 7, borderRadius: "50%", background: col }} />
            <span style={{ fontSize: "0.62rem", color: "var(--text-dimmer)" }}>{lbl}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

// ─── HPO + Monarch Phenotype Panel ───────────────────────────────────────────

function PhenotypePanel({ hpo, monarch }) {
  const [activeTab, setActiveTab] = useState("hpo");

  const hpoTerms = hpo?.phenotype_terms || [];
  const hpoDiseases = hpo?.disease_associations || [];
  const monarchDiseases = monarch?.diseases || [];
  const monarchPhenos = monarch?.phenotypes || [];

  const hasHPO = hpoTerms.length > 0 || hpoDiseases.length > 0;
  const hasMonarch = monarchDiseases.length > 0 || monarchPhenos.length > 0;
  if (!hasHPO && !hasMonarch) return null;

  const Tab = ({ id, label, count }) => (
    <button onClick={() => setActiveTab(id)} style={{
      fontSize: "0.7rem", padding: "0.3rem 0.65rem", border: "none", cursor: "pointer",
      background: activeTab === id ? "rgb(var(--c-violet) / 0.15)" : "transparent",
      color: activeTab === id ? "var(--violet)" : "var(--text-dimmer)",
      borderBottom: activeTab === id ? "2px solid var(--violet)" : "2px solid transparent",
    }}>
      {label}{count > 0 ? <span style={{ marginLeft: 4, fontSize: "0.62rem", color: "var(--text-faintest)" }}>({count})</span> : null}
    </button>
  );

  return (
    <div style={{ marginTop: "1rem", background: "rgb(var(--c-deep) / 0.6)", border: "1px solid rgb(var(--c-violet) / 0.18)", borderRadius: 12, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0.625rem 0.875rem", borderBottom: "1px solid rgb(var(--c-violet) / 0.1)" }}>
        <span style={{ fontSize: "0.78rem", fontWeight: 600, color: "var(--violet)" }}>Phenotype Associations</span>
        <span style={{ fontSize: "0.68rem", color: "var(--text-faintest)" }}>HPO · Monarch Initiative</span>
      </div>

      {/* Tabs */}
      <div style={{ display: "flex", borderBottom: "1px solid rgb(var(--c-surface) / 0.5)", paddingLeft: "0.5rem" }}>
        {hasHPO && <Tab id="hpo" label="HPO Terms" count={hpoTerms.length} />}
        {hpoDiseases.length > 0 && <Tab id="hpo_disease" label="HPO Diseases" count={hpoDiseases.length} />}
        {hasMonarch && <Tab id="monarch" label="Monarch" count={monarchDiseases.length + monarchPhenos.length} />}
      </div>

      <div style={{ padding: "0.65rem 0.75rem", maxHeight: 260, overflowY: "auto" }}>
        {activeTab === "hpo" && hpoTerms.map((t, i) => (
          <a key={i} href={t.url} target="_blank" rel="noreferrer" style={{ textDecoration: "none" }}>
            <div style={{ padding: "0.4rem 0.6rem", marginBottom: 4, background: "rgb(var(--c-surface) / 0.3)", border: "1px solid rgb(var(--c-border) / 0.2)", borderRadius: 7, display: "flex", gap: 8, alignItems: "flex-start" }}
              onMouseEnter={e => e.currentTarget.style.borderColor = "rgb(var(--c-violet) / 0.3)"}
              onMouseLeave={e => e.currentTarget.style.borderColor = "rgb(var(--c-border) / 0.2)"}
            >
              <span style={{ fontSize: "0.6rem", padding: "0.15em 0.4em", borderRadius: 4, background: "rgb(var(--c-violet) / 0.15)", color: "var(--violet)", border: "1px solid rgb(var(--c-violet) / 0.2)", flexShrink: 0, fontFamily: "monospace" }}>{t.id}</span>
              <div style={{ flex: 1 }}>
                <p style={{ fontSize: "0.72rem", color: "var(--text-secondary)" }}>{t.name}</p>
                {t.definition && <p style={{ fontSize: "0.62rem", color: "var(--text-dimmer)", marginTop: 1, lineHeight: 1.4 }}>{t.definition.slice(0, 120)}{t.definition.length > 120 ? "…" : ""}</p>}
              </div>
            </div>
          </a>
        ))}

        {activeTab === "hpo_disease" && hpoDiseases.map((d, i) => (
          <div key={i} style={{ padding: "0.4rem 0.6rem", marginBottom: 4, background: "rgb(var(--c-surface) / 0.3)", border: "1px solid rgb(var(--c-border) / 0.2)", borderRadius: 7, display: "flex", gap: 8, alignItems: "center" }}>
            {/* --violet, not --violet-soft: the latter is the same dark literal
                in both themes and sat at 2.39:1 on this violet-tinted badge in
                dark mode. It is left alone rather than lightened because the
                PDF export resolves it against a white page whatever the
                current theme, so a lighter value would break that instead. */}
            <span style={{ fontSize: "0.6rem", padding: "0.15em 0.4em", borderRadius: 4, background: "rgb(var(--c-violet) / 0.1)", color: "var(--violet)", border: "1px solid rgb(var(--c-violet) / 0.2)", flexShrink: 0, fontFamily: "monospace" }}>{d.db}</span>
            <p style={{ fontSize: "0.72rem", color: "var(--text-secondary)" }}>{d.name}</p>
          </div>
        ))}

        {activeTab === "monarch" && (
          <>
            {monarchDiseases.length > 0 && (
              <>
                <p style={{ fontSize: "0.65rem", color: "var(--text-dimmer)", marginBottom: 5, textTransform: "uppercase", letterSpacing: "0.08em" }}>Disease Associations</p>
                {monarchDiseases.map((d, i) => (
                  <a key={i} href={d.url} target="_blank" rel="noreferrer" style={{ textDecoration: "none" }}>
                    <div style={{ padding: "0.4rem 0.6rem", marginBottom: 4, background: "rgb(var(--c-surface) / 0.3)", border: "1px solid rgb(var(--c-border) / 0.2)", borderRadius: 7, display: "flex", gap: 8, alignItems: "center" }}
                      onMouseEnter={e => e.currentTarget.style.borderColor = "rgb(var(--c-violet) / 0.3)"}
                      onMouseLeave={e => e.currentTarget.style.borderColor = "rgb(var(--c-border) / 0.2)"}
                    >
                      <div style={{ flex: 1 }}>
                        <p style={{ fontSize: "0.72rem", color: "var(--text-secondary)" }}>{d.name}</p>
                        {d.predicate && <p style={{ fontSize: "0.62rem", color: "var(--text-dimmer)", marginTop: 1 }}>{d.predicate}</p>}
                      </div>
                      <span style={{ fontSize: "0.6rem", fontFamily: "monospace", color: "var(--text-faintest)" }}>↗</span>
                    </div>
                  </a>
                ))}
              </>
            )}
            {monarchPhenos.length > 0 && (
              <>
                <p style={{ fontSize: "0.65rem", color: "var(--text-dimmer)", margin: "8px 0 5px", textTransform: "uppercase", letterSpacing: "0.08em" }}>Phenotypic Features</p>
                {monarchPhenos.map((p, i) => (
                  <a key={i} href={p.url} target="_blank" rel="noreferrer" style={{ textDecoration: "none" }}>
                    <div style={{ padding: "0.35rem 0.6rem", marginBottom: 3, background: "rgb(var(--c-surface) / 0.2)", border: "1px solid rgb(var(--c-border) / 0.15)", borderRadius: 6 }}
                      onMouseEnter={e => e.currentTarget.style.borderColor = "rgb(var(--c-violet) / 0.25)"}
                      onMouseLeave={e => e.currentTarget.style.borderColor = "rgb(var(--c-border) / 0.15)"}
                    >
                      <p style={{ fontSize: "0.7rem", color: "var(--text-faint)" }}>{p.name}</p>
                    </div>
                  </a>
                ))}
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ─── PharmGKB Panel ──────────────────────────────────────────────────────────

const PGX_LEVEL_STYLE = {
  "1A": { color: "var(--success-soft)", bg: "rgb(var(--c-success) / 0.5)",   border: "rgb(var(--c-success) / 0.4)" },
  "1B": { color: "var(--success-soft)", bg: "rgb(var(--c-success) / 0.35)",  border: "rgb(var(--c-success) / 0.3)" },
  "2A": { color: "var(--accent-soft)", bg: "rgb(var(--c-accent) / 0.5)",   border: "rgb(var(--c-accent) / 0.4)" },
  "2B": { color: "var(--accent-soft)", bg: "rgb(var(--c-accent) / 0.4)",  border: "rgb(var(--c-accent) / 0.25)" },
  "3":  { color: "var(--warning-soft)", bg: "rgb(var(--c-warning) / 0.4)",   border: "rgb(var(--c-warning) / 0.3)" },
  "4":  { color: "var(--text-faint)", bg: "rgb(var(--c-surface) / 0.5)",  border: "rgb(var(--c-border) / 0.4)" },
};

function PharmGKBPanel({ pgkb }) {
  const [tab, setTab] = useState("annotations");
  if (!pgkb?.related_drugs?.length && !pgkb?.clinical_annotations?.length) return null;
  const annotations = pgkb.clinical_annotations || [];
  const relatedDrugs = pgkb.related_drugs || [];

  const tabBtn = (id, label, count) => (
    <button onClick={() => setTab(id)} style={{
      fontSize: "0.7rem", padding: "0.25rem 0.65rem", borderRadius: 6, cursor: "pointer", border: "none",
      background: tab === id ? "rgb(var(--c-accent) / 0.2)" : "transparent",
      color: tab === id ? "var(--accent)" : "var(--text-dimmer)",
      borderBottom: tab === id ? "2px solid var(--accent-strong)" : "2px solid transparent",
    }}>
      {label} {count > 0 && <span style={{ fontSize: "0.62rem", color: tab === id ? "var(--accent)" : "var(--text-disabled)" }}>({count})</span>}
    </button>
  );

  return (
    <div style={{ marginTop: "1rem", background: "rgb(var(--c-deep) / 0.6)", border: "1px solid rgb(var(--c-accent) / 0.2)", borderRadius: 12, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0.625rem 0.875rem", borderBottom: "1px solid rgb(var(--c-accent) / 0.12)" }}>
        <span style={{ fontSize: "0.78rem", fontWeight: 600, color: "var(--accent)" }}>Pharmacogenomics</span>
        <a href={pgkb.url} target="_blank" rel="noreferrer" style={{ fontSize: "0.68rem", color: "var(--text-faintest)", textDecoration: "none" }}>PharmGKB ↗</a>
      </div>

      {/* Tabs */}
      <div style={{ display: "flex", gap: 2, padding: "0 0.875rem", borderBottom: "1px solid rgb(var(--c-surface) / 0.5)" }}>
        {tabBtn("annotations", "Clinical Annotations", annotations.length)}
        {tabBtn("drugs", "Related Drugs", relatedDrugs.length)}
      </div>

      <div style={{ padding: "0.75rem" }}>
        {tab === "annotations" && (
          annotations.length === 0
            ? <p style={{ fontSize: "0.72rem", color: "var(--text-dimmer)", padding: "0.5rem 0" }}>No clinical annotations found for this gene.</p>
            : <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {annotations.map((ann, i) => {
                  const ls = PGX_LEVEL_STYLE[ann.level] || PGX_LEVEL_STYLE["4"];
                  return (
                    <a key={i} href={ann.url} target="_blank" rel="noreferrer" style={{ textDecoration: "none" }}>
                      <div style={{ padding: "0.5rem 0.65rem", background: "rgb(var(--c-surface) / 0.3)", border: "1px solid rgb(var(--c-border) / 0.25)", borderRadius: 8, display: "flex", gap: 10, alignItems: "flex-start" }}
                        onMouseEnter={e => e.currentTarget.style.borderColor = "rgb(var(--c-accent) / 0.3)"}
                        onMouseLeave={e => e.currentTarget.style.borderColor = "rgb(var(--c-border) / 0.25)"}
                      >
                        <span title={ann.level_label} style={{ fontSize: "0.65rem", padding: "0.2em 0.5em", borderRadius: 4, background: ls.bg, color: ls.color, border: `1px solid ${ls.border}`, flexShrink: 0, cursor: "help", whiteSpace: "nowrap" }}>
                          Level {ann.level}
                        </span>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          {ann.drugs.length > 0 && (
                            <p style={{ fontFamily: "monospace", fontSize: "0.75rem", color: "var(--text-secondary)", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                              {ann.drugs.join(", ")}
                            </p>
                          )}
                          {ann.phenotype && <p style={{ fontSize: "0.7rem", color: "var(--text-dim)", marginTop: 2 }}>{ann.phenotype}</p>}
                          {ann.variant && <p style={{ fontSize: "0.65rem", color: "var(--text-dimmer)", marginTop: 1, fontFamily: "monospace" }}>{ann.variant}</p>}
                        </div>
                        <span style={{ fontSize: "0.6rem", color: "var(--text-faintest)", flexShrink: 0 }}>↗</span>
                      </div>
                    </a>
                  );
                })}
              </div>
        )}

        {tab === "drugs" && (
          relatedDrugs.length === 0
            ? <p style={{ fontSize: "0.72rem", color: "var(--text-dimmer)", padding: "0.5rem 0" }}>No related drugs found.</p>
            : <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {/* ClinPGx has no stable per-drug page to link to, and an
                    anchor with no href looks clickable while doing nothing.
                    The evidence level is the more useful thing to show anyway:
                    level 1A is guideline-backed, level 4 is a case report. */}
                {relatedDrugs.map((d, i) => (
                  <span key={i} title={d.level_label || undefined}
                    style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: "0.72rem", padding: "0.25rem 0.65rem", borderRadius: 100, background: "rgb(var(--c-accent) / 0.1)", border: "1px solid rgb(var(--c-accent) / 0.2)", color: "var(--accent)" }}>
                    {d.name}
                    {d.level && (
                      <span style={{ fontSize: "0.6rem", fontWeight: 700, opacity: 0.75 }}>{d.level}</span>
                    )}
                  </span>
                ))}
              </div>
        )}
      </div>

      {/* Level legend */}
      {tab === "annotations" && annotations.length > 0 && (
        <div style={{ padding: "0.4rem 0.875rem 0.6rem", borderTop: "1px solid rgb(var(--c-surface) / 0.4)", display: "flex", flexWrap: "wrap", gap: 8 }}>
          {Object.entries(PGX_LEVEL_STYLE).map(([level, s]) => (
            <div key={level} style={{ display: "flex", alignItems: "center", gap: 3 }}>
              <span style={{ fontSize: "0.6rem", padding: "0.1em 0.35em", borderRadius: 3, background: s.bg, color: s.color, border: `1px solid ${s.border}` }}>{level}</span>
            </div>
          ))}
          <span style={{ fontSize: "0.6rem", color: "var(--text-faintest)", marginLeft: 4 }}>1A = highest evidence → 4 = case reports</span>
        </div>
      )}
    </div>
  );
}

// ─── Variant Domain Map (Lollipop) ───────────────────────────────────────────

const LOLLIPOP_SIG_COLOR = (sig) => {
  if (!sig) return "var(--text-faint)";
  const s = sig.toLowerCase();
  if (s.includes("pathogenic") && !s.includes("likely")) return "#ef4444";
  if (s.includes("likely pathogenic")) return "#f97316";
  if (s.includes("benign") && !s.includes("likely")) return "#22c55e";
  if (s.includes("likely benign")) return "#14b8a6";
  if (s.includes("uncertain")) return "#eab308";
  return "var(--text-faint)";
};

const DOMAIN_PALETTE = ["#3b82f6","#8b5cf6","#ec4899","#f59e0b","#10b981","#06b6d4","#f97316","#a855f7","#14b8a6","#6366f1"];

/**
 * The variant map: where in a protein each known variant sits, what kind of
 * damage it does, and how confident anyone is that it matters.
 *
 * Protein position is the axis a genome browser cannot offer, and it is the
 * one that answers the question a reader actually has. All 1,863 residues of
 * BRCA1 fit on one screen; its 81,000 bases of DNA do not, which is why the
 * NCBI Variation Viewer shows a 33-base window and cannot show a gene and its
 * variants legibly at the same time.
 *
 * Encoding is deliberately split across three channels so they can be read
 * independently: colour is clinical significance, shape is molecular
 * consequence, opacity is how much evidence stands behind the call. Geometry
 * and the encodings themselves live in lollipop.js, where they are tested.
 */
/** Neutral-coloured glyphs for the legend, where only shape carries meaning. */
const LEGEND_GLYPH = {
  square: <rect x={2} y={2} width={8} height={8} rx={1} fill="var(--text-dim)" />,
  diamond: <path d="M6 1L11 6L6 11L1 6Z" fill="var(--text-dim)" />,
  triangle: <path d="M6 1L11 10H1Z" fill="var(--text-dim)" />,
  hollow: <circle cx={6} cy={6} r={4} fill="none" stroke="var(--text-dim)" strokeWidth={1.5} />,
  dot: <circle cx={6} cy={6} r={2.4} fill="var(--text-dim)" />,
  circle: <circle cx={6} cy={6} r={4} fill="var(--text-dim)" />,
};

function LollipopMap({ variants, domains, proteinLength, geneName, dnaData }) {
  const svgRef = useRef(null);
  const [view, setView] = useState(() => fullView(proteinLength || 1));
  const [hover, setHover] = useState(null);
  const [pinned, setPinned] = useState(null);
  const [sigFilter, setSigFilter] = useState(() => new Set());
  const [conFilter, setConFilter] = useState(() => new Set());
  const [drag, setDrag] = useState(null);

  const W = 680, H = 250;
  const ML = 10, MR = 10;
  const barY = 176, barH = 20;
  const laneTop = 26, laneStep = 22;
  const userY = barY + barH + 30;

  const positioned = useMemo(
    () => positionVariants(variants, proteinLength),
    [variants, proteinLength],
  );
  const facets = useMemo(() => facetCounts(positioned), [positioned]);
  const filtered = useMemo(
    () => filterVariants(positioned, { significance: sigFilter, consequence: conFilter }),
    [positioned, sigFilter, conFilter],
  );
  const preparedDomains = useMemo(() => prepareDomains(domains), [domains]);
  const userMatches = useMemo(
    () => matchUserGenotypes(positioned, dnaData),
    [positioned, dnaData],
  );

  // A zoom, a pin and a set of filters are all specific to one protein —
  // "residues 1600–1700" and "only splice variants" mean nothing carried onto
  // a different gene. Callers pass `key={geneName}` so React remounts this
  // with fresh state instead of it having to unpick its own on a prop change.

  const plotW = W - ML - MR;
  const span = Math.max(view.end - view.start, 1);
  const toX = useCallback(
    (pos) => ML + ((pos - view.start) / span) * plotW,
    [view.start, span, plotW],
  );
  const toPos = useCallback(
    (x) => view.start + ((x - ML) / plotW) * span,
    [view.start, span, plotW],
  );

  /** Pointer position in SVG user units, which is what every hit test needs. */
  const svgX = useCallback((clientX) => {
    const el = svgRef.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    return ((clientX - rect.left) / rect.width) * W;
  }, []);

  const inView = useCallback(
    (pos) => pos >= view.start && pos <= view.end,
    [view.start, view.end],
  );

  const lanes = useMemo(() => {
    const visible = filtered
      .filter(v => inView(v.protein_position))
      .map(v => ({ ...v, x: toX(v.protein_position) }));
    return assignLanes(visible, { minGap: 11, maxLanes: 6 });
  }, [filtered, inView, toX]);

  // Wheel-to-zoom needs a non-passive listener: React's synthetic handler
  // cannot preventDefault here, so the page would scroll as well as the map.
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return undefined;
    const onWheel = (e) => {
      e.preventDefault();
      const focus = toPos(svgX(e.clientX));
      setView(v => zoomView(v, e.deltaY > 0 ? 1.25 : 0.8, focus, proteinLength));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [toPos, svgX, proteinLength]);

  if (!proteinLength) return null;
  if (!positioned.length && !preparedDomains.length) return null;

  const active = pinned || hover;
  const zoomed = !isFullView(view, proteinLength);

  const toggle = (setter) => (key) => setter(prev => {
    const next = new Set(prev);
    if (next.has(key)) next.delete(key); else next.add(key);
    return next;
  });

  const onPointerDown = (e) => {
    if (e.button !== 0) return;
    const x = svgX(e.clientX);
    setDrag({ from: x, to: x, moved: false });
    e.currentTarget.setPointerCapture?.(e.pointerId);
  };

  const onPointerMove = (e) => {
    if (!drag) return;
    const x = svgX(e.clientX);
    setDrag(d => (d ? { ...d, to: x, moved: Math.abs(x - d.from) > 3 } : d));
  };

  const onPointerUp = () => {
    if (!drag) return;
    // A drag across the plot selects a range to zoom into; a click without
    // movement clears the pinned variant rather than zooming to a sliver.
    if (drag.moved) {
      const a = toPos(Math.min(drag.from, drag.to));
      const b = toPos(Math.max(drag.from, drag.to));
      setView(clampView({ start: a, end: b }, proteinLength));
    } else {
      setPinned(null);
    }
    setDrag(null);
  };

  const onKeyDown = (e) => {
    const step = { ArrowLeft: -0.2, ArrowRight: 0.2 }[e.key];
    if (step !== undefined) {
      e.preventDefault();
      setView(v => panView(v, step, proteinLength));
    } else if (e.key === "+" || e.key === "=") {
      e.preventDefault();
      setView(v => zoomView(v, 0.7, (v.start + v.end) / 2, proteinLength));
    } else if (e.key === "-") {
      e.preventDefault();
      setView(v => zoomView(v, 1.4, (v.start + v.end) / 2, proteinLength));
    } else if (e.key === "Escape") {
      setView(fullView(proteinLength));
      setPinned(null);
    }
  };

  /** Glyph for one variant. Shape is consequence; colour is significance. */
  const glyph = (v, cx, cy, r, emphasis) => {
    const sig = significanceClass(v.clinical_significance);
    const con = consequenceClass(v.consequence);
    const common = {
      fill: con.glyph === "hollow" ? "none" : sig.color,
      stroke: con.glyph === "hollow" ? sig.color : (emphasis ? "var(--text)" : "none"),
      strokeWidth: con.glyph === "hollow" ? 1.6 : 1.2,
      // Evidence shows as opacity: a single-submitter call recedes behind an
      // expert-panel one without being hidden.
      opacity: emphasis ? 1 : 0.55 + 0.15 * evidenceLevel(v.review_status),
    };
    switch (con.glyph) {
      case "square":
        return <rect x={cx - r} y={cy - r} width={r * 2} height={r * 2} rx={1} {...common} />;
      case "diamond":
        return <path d={`M${cx} ${cy - r * 1.3}L${cx + r * 1.3} ${cy}L${cx} ${cy + r * 1.3}L${cx - r * 1.3} ${cy}Z`} {...common} />;
      case "triangle":
        return <path d={`M${cx} ${cy - r * 1.25}L${cx + r * 1.15} ${cy + r}L${cx - r * 1.15} ${cy + r}Z`} {...common} />;
      case "dot":
        return <circle cx={cx} cy={cy} r={r * 0.6} {...common} />;
      default:
        return <circle cx={cx} cy={cy} r={r} {...common} />;
    }
  };

  const ticks = [0, 0.25, 0.5, 0.75, 1].map(f => Math.round(view.start + f * span));

  const chip = (item, selected, onClick, color) => (
    <button key={item.key} onClick={() => onClick(item.key)}
      aria-pressed={selected}
      style={{
        display: "inline-flex", alignItems: "center", gap: 5, padding: "0.2rem 0.5rem",
        borderRadius: 100, cursor: "pointer", fontSize: "0.64rem",
        background: selected ? `${color}22` : "rgb(var(--c-surface) / 0.4)",
        border: `1px solid ${selected ? color : "rgb(var(--c-border) / 0.35)"}`,
        color: selected ? color : "var(--text-dimmer)",
      }}>
      {color && <span style={{ width: 7, height: 7, borderRadius: "50%", background: color, flexShrink: 0 }} />}
      {item.label}
      <span style={{ opacity: 0.65 }}>{item.count}</span>
    </button>
  );

  return (
    <div style={{ marginTop: "1rem", background: "rgb(var(--c-deep) / 0.6)", border: "1px solid rgb(var(--c-indigo) / 0.2)", borderRadius: 12, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0.625rem 0.875rem", borderBottom: "1px solid rgb(var(--c-indigo) / 0.12)", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: "0.78rem", fontWeight: 600, color: "var(--violet-faint)" }}>Variant Map</span>
        <span style={{ fontSize: "0.68rem", color: "var(--text-faintest)" }}>
          {filtered.length === positioned.length
            ? `${positioned.length} variants`
            : `${filtered.length} of ${positioned.length} variants`}
          {" · "}{proteinLength} aa · ClinVar / UniProt
        </span>
      </div>

      {/* Filters. Chips are counts of what is present, not a fixed vocabulary,
          so a gene with only truncating variants is not offered five dead
          options. */}
      {(facets.significance.length > 1 || facets.consequence.length > 1) && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 5, padding: "0.55rem 0.875rem 0" }}>
          {facets.significance.map(s => chip(s, sigFilter.has(s.key), toggle(setSigFilter), s.color))}
          {facets.consequence.length > 1 && (
            <span style={{ width: 1, alignSelf: "stretch", background: "rgb(var(--c-border) / 0.4)", margin: "0 3px" }} />
          )}
          {facets.consequence.map(c => chip(c, conFilter.has(c.key), toggle(setConFilter), null))}
        </div>
      )}

      <div style={{ padding: "0.6rem 0.875rem 0.75rem", position: "relative" }}>
        <svg ref={svgRef} viewBox={`0 0 ${W} ${H}`} width="100%"
          tabIndex={0} role="img" onKeyDown={onKeyDown}
          aria-label={`Variant map for ${geneName}: ${filtered.length} variants across ${proteinLength} amino acids`}
          onPointerDown={onPointerDown} onPointerMove={onPointerMove}
          onPointerUp={onPointerUp} onPointerLeave={() => { setDrag(null); setHover(null); }}
          style={{ display: "block", overflow: "visible", cursor: drag?.moved ? "col-resize" : "crosshair", outline: "none", touchAction: "none" }}>

          {/* Brush */}
          {drag?.moved && (
            <rect x={Math.min(drag.from, drag.to)} y={laneTop - 12}
              width={Math.abs(drag.to - drag.from)} height={barY + barH - laneTop + 12}
              fill="rgb(var(--c-accent) / 0.12)" stroke="rgb(var(--c-accent) / 0.5)" strokeWidth={1} />
          )}

          {/* Protein backbone */}
          <rect x={ML} y={barY} width={plotW} height={barH} rx={3}
            fill="rgb(var(--c-surface) / 0.9)" stroke="rgb(var(--c-indigo) / 0.3)" strokeWidth={1} />

          {/* Domains. Disordered regions are drawn faintly and unlabelled:
              eleven of BRCA1's annotations are those, and a map whose bands
              mostly read "Disordered" says nothing about which part matters. */}
          {preparedDomains.map((d, i) => {
            const x0 = Math.max(ML, toX(d.start));
            const x1 = Math.min(W - MR, toX(d.end));
            if (x1 <= ML || x0 >= W - MR) return null;
            const w = Math.max(1.5, x1 - x0);
            const color = DOMAIN_PALETTE[i % DOMAIN_PALETTE.length];
            return (
              <g key={`${d.name}-${d.start}`}>
                <rect x={x0} y={barY} width={w} height={barH} rx={2}
                  fill={color} opacity={d.structural ? 0.8 : 0.22} />
                {d.structural && w > 34 && (
                  <text x={x0 + w / 2} y={barY + barH / 2 + 3.5} textAnchor="middle"
                    fill="white" fontSize={8} fontWeight={600} style={{ pointerEvents: "none" }}>
                    {d.name.length > 16 ? `${d.name.slice(0, 14)}…` : d.name}
                  </text>
                )}
              </g>
            );
          })}

          {/* Axis */}
          {ticks.map((pos, i) => {
            const x = ML + (i / (ticks.length - 1)) * plotW;
            return (
              <g key={i}>
                <line x1={x} y1={barY + barH} x2={x} y2={barY + barH + 5} stroke="var(--border-solid)" strokeWidth={1} />
                <text x={x} y={barY + barH + 15} textAnchor="middle" fill="var(--text-dimmer)" fontSize={9}>{pos}</text>
              </g>
            );
          })}

          {/* Lollipops */}
          {lanes.placed.map((v) => {
            const cy = laneTop + v.lane * laneStep;
            const emphasis = active?.variant_id === v.variant_id;
            const sig = significanceClass(v.clinical_significance);
            const mine = userMatches.has(v.variant_id);
            return (
              <g key={v.variant_id} style={{ cursor: "pointer" }}
                onMouseEnter={() => setHover(v)}
                onMouseLeave={() => setHover(null)}
                // Without this the background handler runs first and clears the
                // pin, so the click that should unpin a variant re-pins it.
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => { e.stopPropagation(); setPinned(p => (p?.variant_id === v.variant_id ? null : v)); }}>
                <line x1={v.x} y1={cy} x2={v.x} y2={barY}
                  stroke={sig.color} strokeWidth={emphasis ? 1.6 : 1} opacity={emphasis ? 0.9 : 0.4} />
                {/* A halo marks a variant the reader actually carries. */}
                {mine && <circle cx={v.x} cy={cy} r={9} fill="none" stroke="var(--accent)" strokeWidth={1.5} opacity={0.9} />}
                {glyph(v, v.x, cy, emphasis ? 6 : 5, emphasis)}
                {/* Invisible, generous hit target — the glyphs are small. */}
                <circle cx={v.x} cy={cy} r={11} fill="transparent" />
              </g>
            );
          })}

          {/* The reader's own variants in this stretch of protein */}
          {userMatches.size > 0 && (
            <g>
              {filtered.filter(v => userMatches.has(v.variant_id) && inView(v.protein_position)).map(v => (
                <g key={`me-${v.variant_id}`}>
                  <path d={`M${toX(v.protein_position)} ${userY - 6}l4 7h-8Z`} fill="var(--accent)" opacity={0.9} />
                  <text x={toX(v.protein_position)} y={userY + 15} textAnchor="middle"
                    fill="var(--accent)" fontSize={7.5} fontFamily="monospace">
                    {userMatches.get(v.variant_id).genotype}
                  </text>
                </g>
              ))}
              <text x={ML} y={userY + 2} fill="var(--accent)" fontSize={8} opacity={0.8}>your DNA</text>
            </g>
          )}

          {/* Gene label and window */}
          <text x={ML} y={barY - 7} fill="var(--text-dimmer)" fontSize={9}>{geneName}</text>
          <text x={W - MR} y={barY - 7} textAnchor="end" fill="var(--text-dimmer)" fontSize={9}>
            {zoomed ? `${view.start}–${view.end} of ${proteinLength} aa` : `${proteinLength} aa`}
          </text>
        </svg>

        {/* Tooltip, near the variant rather than pinned to the centre. */}
        {active && (() => {
          const x = toX(active.protein_position);
          const onLeft = x > W * 0.55;
          const sig = significanceClass(active.clinical_significance);
          const con = consequenceClass(active.consequence);
          const domain = domainAt(active.protein_position, preparedDomains);
          const mine = userMatches.get(active.variant_id);
          return (
            <div style={{
              position: "absolute", top: 10,
              left: onLeft ? undefined : `${(x / W) * 100}%`,
              right: onLeft ? `${((W - x) / W) * 100}%` : undefined,
              margin: onLeft ? "0 10px 0 0" : "0 0 0 10px",
              background: "rgb(var(--c-deep) / 0.97)", border: `1px solid ${sig.color}66`,
              borderRadius: 8, padding: "0.5rem 0.7rem", pointerEvents: "none", zIndex: 10,
              minWidth: 190, maxWidth: 260, boxShadow: "0 4px 20px rgb(var(--c-shadow) / 0.5)",
            }}>
              <p style={{ fontFamily: "monospace", fontSize: "0.75rem", color: "var(--violet-faint)", fontWeight: 600 }}>
                {active.hgvs || active.variant_id}
              </p>
              <p style={{ fontSize: "0.7rem", color: sig.color, marginTop: 3 }}>{sig.label}</p>
              <p style={{ fontSize: "0.66rem", color: "var(--text-dim)", marginTop: 2 }}>
                {con.label} · residue {active.protein_position}
                {domain ? ` · ${domain.name}` : ""}
              </p>
              {active.condition && active.condition !== "Unknown" && (
                <p style={{ fontSize: "0.66rem", color: "var(--text-dim)", marginTop: 3 }}>{active.condition}</p>
              )}
              {active.review_status && (
                <p style={{ fontSize: "0.6rem", color: "var(--text-faintest)", marginTop: 3 }}>{active.review_status}</p>
              )}
              {mine && (
                <p style={{ fontSize: "0.66rem", color: "var(--accent)", marginTop: 4, fontWeight: 600 }}>
                  Your genotype: {mine.genotype}
                </p>
              )}
              {pinned && <p style={{ fontSize: "0.58rem", color: "var(--text-faintest)", marginTop: 4 }}>Click again to unpin</p>}
            </div>
          );
        })()}

        {/* Controls and honesty about what is not drawn */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginTop: 6, flexWrap: "wrap" }}>
          <span style={{ fontSize: "0.6rem", color: "var(--text-faintest)" }}>
            Scroll to zoom · drag to select a region · click a variant to pin
          </span>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            {lanes.overflow > 0 && (
              <span style={{ fontSize: "0.6rem", color: "var(--warning)" }}>
                {lanes.overflow} too crowded to draw — zoom in
              </span>
            )}
            {zoomed && (
              <button onClick={() => setView(fullView(proteinLength))}
                style={{ fontSize: "0.62rem", padding: "0.2rem 0.55rem", borderRadius: 6, cursor: "pointer",
                         background: "rgb(var(--c-accent) / 0.12)", border: "1px solid rgb(var(--c-accent) / 0.3)", color: "var(--accent)" }}>
                Reset zoom
              </button>
            )}
          </div>
        </div>

        {/* Legend: three channels, stated separately because they are read
            separately. */}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginTop: 8, paddingTop: 8, borderTop: "1px solid rgb(var(--c-border) / 0.25)" }}>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 7, alignItems: "center" }}>
            <span style={{ fontSize: "0.58rem", color: "var(--text-faintest)", textTransform: "uppercase", letterSpacing: "0.06em" }}>Shape</span>
            {facets.consequence.map(c => (
              <span key={c.key} style={{ display: "inline-flex", alignItems: "center", gap: 3 }}>
                <svg width={12} height={12}>{LEGEND_GLYPH[c.glyph] || LEGEND_GLYPH.circle}</svg>
                <span style={{ fontSize: "0.6rem", color: "var(--text-dimmer)" }}>{c.label}</span>
              </span>
            ))}
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 7, alignItems: "center" }}>
            <span style={{ fontSize: "0.58rem", color: "var(--text-faintest)", textTransform: "uppercase", letterSpacing: "0.06em" }}>Colour</span>
            {facets.significance.map(s => (
              <span key={s.key} style={{ display: "inline-flex", alignItems: "center", gap: 3 }}>
                <span style={{ width: 8, height: 8, borderRadius: "50%", background: s.color }} />
                <span style={{ fontSize: "0.6rem", color: "var(--text-dimmer)" }}>{s.label}</span>
              </span>
            ))}
          </div>
          <span style={{ fontSize: "0.6rem", color: "var(--text-faintest)" }}>
            Fainter glyphs carry less supporting evidence.
          </span>
        </div>
      </div>
    </div>
  );
}

// ─── OMIM Panel ──────────────────────────────────────────────────────────────

const INHERITANCE_STYLE = {
  AD:  { color: "var(--accent-soft)", bg: "rgb(var(--c-accent) / 0.5)",   border: "rgb(var(--c-accent) / 0.4)" },
  AR:  { color: "var(--warning-soft)", bg: "rgb(var(--c-warning) / 0.4)", border: "rgb(var(--c-warning) / 0.3)" },
  XLD: { color: "var(--violet-faint)", bg: "rgb(var(--c-violet) / 0.4)", border: "rgb(var(--c-violet) / 0.3)" },
  XLR: { color: "var(--violet-faint)", bg: "rgb(var(--c-violet) / 0.4)",  border: "rgb(var(--c-violet) / 0.3)" },
  XL:  { color: "var(--violet-faint)", bg: "rgb(var(--c-violet) / 0.4)",  border: "rgb(var(--c-violet) / 0.3)" },
  MT:  { color: "var(--danger-soft)", bg: "rgb(var(--c-danger) / 0.4)", border: "rgb(var(--c-danger) / 0.3)" },
  SMT: { color: "var(--warning-soft)", bg: "rgb(var(--c-warning) / 0.4)",   border: "rgb(var(--c-warning) / 0.3)" },
  DG:  { color: "var(--success-soft)", bg: "rgb(var(--c-success) / 0.4)",   border: "rgb(var(--c-success) / 0.3)" },
};

const INHERITANCE_FULL = {
  AD: "Autosomal Dominant", AR: "Autosomal Recessive",
  XLD: "X-Linked Dominant", XLR: "X-Linked Recessive", XL: "X-Linked",
  MT: "Mitochondrial", SMT: "Somatic", DG: "Digenic",
};

function OmimPanel({ omim }) {
  const [expanded, setExpanded] = useState(false);
  if (!omim?.gene_entry && !omim?.phenotypes?.length) return null;
  const phenotypes = omim.phenotypes || [];
  const shown = expanded ? phenotypes : phenotypes.slice(0, 5);

  return (
    <div style={{ marginTop: "1rem", background: "rgb(var(--c-deep) / 0.6)", border: "1px solid rgb(var(--c-violet) / 0.2)", borderRadius: 12, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0.625rem 0.875rem", borderBottom: "1px solid rgb(var(--c-violet) / 0.12)" }}>
        <span style={{ fontSize: "0.78rem", fontWeight: 600, color: "var(--violet-faint)" }}>OMIM — Genetic Disease Catalog</span>
        <span style={{ fontSize: "0.68rem", color: "var(--text-faintest)" }}>Online Mendelian Inheritance in Man</span>
      </div>

      <div style={{ padding: "0.75rem", display: "flex", flexDirection: "column", gap: 6 }}>
        {/* Gene entry */}
        {omim.gene_entry && (
          <a href={omim.gene_entry.url} target="_blank" rel="noreferrer" style={{ textDecoration: "none" }}>
            <div style={{ padding: "0.5rem 0.65rem", background: "rgb(var(--c-violet) / 0.08)", border: "1px solid rgb(var(--c-violet) / 0.2)", borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
              <div style={{ minWidth: 0 }}>
                <p style={{ fontSize: "0.72rem", color: "var(--violet-faint)", fontWeight: 600 }}>{omim.gene_entry.title}</p>
                <p style={{ fontSize: "0.65rem", color: "var(--text-dimmer)", marginTop: 2 }}>Gene entry · MIM #{omim.gene_entry.mim_number}</p>
              </div>
              <span style={{ fontSize: "0.65rem", color: "#6366f1", flexShrink: 0 }}>↗</span>
            </div>
          </a>
        )}

        {/* Phenotype entries */}
        {phenotypes.length > 0 && (
          <>
            <p style={{ fontSize: "0.65rem", color: "var(--text-faintest)", textTransform: "uppercase", letterSpacing: "0.08em", marginTop: 4 }}>
              Associated Disorders ({phenotypes.length})
            </p>
            {shown.map((p, i) => {
              const iStyle = p.inheritance ? (INHERITANCE_STYLE[p.inheritance] || {}) : {};
              return (
                <a key={i} href={p.url} target="_blank" rel="noreferrer" style={{ textDecoration: "none" }}>
                  <div style={{ padding: "0.45rem 0.65rem", background: "rgb(var(--c-surface) / 0.3)", border: "1px solid rgb(var(--c-border) / 0.3)", borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}
                    onMouseEnter={e => e.currentTarget.style.borderColor = "rgb(var(--c-violet) / 0.3)"}
                    onMouseLeave={e => e.currentTarget.style.borderColor = "rgb(var(--c-border) / 0.3)"}
                  >
                    <p style={{ fontSize: "0.72rem", color: "var(--text-faint)", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.title}</p>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
                      {p.inheritance && (
                        <span title={INHERITANCE_FULL[p.inheritance]} style={{ fontSize: "0.62rem", padding: "0.15em 0.45em", borderRadius: 4, background: iStyle.bg, color: iStyle.color, border: `1px solid ${iStyle.border}`, cursor: "help" }}>
                          {p.inheritance}
                        </span>
                      )}
                      <span style={{ fontSize: "0.62rem", color: "var(--text-faintest)", fontFamily: "monospace" }}>#{p.mim_number}</span>
                      <span style={{ fontSize: "0.62rem", color: "var(--text-faintest)" }}>↗</span>
                    </div>
                  </div>
                </a>
              );
            })}
            {phenotypes.length > 5 && (
              <button onClick={() => setExpanded(e => !e)} style={{ fontSize: "0.72rem", color: "var(--violet)", background: "none", border: "none", cursor: "pointer", padding: "0.25rem 0", textAlign: "left" }}>
                {expanded ? "Show less" : `+ ${phenotypes.length - 5} more disorders`}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ─── Gene Comparison View ────────────────────────────────────────────────────

function ComparisonStat({ label, a, b }) {
  return (
    <div style={{ display: "contents" }}>
      <span style={{ fontSize: "0.68rem", color: "var(--text-dimmer)", padding: "0.4rem 0.5rem", borderBottom: "1px solid rgb(var(--c-surface) / 0.5)" }}>{label}</span>
      <span style={{ fontSize: "0.72rem", color: "var(--text-faint)", padding: "0.4rem 0.5rem", borderBottom: "1px solid rgb(var(--c-surface) / 0.5)", textAlign: "center" }}>{a || "—"}</span>
      <span style={{ fontSize: "0.72rem", color: "var(--text-faint)", padding: "0.4rem 0.5rem", borderBottom: "1px solid rgb(var(--c-surface) / 0.5)", textAlign: "center" }}>{b || "—"}</span>
    </div>
  );
}

function ComparisonView({ msg }) {
  const { gene_a, gene_b, data_a, data_b } = msg.data || {};
  const [activeTab, setActiveTab] = useState("overview");
  if (!data_a || !data_b) return null;

  const stat = (data, key, fallback = "—") => {
    const v = data?.[key];
    return v !== undefined && v !== null ? v : fallback;
  };

  const pathogenicCount = (data) =>
    (data?.variants || []).filter(v => (v.clinical_significance || "").toLowerCase().includes("pathogenic") && !v.clinical_significance.toLowerCase().includes("likely")).length;

  const topDrugs = (data) => (data?.drugs || []).slice(0, 3).map(d => d.name).join(", ") || "—";
  const topValidity = (data) => (data?.clingen || [])[0]?.classification || "—";
  const topCancer = (data) => (data?.cancer_mutations?.cancer_types || [])[0]?.cancer_type || "—";

  const tabBtn = (id, label) => (
    <button onClick={() => setActiveTab(id)} style={{
      fontSize: "0.72rem", padding: "0.3rem 0.75rem", borderRadius: 6, cursor: "pointer", border: "none",
      background: activeTab === id ? "rgb(var(--c-accent) / 0.2)" : "transparent",
      color: activeTab === id ? "var(--accent)" : "var(--text-dimmer)",
      borderBottom: activeTab === id ? "2px solid var(--accent-strong)" : "2px solid transparent",
    }}>
      {label}
    </button>
  );

  const GeneCol = ({ data, gene }) => (
    <div style={{ flex: 1, minWidth: 0 }}>
      <GeneInfoBanner geneInfo={data.gene_info} proteinInfo={data.protein_info} pubCount={data.publication_count} />
      {data.alphafold?.pdb_url && <ProteinViewer pdbUrl={data.alphafold.pdb_url} geneName={gene} entryId={data.alphafold.entry_id} />}
      {data.pathways?.length > 0 && <PathwayViewer pathways={data.pathways} />}
      {data.expression?.length > 0 && <ExpressionChart expression={data.expression} />}
      {data.interactions?.length > 0 && <InteractionNetwork interactions={data.interactions} centerGene={gene} />}
      {data.protein_info?.length && <LollipopMap key={gene} variants={data.variants || []} domains={data.domains || []} proteinLength={data.protein_info.length} geneName={gene} />}
      {data.drugs?.length > 0 && <DrugPanel drugs={data.drugs} />}
      {data.cancer_mutations?.cancer_types?.length > 0 && <CancerMutationsPanel data={data.cancer_mutations} />}
      {(data.clingen?.length > 0) && <ClinGenPanel curations={data.clingen} />}
      {(data.omim?.gene_entry || data.omim?.phenotypes?.length) && <OmimPanel omim={data.omim} />}
      {data.gwas?.length > 0 && <GWASPanel gwas={data.gwas} />}
      {(data.hpo?.phenotype_terms?.length > 0 || data.monarch?.diseases?.length > 0) && <PhenotypePanel hpo={data.hpo} monarch={data.monarch} />}
      {data.disease_network?.diseases?.length > 0 && <DiseaseNetworkPanel data={data.disease_network} geneName={gene} />}
      {data.structural_variants?.variants?.length > 0 && <StructuralVariantsPanel data={data.structural_variants} locus={data.gene_locus_grch37} geneName={gene} />}
      {data.genetic_tests?.tests?.length > 0 && <GeneticTestsPanel data={data.genetic_tests} />}
      {data.medgen?.concepts?.length > 0 && <MedGenPanel data={data.medgen} />}
      {data.full_text?.articles?.length > 0 && <FullTextPanel data={data.full_text} />}
      {data.publication_timeline?.length > 0 && <PublicationTimeline timeline={data.publication_timeline} />}
    </div>
  );

  return (
    <div style={{ display: "flex", gap: 12, animation: "fadeSlideIn 0.25s ease-out" }}>
      <BrandMark size={28} style={{ marginTop: 2 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        {/* Title */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
          <span style={{ fontFamily: "monospace", fontSize: "0.85rem", fontWeight: 700, color: "var(--accent)" }}>{gene_a}</span>
          <span style={{ fontSize: "0.75rem", color: "var(--text-faintest)" }}>vs</span>
          <span style={{ fontFamily: "monospace", fontSize: "0.85rem", fontWeight: 700, color: "var(--violet)" }}>{gene_b}</span>
          <span style={{ fontSize: "0.68rem", color: "var(--text-faintest)" }}>· Gene Comparison</span>
        </div>

        {/* Tabs */}
        <div style={{ display: "flex", gap: 4, marginBottom: 12, borderBottom: "1px solid rgb(var(--c-surface) / 0.5)" }}>
          {tabBtn("overview", "Overview")}
          {tabBtn("gene_a", gene_a)}
          {tabBtn("gene_b", gene_b)}
        </div>

        {activeTab === "overview" && (
          <>
            {/* Comparison table */}
            <div style={{ marginBottom: 16, background: "rgb(var(--c-deep) / 0.5)", border: "1px solid rgb(var(--c-border) / 0.3)", borderRadius: 10, overflow: "hidden" }}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr" }}>
                <span style={{ fontSize: "0.65rem", color: "var(--text-faintest)", padding: "0.4rem 0.5rem", background: "rgb(var(--c-surface) / 0.5)", textTransform: "uppercase", letterSpacing: "0.08em" }}></span>
                <span style={{ fontSize: "0.72rem", fontFamily: "monospace", fontWeight: 700, color: "var(--accent)", padding: "0.4rem 0.5rem", background: "rgb(var(--c-surface) / 0.5)", textAlign: "center" }}>{gene_a}</span>
                <span style={{ fontSize: "0.72rem", fontFamily: "monospace", fontWeight: 700, color: "var(--violet)", padding: "0.4rem 0.5rem", background: "rgb(var(--c-surface) / 0.5)", textAlign: "center" }}>{gene_b}</span>
                <ComparisonStat label="Chromosome" a={`Chr ${stat(data_a.gene_info, "chromosome")}`} b={`Chr ${stat(data_b.gene_info, "chromosome")}`} />
                <ComparisonStat label="Protein length" a={data_a.protein_info?.length ? `${data_a.protein_info.length} aa` : "—"} b={data_b.protein_info?.length ? `${data_b.protein_info.length} aa` : "—"} />
                <ComparisonStat label="Publications" a={(data_a.publication_count || 0).toLocaleString()} b={(data_b.publication_count || 0).toLocaleString()} />
                <ComparisonStat label="ClinVar variants" a={stat(data_a, "variants", []).length} b={stat(data_b, "variants", []).length} />
                <ComparisonStat label="Pathogenic variants" a={pathogenicCount(data_a)} b={pathogenicCount(data_b)} />
                <ComparisonStat label="Pathways" a={(data_a.pathways || []).length} b={(data_b.pathways || []).length} />
                <ComparisonStat label="ClinGen validity" a={topValidity(data_a)} b={topValidity(data_b)} />
                <ComparisonStat label="Key drugs" a={topDrugs(data_a)} b={topDrugs(data_b)} />
                <ComparisonStat label="Top cancer type" a={topCancer(data_a)} b={topCancer(data_b)} />
              </div>
            </div>
            <Markdown content={msg.content} />
          </>
        )}

        {activeTab === "gene_a" && <GeneCol data={data_a} gene={gene_a} />}
        {activeTab === "gene_b" && <GeneCol data={data_b} gene={gene_b} />}

        {/* Sources */}
        {msg.sources?.length > 0 && (
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 16, flexWrap: "wrap" }}>
            <span style={{ fontSize: "0.72rem", color: "var(--text-faintest)" }}>Sources:</span>
            {msg.sources.map(s => {
              const c = SOURCE_COLORS[s] || { color: "var(--text-faint)", bg: "rgb(var(--c-surface) / 0.5)", border: "rgb(var(--c-border) / 0.4)" };
              return <span key={s} style={{ fontSize: "0.7rem", padding: "0.2em 0.6em", borderRadius: 100, background: c.bg, color: c.color, border: `1px solid ${c.border}` }}>{s}</span>;
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Messages ────────────────────────────────────────────────────────────────

const SOURCE_COLORS = {
  ClinVar: { color: "var(--danger-soft)", bg: "rgb(var(--c-danger) / 0.3)", border: "rgb(var(--c-danger) / 0.25)" },
  Ensembl: { color: "var(--success-soft)", bg: "rgb(var(--c-success) / 0.3)", border: "rgb(var(--c-success) / 0.25)" },
  gnomAD: { color: "var(--accent-soft)", bg: "rgb(var(--c-accent) / 0.4)", border: "rgb(var(--c-accent) / 0.25)" },
  UniProt: { color: "var(--warning-soft)", bg: "rgb(var(--c-warning) / 0.3)", border: "rgb(var(--c-warning) / 0.25)" },
  NCBI: { color: "var(--violet-faint)", bg: "rgb(var(--c-violet) / 0.3)", border: "rgb(var(--c-violet) / 0.25)" },
  PubMed: { color: "var(--warning-soft)", bg: "rgb(var(--c-warning) / 0.3)", border: "rgb(var(--c-warning) / 0.25)" },
  OpenTargets: { color: "var(--success-soft)", bg: "rgb(var(--c-success) / 0.3)", border: "rgb(var(--c-success) / 0.25)" },
  OMIM: { color: "var(--violet-faint)", bg: "rgb(var(--c-violet) / 0.3)", border: "rgb(var(--c-violet) / 0.25)" },
  PharmGKB: { color: "var(--accent-soft)", bg: "rgb(var(--c-accent) / 0.3)", border: "rgb(var(--c-accent) / 0.25)" },
  "COSMIC/GDC": { color: "var(--danger-soft)", bg: "rgb(var(--c-danger) / 0.3)", border: "rgb(var(--c-danger) / 0.25)" },
  ClinGen: { color: "var(--success-soft)", bg: "rgb(var(--c-success) / 0.3)", border: "rgb(var(--c-success) / 0.25)" },
  "GWAS Catalog": { color: "var(--danger)", bg: "rgb(var(--c-danger) / 0.3)", border: "rgb(var(--c-danger) / 0.25)" },
  HPO: { color: "var(--violet-faint)", bg: "rgb(var(--c-violet) / 0.3)", border: "rgb(var(--c-violet) / 0.25)" },
  Monarch: { color: "var(--violet)", bg: "rgb(var(--c-violet) / 0.25)", border: "rgb(var(--c-violet) / 0.2)" },
};


// ─── Response composition ────────────────────────────────────────────────────


/** One prose section the reader can open. */
function ProseSection({ title, body, defaultOpen }) {
  const [open, setOpen] = useState(!!defaultOpen);
  if (!body) return null;
  return (
    <div style={{ marginTop: 10, borderTop: "1px solid rgb(var(--c-border) / 0.3)" }}>
      <button onClick={() => setOpen(o => !o)}
        style={{ display: "flex", alignItems: "center", gap: 8, width: "100%", padding: "0.6rem 0", background: "none", border: "none", cursor: "pointer", textAlign: "left" }}>
        <span style={{ fontSize: "0.68rem", color: "var(--text-dim)", width: 10 }}>{open ? "▾" : "▸"}</span>
        <span style={{ fontSize: "0.82rem", fontWeight: 600, color: open ? "var(--accent)" : "var(--text-muted)" }}>{title}</span>
      </button>
      {open && <div style={{ paddingLeft: 18 }}><Markdown content={body} /></div>}
    </div>
  );
}

/** Renders one data panel by section key, so panels can be ordered by when the
 *  reader asked for them rather than by a fixed layout. */
function SectionPanel({ sectionKey, msg, dnaData, settings }) {
  const d = msg.data || {};
  if (sectionKey.startsWith("prose:")) {
    const title = sectionKey.slice(6);
    const sx = splitProseSections(msg.content).sections.find(x => x.title === title);
    return sx ? <div style={{ marginTop: 14 }}><Markdown content={`## ${sx.title}\n${sx.body}`} /></div> : null;
  }
  switch (sectionKey) {
    case "variants":
      return <DataSection data={d} queryType={msg.query_type} dnaData={dnaData} settings={settings} />;
    case "domainmap":
      return d.protein_info?.length ? (
        <LollipopMap key={msg.target} variants={d.variants || []} domains={d.domains || []}
                     proteinLength={d.protein_info.length} geneName={msg.target}
                     dnaData={dnaData} />
      ) : null;
    case "popfreq":
      return d.population_summary?.length > 0 ? <PopulationFrequencyChart populations={d.population_summary} /> : null;
    case "pathways":             return d.pathways?.length > 0 ? <PathwayViewer pathways={d.pathways} /> : null;
    case "expression":           return d.expression?.length > 0 ? <ExpressionChart expression={d.expression} /> : null;
    case "interactions":         return d.interactions?.length > 0 ? <InteractionNetwork interactions={d.interactions} centerGene={msg.target} /> : null;
    case "drugs":                return d.drugs?.length > 0 ? <DrugPanel drugs={d.drugs} /> : null;
    case "omim":                 return (d.omim?.gene_entry || d.omim?.phenotypes?.length) ? <OmimPanel omim={d.omim} /> : null;
    case "pharmgkb":             return (d.pharmgkb?.related_drugs?.length || d.pharmgkb?.clinical_annotations?.length) ? <PharmGKBPanel pgkb={d.pharmgkb} /> : null;
    case "cancer_mutations":     return d.cancer_mutations?.cancer_types?.length > 0 ? <CancerMutationsPanel data={d.cancer_mutations} /> : null;
    case "clingen":              return d.clingen?.length > 0 ? <ClinGenPanel curations={d.clingen} /> : null;
    case "gwas":                 return d.gwas?.length > 0 ? <GWASPanel gwas={d.gwas} /> : null;
    case "phenotypes":           return (d.hpo?.phenotype_terms?.length > 0 || d.monarch?.diseases?.length > 0) ? <PhenotypePanel hpo={d.hpo} monarch={d.monarch} /> : null;
    case "publication_timeline": return d.publication_timeline?.length > 0 ? <PublicationTimeline timeline={d.publication_timeline} /> : null;
    case "disease_network":      return d.disease_network?.diseases?.length > 0 ? <DiseaseNetworkPanel data={d.disease_network} geneName={msg.target} /> : null;
    case "structural_variants":  return d.structural_variants?.variants?.length > 0 ? <StructuralVariantsPanel data={d.structural_variants} locus={d.gene_locus_grch37} geneName={msg.target} /> : null;
    case "genetic_tests":        return d.genetic_tests?.tests?.length > 0 ? <GeneticTestsPanel data={d.genetic_tests} /> : null;
    case "medgen":               return d.medgen?.concepts?.length > 0 ? <MedGenPanel data={d.medgen} /> : null;
    case "full_text":            return d.full_text?.articles?.length > 0 ? <FullTextPanel data={d.full_text} /> : null;
    default: return null;
  }
}



function AssistantMessage({ msg, dnaData, settings, onLoadSection, onToggleSection, onAsk, sectionState }) {
  if (msg.query_type === "comparison_query") return <ComparisonView msg={msg} />;
  return (
    <div style={{ display: "flex", gap: 12, animation: "fadeSlideIn 0.25s ease-out" }}>
      <BrandMark size={28} style={{ marginTop: 2 }} />
      <div style={{ flex: 1, minWidth: 0 }}>
        {msg.target && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
            <span style={{ fontFamily: "monospace", fontSize: "0.78rem", fontWeight: 700, color: "var(--accent)" }}>{msg.target}</span>
            <span style={{ color: "var(--text-faintest)" }}>·</span>
            <span style={{ fontSize: "0.72rem", color: "var(--text-dimmer)", textTransform: "capitalize" }}>{(msg.query_type || "").replace("_", " ")}</span>
            {msg.result_count > 0 && <><span style={{ color: "var(--text-faintest)" }}>·</span><span style={{ fontSize: "0.72rem", color: "var(--text-dimmer)" }}>{msg.result_count} results</span></>}
            {msg.cached && <span style={{ fontSize: "0.68rem", padding: "0.15em 0.5em", borderRadius: 4, background: "var(--bg-inset)", color: "var(--text-dimmer)", border: "1px solid var(--border-solid)" }}>cached</span>}
          </div>
        )}
        {/* 1. identity + publication counts */}
        {msg.data?.gene_info && <GeneInfoBanner geneInfo={msg.data.gene_info} proteinInfo={msg.data.protein_info} pubCount={msg.data.publication_count} />}

        {/* 2-4. Overview, the 3D structure, then Key Findings. Nothing else is
            shown up front: the reader chooses what to open from Explore further,
            rather than receiving every dataset at once. */}
        {(() => {
          const { lead, sections } = splitProseSections(msg.content);
          const pick = name => sections.find(sx => norm(sx.title) === name);
          const overview = pick("overview");
          const findings = pick("keyfindings");
          const untitled = !sections.length;   // still streaming, or a plain follow-up

          return (
            <>
              {lead && <Markdown content={lead} />}
              {untitled && <Markdown content={msg.content} />}
              {overview && <Markdown content={`## ${overview.title}\n${overview.body}`} />}

              {msg.data?.alphafold?.pdb_url && (
                <ProteinViewer
                  pdbUrl={msg.data.alphafold.pdb_url}
                  geneName={msg.data.alphafold.gene || msg.target}
                  entryId={msg.data.alphafold.entry_id}
                />
              )}

              {findings && <Markdown content={`## ${findings.title}\n${findings.body}`} />}

              {/* Sits high, and is free: it is the reader's own data, matched
                  against this gene in the browser. Nothing was fetched to
                  produce it beyond the locus that came with the answer. */}
              {dnaData && msg.data?.gene_locus_grch37 && (
                <MyVariantsPanel
                  dnaData={dnaData}
                  locus={msg.data.gene_locus_grch37}
                  gene={msg.target || msg.data.gene_symbol}
                />
              )}
            </>
          );
        })()}

        {msg.expired && onAsk && (
          <button onClick={() => onAsk(msg.retryQuery)}
            style={{ marginTop: 10, padding: "0.45rem 0.8rem", borderRadius: 8,
                     background: "rgb(var(--c-accent) / 0.12)",
                     border: "1px solid rgb(var(--c-accent) / 0.35)",
                     color: "var(--accent)", fontSize: "0.76rem", fontWeight: 600,
                     cursor: "pointer" }}>
            Ask again
          </button>
        )}

        {msg.streaming && (
          <span aria-hidden="true" style={{ display: "inline-block", width: 7, height: 14, background: "var(--accent)", verticalAlign: "text-bottom", marginLeft: 2, animation: "pulse-dot 1.1s infinite" }} />
        )}

        {/* Opened items render in the order they were asked for, and sit above
            the menu so "Explore further" stays the last thing on the page —
            the next choice is always right where you finished reading. */}
        {(msg.loadedOrder && msg.loadedOrder.length
            ? msg.loadedOrder
            : (msg.data?.pending_sections ? [] : ALL_SECTION_KEYS)
        ).map(key => {
          const ui = (msg.sectionUi || {})[key];
          const label = (msg.loadedLabels || {})[key] || key;
          const body = <SectionPanel sectionKey={key} msg={msg} dnaData={dnaData} settings={settings} />;
          // Legacy full responses have no per-section UI state; render them plainly.
          if (!ui) return <div key={key}>{body}</div>;
          return (
            <div key={key} data-section-anchor={`${sectionState?.idx}:${key}`} style={{ scrollMarginTop: "1rem" }}>
              <OpenedSection label={label} open={ui.open} pinned={ui.pinned}
                             onToggle={() => onToggleSection?.(key)}>
                {body}
              </OpenedSection>
            </div>
          );
        })}

        {(msg.data?.unavailable_sources || []).length > 0 && (
          <div style={{ marginTop: 12, padding: "0.55rem 0.7rem", borderRadius: 8,
                        background: "rgb(var(--c-warning) / 0.09)",
                        border: "1px solid rgb(var(--c-warning) / 0.3)" }}>
            <p style={{ fontSize: "0.72rem", color: "var(--warning)", margin: 0, fontWeight: 600 }}>
              {msg.data.unavailable_sources.join(", ")} {msg.data.unavailable_sources.length === 1 ? "was" : "were"} unreachable
            </p>
            <p style={{ fontSize: "0.68rem", color: "var(--text-faint)", margin: "3px 0 0", lineHeight: 1.5 }}>
              Results below may be incomplete — this is a temporary problem at the source, not a finding
              about this gene. Ask again in a few minutes.
            </p>
          </div>
        )}

        {(msg.emptySections || []).length > 0 && (
          <p style={{ marginTop: 12, fontSize: "0.68rem", color: "var(--text-faintest)", lineHeight: 1.5 }}>
            No data for this gene in{" "}
            {(msg.emptySections || []).map(k => (EXPLORE_LABELS[k] || k)).join(", ")}
            {" "}— no credits used.
          </p>
        )}

        {/* 5. everything else, chosen by the reader */}
        {!msg.streaming && msg.data && (
          <ExploreFurther
            items={buildExploreItems(msg)}
            opened={msg.loadedOrder || []}
            onLoadSection={onLoadSection}
            onAsk={onAsk}
            sectionState={sectionState}
          />
        )}

        <MessageFooter msg={msg} />
      </div>
    </div>
  );
}

function MessageFooter({ msg }) {
  const [shareUrl, setShareUrl] = useState(null);
  const [sharing, setSharing] = useState(false);
  const [copied, setCopied] = useState(false);

  const share = async () => {
    if (!msg.query_id) return;
    setSharing(true);
    try {
      const r = await apiFetch(`/queries/${msg.query_id}/share`, { method: "POST" });
      if (r.ok) {
        const { token } = await r.json();
        const url = `${window.location.origin}${window.location.pathname}?share=${token}`;
        setShareUrl(url);
        await navigator.clipboard.writeText(url);
        setCopied(true);
        setTimeout(() => setCopied(false), 2500);
      }
    } finally { setSharing(false); }
  };

  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 14, flexWrap: "wrap", gap: 8 }}>
      {msg.sources?.length > 0 && (
        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <span style={{ fontSize: "0.72rem", color: "var(--text-faintest)" }}>Sources:</span>
          {msg.sources.map(s => {
            const c = SOURCE_COLORS[s] || { color: "var(--text-faint)", bg: "rgb(var(--c-surface) / 0.5)", border: "rgb(var(--c-border) / 0.4)" };
            return <span key={s} style={{ fontSize: "0.7rem", padding: "0.2em 0.6em", borderRadius: 100, background: c.bg, color: c.color, border: `1px solid ${c.border}` }}>{s}</span>;
          })}
        </div>
      )}
      {msg.query_id && (
        <button onClick={share} disabled={sharing} style={{ fontSize: "0.68rem", color: copied ? "var(--success)" : "var(--text-dimmer)", background: "none", border: "1px solid rgb(var(--c-border) / 0.35)", borderRadius: 6, padding: "0.2rem 0.55rem", cursor: "pointer", flexShrink: 0 }}>
          {copied ? "Link copied!" : sharing ? "Sharing…" : shareUrl ? "Copy link" : "Share"}
        </button>
      )}
    </div>
  );
}

function UserMessage({ content }) {
  return (
    <div style={{ display: "flex", justifyContent: "flex-end", animation: "fadeSlideIn 0.2s ease-out" }}>
      <div style={{ maxWidth: "60%", background: "rgb(var(--c-accent) / 0.12)", border: "1px solid rgb(var(--c-accent) / 0.2)", borderRadius: "16px 16px 4px 16px", padding: "0.625rem 1rem" }}>
        <p style={{ fontSize: "0.875rem", color: "var(--text-secondary)", lineHeight: 1.6 }}>{content}</p>
      </div>
    </div>
  );
}

const STAGE_LABEL = {
  interpreting: "Understanding your question…",
  fetching:     "Querying genomic databases…",
  explaining:   "Analysing the results…",
  thinking:     "Thinking…",
};

function TypingIndicator({ stage }) {
  return (
    <div style={{ display: "flex", gap: 12 }}>
      <BrandMark size={28} />
      <div style={{ background: "rgb(var(--c-surface) / 0.5)", border: "1px solid rgb(var(--c-border) / 0.35)", borderRadius: 12, padding: "0.75rem 1rem", display: "flex", alignItems: "center", gap: 6 }}>
        {[0, 1, 2].map(i => (
          <div key={i} style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--accent)", animation: `pulse-dot 1.2s ${i * 0.2}s infinite` }} />
        ))}
        <span style={{ fontSize: "0.75rem", color: "var(--text-dimmer)", marginLeft: 4 }}>{STAGE_LABEL[stage] || "Querying databases…"}</span>
      </div>
    </div>
  );
}

// ─── Sidebar ─────────────────────────────────────────────────────────────────

function Sidebar({ projects, activeProjectId, onSelectProject, onCreateProject, onDeleteProject, chatHistory, onNewChat, onLoadHistory, onDeleteHistory, currentUser, open, onClose }) {
  const [newName, setNewName] = useState("");
  const [hoveredId, setHoveredId] = useState(null);
  return (
    <aside className={`gc-sidebar${open ? " open" : ""}`}>
      <div style={{ padding: "1rem", borderBottom: "1px solid rgb(var(--c-surface) / 0.6)", display: "flex", gap: 8 }}>
        <button onClick={onNewChat} style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 6, padding: "0.5rem 0.75rem", borderRadius: 10, background: "var(--accent-deep)", color: "white", fontSize: "0.8rem", fontWeight: 600, border: "none", cursor: "pointer" }}>
          + New Chat
        </button>
        <button onClick={onClose} className="gc-hamburger" style={{ padding: "0.5rem 0.6rem", borderRadius: 10, background: "rgb(var(--c-surface) / 0.5)", border: "1px solid rgb(var(--c-border) / 0.4)", color: "var(--text-dimmer)", cursor: "pointer", fontSize: "1rem", lineHeight: 1 }}>✕</button>
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: "0.75rem" }}>
        {!currentUser && chatHistory.length === 0 && (
          <a href={`${API}/auth/google`} style={{ display: "block", margin: "0 0 12px", padding: "8px 10px", background: "rgb(var(--c-accent) / 0.08)", border: "1px solid rgb(var(--c-accent) / 0.2)", borderRadius: 8, textDecoration: "none", textAlign: "center" }}>
            <p style={{ fontSize: "0.68rem", color: "var(--accent)", margin: 0 }}>Sign in to save history</p>
          </a>
        )}
        {chatHistory.length > 0 && (
          <div style={{ marginBottom: "1.25rem" }}>
            <p style={{ fontSize: "0.65rem", fontWeight: 700, color: "var(--text-faintest)", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 6 }}>History</p>
            {chatHistory.slice(0, 20).map((item, i) => (
              <div key={item.id || i}
                style={{ position: "relative", display: "flex", alignItems: "center", borderRadius: 6, marginBottom: 1 }}
                onMouseEnter={() => setHoveredId(item.id || i)}
                onMouseLeave={() => setHoveredId(null)}
              >
                <button onClick={() => onLoadHistory(item)}
                  style={{ flex: 1, textAlign: "left", fontSize: "0.72rem", color: hoveredId === (item.id || i) ? "var(--text-faint)" : "var(--text-dim)", padding: "0.35rem 0.5rem", paddingRight: hoveredId === (item.id || i) ? "1.4rem" : "0.5rem", borderRadius: 6, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", background: hoveredId === (item.id || i) ? "rgb(var(--c-surface) / 0.5)" : "none", border: "none", cursor: "pointer", minWidth: 0 }}
                  title={item.query_text}
                >
                  {item.target ? <span style={{ fontFamily: "monospace", color: "var(--accent)", marginRight: 4 }}>{item.target}</span> : null}
                  {item.query_text?.slice(0, 26)}
                </button>
                {hoveredId === (item.id || i) && item.id && (
                  <button
                    onClick={e => { e.stopPropagation(); onDeleteHistory(item.id); }}
                    style={{ position: "absolute", right: 4, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", color: "var(--text-dimmer)", cursor: "pointer", fontSize: "0.75rem", lineHeight: 1, padding: "2px 3px", borderRadius: 3 }}
                    onMouseEnter={e => e.currentTarget.style.color = "var(--danger)"}
                    onMouseLeave={e => e.currentTarget.style.color = "var(--text-dimmer)"}
                    title="Delete this query"
                  >×</button>
                )}
              </div>
            ))}
          </div>
        )}
        <div>
          <p style={{ fontSize: "0.65rem", fontWeight: 700, color: "var(--text-faintest)", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 6 }}>Projects</p>
          <form onSubmit={e => { e.preventDefault(); if (newName.trim()) { onCreateProject(newName.trim()); setNewName(""); } }} style={{ display: "flex", gap: 6, marginBottom: 8 }}>
            <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="New project…" style={{ flex: 1, fontSize: "0.72rem", background: "rgb(var(--c-surface) / 0.6)", border: "1px solid rgb(var(--c-border) / 0.4)", borderRadius: 6, padding: "0.35rem 0.5rem", color: "var(--text-faint)", outline: "none" }} />
            <button type="submit" style={{ padding: "0.35rem 0.6rem", background: "rgb(var(--c-border) / 0.6)", border: "1px solid rgb(var(--c-border) / 0.4)", borderRadius: 6, color: "var(--text-faint)", cursor: "pointer", fontSize: "0.8rem" }}>+</button>
          </form>
          <button onClick={() => onSelectProject(null)} style={{ width: "100%", textAlign: "left", padding: "0.35rem 0.5rem", borderRadius: 6, fontSize: "0.75rem", color: activeProjectId === null ? "var(--accent)" : "var(--text-dim)", background: activeProjectId === null ? "rgb(var(--c-accent) / 0.1)" : "transparent", border: "none", cursor: "pointer", marginBottom: 2 }}>
            All queries
          </button>
          {projects.map(p => (
            <div key={p.id} style={{ position: "relative", display: "flex", alignItems: "center", borderRadius: 6, marginBottom: 2 }}
              onMouseEnter={() => setHoveredId(`proj-${p.id}`)}
              onMouseLeave={() => setHoveredId(null)}
            >
            <button onClick={() => onSelectProject(p.id)} style={{ flex: 1, textAlign: "left", padding: "0.35rem 0.5rem", paddingRight: hoveredId === `proj-${p.id}` ? "1.4rem" : "0.5rem", borderRadius: 6, fontSize: "0.75rem", color: activeProjectId === p.id ? "var(--accent)" : "var(--text-dim)", background: activeProjectId === p.id ? "rgb(var(--c-accent) / 0.1)" : "transparent", border: "none", cursor: "pointer", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", display: "block" }}>
              {p.name}
            </button>
            {hoveredId === `proj-${p.id}` && (
              <button onClick={e => { e.stopPropagation(); onDeleteProject(p.id); }}
                style={{ position: "absolute", right: 4, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", color: "var(--text-dimmer)", cursor: "pointer", fontSize: "0.75rem", lineHeight: 1, padding: "2px 3px", borderRadius: 3 }}
                onMouseEnter={e => e.currentTarget.style.color = "var(--danger)"}
                onMouseLeave={e => e.currentTarget.style.color = "var(--text-dimmer)"}
                title="Delete project"
              >×</button>
            )}
            </div>
          ))}
        </div>
      </div>
    </aside>
  );
}

// ─── App ─────────────────────────────────────────────────────────────────────

export default function App({ onNavigate }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [projects, setProjects] = useState([]);
  const [activeProjectId, setActiveProjectId] = useState(null);
  const [apiStatus, setApiStatus] = useState("checking");
  const [chatHistory, setChatHistory] = useState([]);
  const [currentUser, setCurrentUser] = useState(null);
  const [dnaData, setDnaData] = useState(() => loadDnaFromSession());
  const [showConsentModal, setShowConsentModal] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [settings, setSettings] = useState(() => loadSettings());
  const [showSettings, setShowSettings] = useState(false);
  const [showUserMenu, setShowUserMenu] = useState(false);
  const [showUpgrade, setShowUpgrade] = useState(false);
  const [showSignInGate, setShowSignInGate] = useState(false);   // false | "queries" | "dna"
  const [paymentToast, setPaymentToast] = useState(null); // "success_unlock" | "success_credits" | null
  // Evaluated once per mount rather than watched: the tally only advances on
  // send, and a card that appeared mid-sentence would be exactly the
  // interruption this is designed not to be.
  const [showAboutNudge, setShowAboutNudge] = useState(
    () => getQueryTally() >= ABOUT_NUDGE_AFTER && !aboutNudgeDismissed(),
  );

  useEffect(() => { applyFontSize(settings.fontSize); }, [settings.fontSize]);
  useEffect(() => {
    applyTheme(settings.theme);
    // Live 3Dmol viewers hold their own WebGL clear colour — repaint them.
    for (const v of viewerRegistry.values()) {
      try { v.setBackgroundColor(cssVar("--bg-panel", "#ffffff")); v.render(); } catch { /* viewer disposed */ }
    }
    // Keep following the OS while the user is on "system".
    if (settings.theme !== "system" || !window.matchMedia) return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => applyTheme("system");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [settings.theme]);

  /** Genetic data requires consent that can be evidenced, and consent is
   *  recorded against an account — so there has to be an account. Signing in
   *  changes nothing about how the file is handled: it is still parsed in the
   *  browser and still never stored. It changes only whether we can show, if
   *  ever asked, that the person agreed. Also closes section 11.1 of Railway's
   *  DPA, which puts the consent record squarely on us. */
  const requestDnaUpload = useCallback(() => {
    if (!currentUser) { setShowSignInGate("dna"); return; }
    setShowConsentModal(true);
  }, [currentUser]);

  const updateDnaData = useCallback((data) => {
    setDnaData(data);
    saveDnaToSession(data);
  }, []);
  const [streamStage, setStreamStage] = useState(null);
  const [loadingSections, setLoadingSections] = useState({});
  const [sectionErrors, setSectionErrors] = useState({});
  const bottomRef = useRef(null);
  const latestTurnRef = useRef(null);
  const inputRef = useRef(null);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    // Handle OAuth callback token
    const authToken = params.get("token");
    if (authToken) {
      setToken(authToken);
      window.history.replaceState({}, "", window.location.pathname);
    }
    // Handle shared query
    const shareToken = params.get("share");
    if (shareToken) loadSharedQuery(shareToken);

    // Handle Stripe payment return.
    // ?payment=success only means Stripe redirected us — it says nothing about
    // whether the webhook ran and actually granted anything. Confirm against
    // the server before claiming success, otherwise a failed webhook shows a
    // cheerful "credits added" over an unchanged balance.
    const paymentStatus = params.get("payment");
    const paymentType = params.get("type");
    const isPaymentReturn = paymentStatus === "success";
    if (paymentStatus) window.history.replaceState({}, "", window.location.pathname);

    checkHealth();
    fetchMe().then((user) => {
      loadProjects();
      loadChatHistory();
      if (isPaymentReturn) confirmPurchase(user, paymentType);
    });
  }, []);

  /**
   * Poll /auth/me until the entitlement actually appears, then report honestly.
   * Stripe delivers the webhook out-of-band, so a short delay is normal; a
   * lasting absence means the webhook failed and the user must not be told
   * their purchase succeeded.
   */
  const confirmPurchase = async (user, type) => {
    const granted = (u) => (type === "unlock" ? !!u?.byok_unlocked : (u?.query_credits || 0) > 0);
    if (granted(user)) {
      setPaymentToast(type === "unlock" ? "success_unlock" : "success_credits");
      setTimeout(() => setPaymentToast(null), 6000);
      return;
    }
    setPaymentToast("pending");
    for (let i = 0; i < 6; i++) {
      await new Promise(r => setTimeout(r, 2000));
      const fresh = await fetchMe();
      if (granted(fresh)) {
        setPaymentToast(type === "unlock" ? "success_unlock" : "success_credits");
        setTimeout(() => setPaymentToast(null), 6000);
        return;
      }
    }
    setPaymentToast("failed");
  };
  // Bring the newest exchange to the TOP of the viewport rather than scrolling
  // to the bottom. A gene answer is a long document — landing at its end drops
  // the reader past the overview and into whatever panel happens to be last.
  // While a reply is streaming in we deliberately do not chase it, so the page
  // stays where the reader left it.
  useEffect(() => {
    if (!messages.length) return;
    const el = latestTurnRef.current;
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [messages.length]);

  const checkHealth = async () => {
    try { const r = await apiFetch("/health"); setApiStatus(r.ok ? "online" : "error"); }
    catch { setApiStatus("offline"); }
  };

  // Fetch one deferred section and merge it into that message. The reader is
  // expanding an answer they already have, so this costs no query credit.
  /** Manual toggle. Marks the section pinned so auto-collapse leaves it alone. */
  const toggleSection = (msgIndex, sectionKey) => {
    setMessages(prev => prev.map((m, i) => {
      if (i !== msgIndex) return m;
      const ui = m.sectionUi || {};
      const wasOpen = ui[sectionKey]?.open;
      return { ...m, sectionUi: { ...ui, [sectionKey]: { open: !wasOpen, pinned: true } } };
    }));
  };

  const loadSection = async (msgIndex, sectionKey, instant, label) => {
    const msg = messages[msgIndex];
    const d = msg?.data;
    if (!d) return;

    const reveal = () => requestAnimationFrame(() => {
      document.querySelector(`[data-section-anchor="${msgIndex}:${sectionKey}"]`)
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    });

    // Prose the model already wrote, and data that came with the core response,
    // need no round trip and cost no credit — just reveal them.
    // Only the newest section stays expanded — older ones fold to their header
    // so the menu stays reachable. Sections the reader opened by hand are
    // pinned and left alone.
    const withOpened = (m) => {
      const ui = { ...(m.sectionUi || {}) };
      for (const k of Object.keys(ui)) {
        if (!ui[k].pinned) ui[k] = { ...ui[k], open: false };
      }
      ui[sectionKey] = { open: true, pinned: false };
      return {
        ...m,
        loadedOrder: [...(m.loadedOrder || []), sectionKey],
        loadedLabels: { ...(m.loadedLabels || {}), [sectionKey]: label || sectionKey },
        sectionUi: ui,
      };
    };

    if (instant) {
      setMessages(prev => prev.map((m, i) => i !== msgIndex ? m : withOpened(m)));
      reveal();
      return;
    }
    setLoadingSections(prev => ({ ...prev, [`${msgIndex}:${sectionKey}`]: true }));
    try {
      const r = await apiFetch("/gene/section", {
        method: "POST",
        body: JSON.stringify({
          gene: d.gene_symbol || msg.target,
          section: sectionKey,
          uniprot_accession: d._uniprot_accession || null,
          ensembl_id: d._ensembl_id || null,
        }),
      });
      if (r.status === 402) { setShowUpgrade("blocked"); return; }
      if (r.status === 401) { setShowSignInGate("queries"); return; }
      if (!r.ok) throw new Error(String(r.status));
      const payload = await r.json();
      const { data: sectionData, empty } = payload;

      if (empty) {
        // Nothing there for this gene. Say so, drop the option, and charge
        // nothing — the server has already declined to spend a credit.
        setMessages(prev => prev.map((m, i) => i !== msgIndex ? m : {
          ...m,
          emptySections: [...(m.emptySections || []), sectionKey],
          data: {
            ...m.data,
            pending_sections: (m.data.pending_sections || []).filter(p => p.key !== sectionKey),
          },
        }));
        return;
      }
      setMessages(prev => prev.map((m, i) => {
        if (i !== msgIndex) return m;
        const next = withOpened(m);
        return {
          ...next,
          data: {
            ...m.data,
            ...sectionData,
            pending_sections: (m.data.pending_sections || []).filter(p => p.key !== sectionKey),
          },
        };
      }));
      reveal();
      if (payload.charged) fetchMe();   // a credit was spent — refresh the badge
    } catch {
      setSectionErrors(prev => ({ ...prev, [`${msgIndex}:${sectionKey}`]: true }));
    } finally {
      setLoadingSections(prev => { const n = { ...prev }; delete n[`${msgIndex}:${sectionKey}`]; return n; });
    }
  };

  const fetchMe = async () => {
    try {
      const r = await apiFetch("/auth/me");
      if (r.ok) {
        const { user } = await r.json();
        setCurrentUser(user);
        if (user) {
          try { localStorage.removeItem(ANON_QUERY_KEY); } catch {}
        }
        return user;
      }
    } catch { /* offline — caller treats as no change */ }
    return null;
  };

  const loadProjects = async () => {
    try { const r = await apiFetch("/projects"); if (r.ok) setProjects(await r.json()); }
    catch {}
  };

  const loadChatHistory = async () => {
    try {
      const r = await apiFetch("/projects/queries/recent?limit=30");
      if (r.ok) setChatHistory(await r.json());
    } catch {}
  };

  const loadSharedQuery = async (token) => {
    try {
      const r = await apiFetch(`/share/${token}`);
      if (!r.ok) return;
      const item = await r.json();
      const userMsg = { role: "user", content: item.query_text };
      const assistantMsg = {
        role: "assistant",
        content: item.content || "",
        data: item.data,
        query_type: item.query_type,
        target: item.target,
        sources: item.sources || [],
        result_count: item.result_count || 0,
        cached: true,
      };
      setMessages([userMsg, assistantMsg]);
      window.history.replaceState({}, "", window.location.pathname);
    } catch {}
  };

  const deleteHistory = async (queryId) => {
    try {
      await apiFetch(`/queries/${queryId}`, { method: "DELETE" });
      setChatHistory(prev => prev.filter(h => h.id !== queryId));
    } catch {}
  };

  const loadHistory = (item) => {
    const userMsg = { role: "user", content: item.query_text };

    // Stored answers are dropped after the retention window, and history rows
    // outlive them by design. Silently doing nothing looked like a broken link,
    // so say what happened and offer the obvious next step.
    if (!item.content && !item.data) {
      setMessages([userMsg, {
        role: "assistant",
        content: "_This answer is no longer stored._ Older results are cleared to keep "
               + "the database small — the question is kept, the full result isn't. "
               + "Ask it again to get a fresh answer, which will also pick up anything "
               + "the source databases have added since.",
        expired: true,
        retryQuery: item.query_text,
      }]);
      return;
    }

    const assistantMsg = {
      role: "assistant",
      content: item.content || "",
      data: item.data,
      query_type: item.query_type,
      target: item.target,
      sources: item.sources || [],
      result_count: item.result_count || 0,
      cached: true,
    };
    setMessages([userMsg, assistantMsg]);
  };

  const buildHistory = useCallback(() =>
    messages.map(m => ({ role: m.role, content: m.content })),
    [messages]
  );

  const sendMessage = useCallback(async (text) => {
    const msg = (text || input).trim();
    if (!msg || loading) return;
    setInput("");
    // Gate anonymous users after ANON_QUERY_LIMIT queries
    if (!currentUser) {
      const count = getAnonQueryCount();
      if (count >= ANON_QUERY_LIMIT) {
        setShowSignInGate("queries");
        return;
      }
      incrementAnonQueryCount();
    }
    incrementQueryTally();

    const userMsg = { role: "user", content: msg };
    setMessages(prev => [...prev, userMsg]);
    setLoading(true);

    // Streaming: status first, then panels, then prose token by token. The
    // total wait is unchanged; what changes is that none of it is blank.
    const placeholderIndex = { current: null };
    try {
      const body = JSON.stringify({
        message: msg,
        history: buildHistory(),
        project_id: activeProjectId,
        response_detail: settings.responseDetail,
        // Only send a key from localStorage if the user has no server-stored key.
        user_api_key: (!currentUser?.has_stored_key && settings.apiKey) ? settings.apiKey : null,
        // Chosen by relevance to the question, not by position in the file.
        // The gene locus is unknown at this point — it arrives with the answer —
        // so selection falls back to variants named in the question and the
        // curated panel.
        personal_variants: dnaData ? selectRelevantVariants(dnaData, msg) : null,
      });

      const r = await fetch(`${API}/chat/stream`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body,
      });

      if (r.status === 402) {
        setMessages(prev => prev.slice(0, -1));   // drop the optimistic user turn
        setShowUpgrade("blocked");
        return;
      }
      if (r.status === 401) {
        // The server keeps its own count of anonymous questions; the localStorage
        // counter above only decides when to show this prompt early.
        setMessages(prev => prev.slice(0, -1));
        setShowSignInGate("queries");
        return;
      }
      if (r.status === 429) {
        setMessages(prev => prev.slice(0, -1));
        const wait = Number(r.headers.get("retry-after")) || 60;
        setMessages(prev => [...prev, { role: "assistant",
          content: `**Slow down a moment.** You've made a lot of requests in a short time — try again in about ${wait} seconds.` }]);
        return;
      }
      if (!r.ok || !r.body) {
        let detail = "Something went wrong.";
        try { detail = (await r.json()).detail || detail; } catch { /* non-JSON error body */ }
        setMessages(prev => [...prev, { role: "assistant", content: `**Error:** ${detail}` }]);
        return;
      }

      // Append the assistant turn once, then mutate it as events arrive.
      setMessages(prev => { placeholderIndex.current = prev.length; return [...prev, { role: "assistant", content: "", streaming: true }]; });

      const patch = (fields) => setMessages(prev => prev.map((m, i) =>
        i === placeholderIndex.current ? { ...m, ...fields } : m));
      const appendText = (chunk) => setMessages(prev => prev.map((m, i) =>
        i === placeholderIndex.current ? { ...m, content: (m.content || "") + chunk } : m));

      const reader = r.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        const { events, rest } = parseSSEChunk(buffer, decoder.decode(value, { stream: true }));
        buffer = rest;
        for (const { event, data: payload } of events) {
          if (event === "status") setStreamStage(payload.stage || null);
          else if (event === "token") appendText(payload.text || "");
          else if (event === "data") {
            setStreamStage("explaining");
            patch(payload);
            setLoading(false);   // panels are up; the typing dots can stop
          } else if (event === "done") {
            patch({ streaming: false, query_id: payload.query_id, cached: !!payload.cached });
          } else if (event === "error") {
            appendText(`\n\n**Error:** ${payload.message || "stream failed"}`);
          }
        }
      }

      patch({ streaming: false });
      // The query was just metered server-side; re-read the account so the
      // counter in the header reflects it. Without this the badge only moves
      // on reload, which reads as "my query was free".
      if (currentUser) fetchMe();
      setChatHistory(prev => [{ label: msg.slice(0, 50) }, ...prev.filter(h => h.label !== msg.slice(0, 50)).slice(0, 19)]);
    } catch (err) {
      setMessages(prev => [...prev, { role: "assistant", content: `**Connection error:** ${err.message}\n\nMake sure the backend is running.` }]);
    } finally {
      setLoading(false);
      setStreamStage(null);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [input, loading, buildHistory, activeProjectId, currentUser, dnaData, settings]);

  const exportReport = async () => {
    if (exporting) return;
    setExporting(true);
    try {
    // ── helpers ──────────────────────────────────────────────────────────────
    const esc = s => String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");

    const inline = t => esc(t)
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/\*(.+?)\*/g, "<em>$1</em>")
      .replace(/`(.+?)`/g, `<code style="background:var(--text);padding:1px 5px;border-radius:3px;font-size:12px;font-family:monospace">$1</code>`);

    const mdToHtml = text => {
      if (!text) return "";
      const out = []; let inList = false;
      for (const raw of text.split("\n")) {
        const l = raw.trimEnd();
        if (/^##\s/.test(l)) {
          if (inList) { out.push("</ul>"); inList = false; }
          out.push(`<h2 style="font-size:16px;font-weight:700;color:var(--accent-deep);border-bottom:1px solid #dbeafe;padding-bottom:6px;margin:22px 0 10px">${inline(l.slice(3))}</h2>`);
        } else if (/^###\s/.test(l)) {
          if (inList) { out.push("</ul>"); inList = false; }
          out.push(`<h3 style="font-size:14px;font-weight:600;color:var(--accent-deep);margin:16px 0 7px">${inline(l.slice(4))}</h3>`);
        } else if (/^[-*]\s/.test(l)) {
          if (!inList) { out.push('<ul style="margin:6px 0 10px 0;padding-left:20px">'); inList = true; }
          out.push(`<li style="font-size:13px;line-height:1.65;margin:3px 0;color:#374151">${inline(l.slice(2))}</li>`);
        } else if (l.trim() === "") {
          if (inList) { out.push("</ul>"); inList = false; }
          out.push("<div style='height:8px'></div>");
        } else {
          if (inList) { out.push("</ul>"); inList = false; }
          out.push(`<p style="font-size:13px;line-height:1.7;margin:3px 0;color:#374151">${inline(l)}</p>`);
        }
      }
      if (inList) out.push("</ul>");
      return out.join("");
    };

    const sectionHeader = (title, color = "var(--accent-deep)") =>
      `<div style="display:flex;align-items:center;gap:10px;margin:28px 0 12px"><div style="flex:1;height:1px;background:var(--text-secondary)"></div><span style="font-size:11px;font-weight:700;color:${color};text-transform:uppercase;letter-spacing:.08em;white-space:nowrap">${esc(title)}</span><div style="flex:1;height:1px;background:var(--text-secondary)"></div></div>`;

    const table = (headers, rows, colWidths) => {
      const wStyle = (i) => colWidths?.[i] ? `width:${colWidths[i]}` : "";
      return `<table style="width:100%;border-collapse:collapse;font-size:12px;margin:8px 0">
        <thead><tr>${headers.map((h,i) => `<th style="text-align:left;padding:6px 8px;background:var(--bg-inset);color:var(--accent-deep);font-weight:600;border-bottom:2px solid #dbeafe;${wStyle(i)}">${esc(h)}</th>`).join("")}</tr></thead>
        <tbody>${rows.map((r,ri) => `<tr style="background:${ri%2===0?"var(--text)":"var(--text)"}">${r.map((c,ci) => `<td style="padding:5px 8px;border-bottom:1px solid #f3f4f6;color:#374151;vertical-align:top;${wStyle(ci)}">${c}</td>`).join("")}</tr>`).join("")}</tbody>
      </table>`;
    };

    const badge = (text, bg, color) =>
      `<span style="display:inline-block;padding:2px 8px;border-radius:12px;font-size:11px;font-weight:600;background:${bg};color:${color};margin:1px 2px">${esc(text)}</span>`;

    // ── gather messages ───────────────────────────────────────────────────────
    const pairs = [];
    for (let i = 0; i < messages.length; i++) {
      if (messages[i].role === "user") {
        const reply = messages[i + 1]?.role === "assistant" ? messages[i + 1] : null;
        pairs.push({ query: messages[i].content, reply });
        if (reply) i++;
      }
    }
    if (!pairs.length) return;
    const date = new Date().toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric" });

    // ── protein snapshot ──────────────────────────────────────────────────────
    // 3Dmol holds its own WebGL clear colour, which CSS cannot reach, so a
    // viewer running in dark mode bakes a dark background into the PNG no
    // matter what the surrounding report does. Each viewer is repainted white
    // for the capture and restored afterwards, so the on-screen view is
    // unchanged once the export finishes.
    const proteinImgs = {};
    const onScreenViewerBg = cssVar("--bg-panel", "#ffffff");
    const captured = [];
    for (const { reply } of pairs) {
      if (!reply?.target) continue;
      const gene = reply.target.split(" vs ")[0];
      const viewer = viewerRegistry.get(gene);
      if (viewer) {
        try {
          viewer.spin(false);
          viewer.setBackgroundColor("#ffffff");
          viewer.render();
          captured.push(viewer);
          await new Promise(r => setTimeout(r, 120));
          proteinImgs[gene] = viewer.pngURI();
        } catch { /* viewer disposed or WebGL context lost */ }
      }
    }
    for (const viewer of captured) {
      try {
        viewer.setBackgroundColor(onScreenViewerBg);
        viewer.render();
      } catch { /* nothing to restore to */ }
    }

    // ── build HTML report ─────────────────────────────────────────────────────
    let body = "";

    for (const { query, reply } of pairs) {
      const d = reply?.data || {};
      const gene = reply?.target || "";

      // Query block
      body += `<div style="background:var(--bg-inset);border-left:4px solid #3b82f6;border-radius:4px;padding:14px 16px;margin-bottom:18px">
        <p style="font-size:10px;font-weight:700;color:var(--text-dim);letter-spacing:.08em;margin-bottom:4px">RESEARCH QUERY</p>
        <p style="font-size:15px;font-weight:600;color:var(--accent-deep);line-height:1.5">${esc(query)}</p>
        ${gene ? `<p style="font-size:12px;color:#3b82f6;margin-top:4px">${esc(gene)}${reply?.query_type ? " · " + reply.query_type.replace(/_/g," ") : ""}${reply?.result_count ? " · " + reply.result_count + " results" : ""}</p>` : ""}
      </div>`;

      // Protein structure
      const proteinPng = proteinImgs[gene];
      if (proteinPng) {
        body += `${sectionHeader("Protein Structure (AlphaFold)", "var(--violet-soft)")}
          <div style="text-align:center;background:var(--bg-panel);border-radius:10px;padding:8px;margin-bottom:8px">
            <img src="${proteinPng}" style="max-width:100%;border-radius:8px;display:block;margin:0 auto" />
          </div>
          <p style="font-size:11px;color:var(--text-faint);text-align:center;margin-bottom:16px">AlphaFold predicted structure · ${esc(d.alphafold?.entry_id || gene)} · Colored by pLDDT confidence</p>`;
      }

      // AI analysis
      if (reply?.content) {
        body += `${sectionHeader("Clinical Analysis")}${mdToHtml(reply.content)}`;
      }

      // Population frequencies
      if (d.population_summary?.length) {
        const popRows = d.population_summary.map(p => {
          const af = p.allele_frequency || 0;
          const barPct = Math.min(100, af * 5000000).toFixed(1);
          return [
            `<strong>${esc(p.population)}</strong>`,
            `<span style="font-family:monospace">${af.toExponential(2)}</span>`,
            `${p.allele_count?.toLocaleString() ?? "—"} / ${p.allele_number?.toLocaleString() ?? "—"}`,
            `<div style="background:var(--bg-inset);border-radius:3px;height:8px;width:120px"><div style="background:#3b82f6;border-radius:3px;height:8px;width:${barPct}%"></div></div>`,
          ];
        });
        body += `${sectionHeader("Population Allele Frequencies (gnomAD v4)")}
          <p style="font-size:12px;color:var(--text-dim);margin-bottom:8px">Aggregate allele frequency across all variants in this gene, by ancestry group.</p>
          ${table(["Population", "Allele Freq.", "AC / AN", "Relative"], popRows, ["30%","18%","28%","24%"])}`;
      }

      // HPO phenotypes
      const hpoTerms = d.hpo?.phenotype_terms || [];
      const monarchDiseases = d.monarch?.diseases || [];
      if (hpoTerms.length || monarchDiseases.length) {
        body += sectionHeader("Associated Phenotypes & Diseases (HPO · Monarch)");
        if (hpoTerms.length) {
          body += `<div style="display:flex;flex-wrap:wrap;gap:6px;margin:8px 0 12px">
            ${hpoTerms.slice(0,20).map(t => badge(t.name, "var(--bg-inset)", "var(--violet-soft)")).join("")}
          </div>`;
        }
        if (monarchDiseases.length) {
          const mRows = monarchDiseases.slice(0,12).map(d2 => [esc(d2.name), esc(d2.predicate || "—")]);
          body += table(["Disease (Monarch)", "Relationship"], mRows);
        }
      }

      // Pathogenic variants
      const patho = (d.variants || []).filter(v => /pathogenic/i.test(v.clinical_significance || ""));
      if (patho.length) {
        const vRows = patho.slice(0, 12).map(v => [
          `<span style="font-family:monospace;font-size:11px">${esc(v.variant_id)}</span>`,
          `<strong style="color:${/likely/i.test(v.clinical_significance||"")?"var(--warning)":"var(--danger)"}">${esc(v.clinical_significance)}</strong>`,
          esc(v.condition || "—"),
          v.hgvs ? `<span style="font-family:monospace;font-size:11px">${esc(v.hgvs)}</span>` : "—",
          v.frequency ? `<span style="font-family:monospace">${parseFloat(v.frequency).toExponential(2)}</span>` : "—",
        ]);
        body += `${sectionHeader("Pathogenic Variants (ClinVar)")}
          ${table(["Variant ID","Significance","Condition","Protein Change","gnomAD AF"], vRows, ["20%","18%","28%","20%","14%"])}`;
      }

      // GWAS associations
      if (d.gwas?.length) {
        const gRows = d.gwas.slice(0, 12).map(g => [
          esc(g.trait),
          `<span style="font-family:monospace;color:${g.p_value < 5e-8 ? "var(--danger)" : g.p_value < 1e-5 ? "var(--warning)" : "#374151"}">${esc(g.p_value_str)}</span>`,
          g.or_beta != null ? g.or_beta.toFixed(3) : "—",
          g.risk_allele ? `<span style="font-family:monospace">${esc(g.risk_allele)}</span>` : "—",
        ]);
        body += `${sectionHeader("GWAS Trait Associations (EBI GWAS Catalog)")}
          <p style="font-size:12px;color:var(--text-dim);margin-bottom:8px">p &lt; 5×10⁻⁸ = genome-wide significant</p>
          ${table(["Trait","p-value","OR / β","Risk Allele"], gRows, ["45%","20%","17%","18%"])}`;
      }

      // Drug interactions
      if (d.drugs?.length) {
        const dRows = d.drugs.slice(0, 10).map(dr => [
          `<strong>${esc(dr.name)}</strong>`,
          dr.phase != null ? badge(`Phase ${dr.phase}`, dr.phase >= 4 ? "#dcfce7" : dr.phase >= 3 ? "#dbeafe" : "var(--bg-inset)", dr.phase >= 4 ? "#15803d" : dr.phase >= 3 ? "#1d4ed8" : "var(--violet-soft)") : "—",
          esc(dr.mechanism || "—"),
          esc(dr.indication || "—"),
        ]);
        body += `${sectionHeader("Drug Interactions (Open Targets)")}
          ${table(["Drug","Phase","Mechanism","Indication"], dRows, ["22%","14%","32%","32%"])}`;
      }

      // ClinGen validity
      if (d.clingen?.length) {
        const cgColors = { Definitive: ["#dcfce7","#15803d"], Strong: ["#dbeafe","#1d4ed8"], Moderate: ["#fef9c3","#a16207"], Limited: ["#ffedd5","#c2410c"], Disputed: ["#fce7f3","#be185d"], Refuted: ["#fee2e2","#991b1b"] };
        const cgRows = d.clingen.slice(0,10).map(c => {
          const [bg, col] = cgColors[c.classification] || ["#f3f4f6","#374151"];
          return [badge(c.classification, bg, col), esc(c.disease), esc(c.moi || "—"), esc(c.gcep || "—")];
        });
        body += `${sectionHeader("ClinGen Gene-Disease Validity")}
          ${table(["Classification","Disease","Inheritance","Expert Panel"], cgRows, ["20%","38%","14%","28%"])}`;
      }

      // OMIM
      if (d.omim?.phenotypes?.length) {
        const oRows = d.omim.phenotypes.slice(0, 10).map(p => [
          esc(p.title),
          `<span style="font-family:monospace">${esc(p.mim_number)}</span>`,
          esc(p.inheritance || "—"),
        ]);
        body += `${sectionHeader("OMIM Disease Associations")}
          ${table(["Condition","MIM #","Inheritance"], oRows, ["58%","18%","24%"])}`;
      }

      // Cancer mutations
      if (d.cancer_mutations?.cancer_types?.length) {
        const cRows = d.cancer_mutations.cancer_types.slice(0, 10).map(c => [
          esc(c.cancer_type), String(c.mutation_count?.toLocaleString() ?? "—")
        ]);
        body += `${sectionHeader("Somatic Cancer Mutations (TCGA / GDC)")}
          ${table(["Cancer Type","Mutation Count"], cRows, ["70%","30%"])}`;
      }

      // Sources
      if (reply?.sources?.length) {
        body += `<p style="font-size:11px;color:var(--text-faint);margin-top:20px"><strong style="color:var(--text-dim)">Data sources:</strong> ${reply.sources.map(esc).join(" · ")}</p>`;
      }

      body += `<div style="height:32px;border-bottom:1px solid var(--text-secondary);margin-bottom:32px"></div>`;
    }

    const reportHtml = `
      <div id="gc-pdf-report" style="width:794px;background:var(--text);padding:48px 52px;font-family:'Georgia',serif;color:var(--bg-elevated);box-sizing:border-box">
        <!-- Header -->
        <div style="display:flex;align-items:center;justify-content:space-between;border-bottom:2px solid var(--accent-deep);padding-bottom:20px;margin-bottom:28px">
          <div style="display:flex;align-items:center;gap:12px">
            <div style="width:38px;height:38px;display:flex;align-items:center;justify-content:center"><img src="${window.location.origin}/logo-mark.png" width="38" height="38" style="object-fit:contain;display:block" /></div>
            <div>
              <p style="font-size:20px;font-weight:700;color:var(--accent-deep);margin:0">MyDNA</p>
              <p style="font-size:11px;color:var(--text-faint);margin:0">Genomics Research Report</p>
            </div>
          </div>
          <p style="font-size:12px;color:var(--text-faint);text-align:right">Generated ${date}<br><span style="font-size:10px">Powered by Claude AI</span></p>
        </div>
        ${body}
        <!-- Footer -->
        <div style="margin-top:32px;border-top:1px solid var(--text-secondary);padding-top:16px">
          <p style="font-size:11px;color:var(--text-muted);text-align:center">MyDNA · Data from Ensembl, ClinVar, gnomAD, UniProt, Open Targets, GWAS Catalog, HPO, Monarch, ClinPGx, ClinGen, COSMIC/GDC · Powered by Claude AI</p>
          <p style="font-size:10px;color:var(--text-secondary);text-align:center;margin-top:4px">For research purposes only. Not a substitute for clinical genetic counseling.</p>
        </div>
      </div>`;

    // ── render hidden div → html2canvas → jsPDF ───────────────────────────────
    const wrapper = document.createElement("div");
    wrapper.style.cssText = "position:fixed;left:-9999px;top:0;z-index:-1";
    // A report is a printed artefact: light whatever the reader has on screen.
    // Custom properties inherit, so marking the wrapper hands light values to
    // every var() inside it — see the third selector in index.css.
    wrapper.setAttribute("data-theme", "light");
    wrapper.innerHTML = reportHtml;
    document.body.appendChild(wrapper);

    try {
      const el = wrapper.querySelector("#gc-pdf-report");
      const canvas = await html2canvas(el, {
        scale: 2,
        useCORS: true,
        allowTaint: false,
        // Read from the wrapper, not the document root: cssVar() resolves
        // against documentElement and would hand back the dark background.
        backgroundColor: cssVarFrom(wrapper, "--bg", "#ffffff"),
        logging: false,
        imageTimeout: 8000,
      });

      const pdf = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
      const pageW = pdf.internal.pageSize.getWidth();
      const pageH = pdf.internal.pageSize.getHeight();
      const margin = 0;
      const imgW = pageW - margin * 2;
      const imgH = (canvas.height * imgW) / canvas.width;
      const imgData = canvas.toDataURL("image/jpeg", 0.92);

      let yOffset = 0;
      let firstPage = true;
      while (yOffset < imgH) {
        if (!firstPage) pdf.addPage();
        pdf.addImage(imgData, "JPEG", margin, margin - yOffset, imgW, imgH);
        yOffset += pageH - margin * 2;
        firstPage = false;
      }

      const slug = pairs[0]?.reply?.target?.replace(/\s+/g, "_") || "report";
      pdf.save(`MyDNA_${slug}_${Date.now()}.pdf`);
    } finally {
      document.body.removeChild(wrapper);
    }
    } finally {
      setExporting(false);
    }
  };

  const statusColor = { online: "var(--success)", offline: "var(--danger)", checking: "var(--warning)", error: "var(--danger)" }[apiStatus];

  return (
    <>
      <style>{`
        @keyframes fadeSlideIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes pulse-dot { 0%,80%,100% { opacity:.2; transform:scale(.8); } 40% { opacity:1; transform:scale(1); } }
        .gc-sidebar {
          width: 220px; flex-shrink: 0; display: flex; flex-direction: column;
          border-right: 1px solid rgb(var(--c-surface) / 0.8); background: rgb(var(--c-deep) / 0.97);
          transition: transform 0.25s ease;
        }
        .gc-sidebar-overlay { display: none; }
        .gc-hamburger { display: none; }
        .gc-header-subtitle { display: block; }
        .gc-header-status-text { display: inline; }
        .gc-export-btn { display: inline-flex !important; }
        .gc-suggestions { display: grid; grid-template-columns: repeat(2, 1fr); gap: 8px; max-width: 560px; width: 100%; }
        .gc-empty-pad { padding: 2rem; }
        .gc-msg-pad { padding: 1.5rem 1.5rem 1rem; }
        .gc-input-pad { padding: 0.875rem 1.5rem 1.25rem; }
        /* Centred, but never at the cost of clipping the top. Plain centring
           overflows equally in both directions, and a scroll container cannot
           scroll above its own start — so with the DNA banner taking a strip of
           height, the logo's top disappeared under it with no way to reach it.
           The safe keyword falls back to flex-start exactly when that would
           happen; the plain declaration above it is the fallback for browsers
           that do not parse the second one.
           (No backticks in this comment: the whole style block is a JS
           template literal, and one would end the string.) */
        .gc-empty-inner { justify-content: center; justify-content: safe center; }
        .gc-empty-hero { width: auto; height: 192px; margin-bottom: 18px; }
        .gc-empty-title { font-size: 1.25rem; margin: 0 0 8px; }
        .gc-empty-subtitle { font-size: 0.875rem; margin-bottom: 28px; }
        .gc-suggestion-item { display: flex; }
        .gc-dna-upload-section { margin-top: 20px; max-width: 560px; width: 100%; }
        /* Mobile header: two-row layout */
        .gc-header { display: flex; align-items: center; justify-content: space-between; padding: 0.75rem 1.25rem; border-bottom: 1px solid rgb(var(--c-surface) / 0.6); background: rgb(var(--c-deep) / 0.4); flex-shrink: 0; }
        .gc-header-row2 { display: none; }
        @media (max-width: 640px) {
          .gc-sidebar {
            position: fixed; top: 0; left: 0; bottom: 0; z-index: 200;
            transform: translateX(-100%); width: 260px;
          }
          .gc-sidebar.open { transform: translateX(0); }
          .gc-sidebar-overlay {
            display: block; position: fixed; inset: 0; z-index: 199;
            background: rgb(var(--c-shadow) / 0.6);
          }
          .gc-hamburger { display: flex; }
          .gc-header-subtitle { display: none; }
          .gc-header-status-text { display: none; }
          .gc-export-btn { display: none !important; }
          .gc-suggestions { grid-template-columns: 1fr; max-width: 100%; }
          .gc-empty-pad { padding: 1rem 1rem 1.5rem; }
          .gc-msg-pad { padding: 1rem 0.75rem 0.75rem; }
          .gc-input-pad { padding: 0.625rem 0.75rem calc(0.75rem + env(safe-area-inset-bottom)); }
          /* Mobile empty state: top-aligned so content isn't clipped */
          .gc-empty-inner { justify-content: flex-start !important; padding-top: 1.25rem; }
          .gc-empty-hero { height: 128px !important; width: auto !important; margin-bottom: 10px !important; }
          .gc-empty-title { font-size: 1rem !important; margin: 0 0 4px !important; }
          .gc-empty-subtitle { font-size: 0.78rem !important; margin-bottom: 16px !important; }
          /* Hide suggestions beyond the 3rd on mobile */
          .gc-suggestion-item:nth-child(n+4) { display: none !important; }
          .gc-dna-upload-section { margin-top: 12px !important; }
          /* Two-row mobile header */
          .gc-header { flex-direction: column; align-items: stretch; padding: 0; gap: 0; }
          .gc-header-row1 { padding: 0.55rem 0.875rem !important; border-bottom: 1px solid rgb(var(--c-surface) / 0.5); }
          .gc-header-row2 { display: flex !important; align-items: center; padding: 0.4rem 0.875rem; gap: 8px; }
          .gc-header-actions-desktop { display: none !important; }
          .gc-header-actions-mobile { display: flex !important; }
        }
      `}</style>
      <div style={{ display: "flex", height: "100vh", background: "var(--bg)", color: "var(--text-secondary)", overflow: "hidden", fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" }}>
        {showSettings && <SettingsPanel settings={settings} onChange={setSettings} onClose={() => setShowSettings(false)} currentUser={currentUser} onUserRefresh={fetchMe} />}
        {showSignInGate && <SignInGateModal reason={showSignInGate} onClose={() => setShowSignInGate(false)} />}
        {showUpgrade && <UpgradeModal currentUser={currentUser} blocked={showUpgrade === "blocked"} onClose={() => setShowUpgrade(false)} onOpenSettings={() => { setShowUpgrade(false); setShowSettings(true); }} />}
        {paymentToast && (() => {
          const tone = paymentToast === "failed"
            ? { bg: "var(--bg-elevated)", border: "rgb(var(--c-danger) / 0.45)", fg: "var(--danger)" }
            : paymentToast === "pending"
            ? { bg: "var(--border-solid)", border: "rgb(var(--c-border) / 0.35)", fg: "var(--text-muted)" }
            : { bg: "var(--bg-elevated)", border: "rgb(var(--c-success) / 0.4)", fg: "var(--success)" };
          const text = paymentToast === "success_unlock"
            ? "🔓 Unlimited access unlocked! Welcome to MyDNA Unlimited."
            : paymentToast === "success_credits"
            ? "⚡ 50 query credits added to your account."
            : paymentToast === "pending"
            ? "Payment received — confirming with our server…"
            : "Payment received, but your account hasn't updated yet. Nothing was lost — contact support and we'll apply it.";
          return (
            <div onClick={() => setPaymentToast(null)}
              style={{ position: "fixed", bottom: 24, left: "50%", transform: "translateX(-50%)", zIndex: 500, background: tone.bg, border: `1px solid ${tone.border}`, borderRadius: 10, padding: "0.75rem 1.25rem", color: tone.fg, fontSize: "0.82rem", fontWeight: 600, boxShadow: "0 8px 24px rgb(var(--c-shadow) / 0.4)", maxWidth: "min(92vw, 460px)", textAlign: "center", cursor: "pointer", lineHeight: 1.5 }}>
              {text}
            </div>
          );
        })()}
        {sidebarOpen && <div className="gc-sidebar-overlay" onClick={() => setSidebarOpen(false)} />}
        <Sidebar
          projects={projects} activeProjectId={activeProjectId}
          onSelectProject={id => { setActiveProjectId(id); setSidebarOpen(false); }}
          onCreateProject={async name => { try { const r = await apiFetch("/projects", { method: "POST", body: JSON.stringify({ name }) }); if (r.ok) { const p = await r.json(); setActiveProjectId(p.id); loadProjects(); } } catch {} }}
          onDeleteProject={async id => { try { await apiFetch(`/projects/${id}`, { method: "DELETE" }); if (activeProjectId === id) setActiveProjectId(null); loadProjects(); } catch {} }}
          chatHistory={chatHistory} onNewChat={() => { setMessages([]); setSidebarOpen(false); }} onLoadHistory={id => { loadHistory(id); setSidebarOpen(false); }} onDeleteHistory={deleteHistory}
          currentUser={currentUser} open={sidebarOpen} onClose={() => setSidebarOpen(false)}
        />

        {showConsentModal && (
          <ConsentModal
            onAccept={(result, filename) => {
              updateDnaData({ ...result, filename });
              setShowConsentModal(false);
              // Fire-and-forget: a failure here must not block someone from
              // using their own data, and the consent was still given. It is
              // recorded on a best-effort basis, which is what the obligation
              // to demonstrate consent reasonably asks for.
              fetch(`${API}/user/dna-consent`, { method: "POST", headers: authHeaders() })
                .catch(() => { /* offline or transient; the upload proceeds */ });
            }}
            onClose={() => setShowConsentModal(false)}
          />
        )}

        <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0 }}>
          {/* Header */}
          <header className="gc-header">
            {/* Row 1 (desktop: everything; mobile: hamburger + title + user) */}
            <div className="gc-header-row1" style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0.75rem 1.25rem", width: "100%", boxSizing: "border-box" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <button className="gc-hamburger" onClick={() => setSidebarOpen(o => !o)}
                  style={{ padding: "0.3rem 0.4rem", borderRadius: 8, background: "none", border: "1px solid rgb(var(--c-border) / 0.4)", color: "var(--text-dimmer)", cursor: "pointer", fontSize: "1.1rem", lineHeight: 1, alignItems: "center", justifyContent: "center" }}>
                  ☰
                </button>
                <BrandMark size={28} />
                <div>
                  <p style={{ fontSize: "0.9rem", fontWeight: 700, color: "var(--text)", margin: 0, letterSpacing: "-0.01em" }}>MyDNA</p>
                  <p className="gc-header-subtitle" style={{ fontSize: "0.7rem", color: "var(--text-faintest)", margin: 0 }}>Genomics research · Powered by Claude AI</p>
                </div>
              </div>
              {/* Desktop-only actions */}
              <div className="gc-header-actions-desktop" style={{ display: "flex", alignItems: "center", gap: 12 }}>
                {messages.length > 0 && (
                  <button className="gc-export-btn" onClick={exportReport} disabled={exporting} style={{ fontSize: "0.72rem", color: exporting ? "var(--text-disabled)" : "var(--text-dim)", background: "none", border: "1px solid rgb(var(--c-border) / 0.4)", borderRadius: 8, padding: "0.35rem 0.65rem", cursor: exporting ? "wait" : "pointer", transition: "color 0.15s" }}>
                    {exporting ? "Building PDF…" : "Export PDF"}
                  </button>
                )}
                <button
                  onClick={() => dnaData ? updateDnaData(null) : requestDnaUpload()}
                  style={{ fontSize: "0.72rem", color: dnaData ? "var(--accent)" : "var(--text-dim)", background: dnaData ? "rgb(var(--c-accent) / 0.08)" : "none", border: `1px solid ${dnaData ? "rgb(var(--c-accent) / 0.3)" : "rgb(var(--c-border) / 0.4)"}`, borderRadius: 8, padding: "0.35rem 0.65rem", cursor: "pointer", transition: "all 0.15s" }}
                  title={dnaData ? "Clear DNA session data" : "Upload your DNA data"}
                >
                  {dnaData ? "🧬 DNA loaded" : "Upload DNA"}
                </button>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <div style={{ width: 6, height: 6, borderRadius: "50%", background: statusColor }} />
                  <span style={{ fontSize: "0.72rem", color: "var(--text-faintest)", textTransform: "capitalize" }}>{apiStatus}</span>
                </div>
                <PlanBadge currentUser={currentUser} onClick={() => setShowUpgrade("buy")} />
                {currentUser ? (
                  <div style={{ position: "relative" }}>
                    {showUserMenu && <div onClick={() => setShowUserMenu(false)} style={{ position: "fixed", inset: 0, zIndex: 99 }} />}
                    <button onClick={() => setShowUserMenu(v => !v)}
                      style={{ width: 28, height: 28, borderRadius: "50%", background: "linear-gradient(135deg,var(--accent-strong),var(--violet-soft))", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, color: "white", border: "none", cursor: "pointer" }}>
                      {currentUser.name?.[0]?.toUpperCase() || "?"}
                    </button>
                    {showUserMenu && (
                      <div style={{ position: "absolute", top: 34, right: 0, background: "var(--border-solid)", border: "1px solid rgb(var(--c-border) / 0.6)", borderRadius: 8, minWidth: 148, zIndex: 100, overflow: "hidden", boxShadow: "0 8px 24px rgb(var(--c-shadow) / 0.4)" }}>
                        <button onClick={() => { setShowSettings(true); setShowUserMenu(false); }}
                          style={{ display: "block", width: "100%", textAlign: "left", padding: "0.55rem 0.85rem", fontSize: "0.78rem", color: "var(--text-muted)", background: "none", border: "none", cursor: "pointer" }}
                          onMouseEnter={e => e.currentTarget.style.background = "rgb(var(--c-border) / 0.5)"}
                          onMouseLeave={e => e.currentTarget.style.background = "none"}>
                          ⚙️ Settings
                        </button>
                        <div style={{ height: 1, background: "rgb(var(--c-border) / 0.4)" }} />
                        <button onClick={() => { clearToken(); setCurrentUser(null); setChatHistory([]); setShowUserMenu(false); }}
                          style={{ display: "block", width: "100%", textAlign: "left", padding: "0.55rem 0.85rem", fontSize: "0.78rem", color: "var(--danger)", background: "none", border: "none", cursor: "pointer" }}
                          onMouseEnter={e => e.currentTarget.style.background = "rgb(var(--c-border) / 0.5)"}
                          onMouseLeave={e => e.currentTarget.style.background = "none"}>
                          Sign out
                        </button>
                      </div>
                    )}
                  </div>
                ) : (
                  <a href={`${API}/auth/google`}
                      style={{ display: "flex", alignItems: "center", gap: 6, fontSize: "0.72rem", color: "var(--text-faint)", background: "rgb(var(--c-surface) / 0.6)", border: "1px solid rgb(var(--c-border) / 0.4)", borderRadius: 8, padding: "0.3rem 0.65rem", textDecoration: "none" }}
                      onMouseEnter={e => e.currentTarget.style.borderColor = "rgb(var(--c-accent) / 0.4)"}
                      onMouseLeave={e => e.currentTarget.style.borderColor = "rgb(var(--c-border) / 0.4)"}
                    >
                      <svg width="13" height="13" viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>
                      Sign in with Google
                    </a>
                )}
              </div>
              {/* Mobile-only: user avatar on right of title row */}
              <div className="gc-header-actions-mobile" style={{ display: "none", alignItems: "center", gap: 8 }}>
                <div style={{ width: 6, height: 6, borderRadius: "50%", background: statusColor }} />
                <PlanBadge currentUser={currentUser} onClick={() => setShowUpgrade("buy")} mobile />
                {currentUser ? (
                  <div style={{ position: "relative" }}>
                    {showUserMenu && <div onClick={() => setShowUserMenu(false)} style={{ position: "fixed", inset: 0, zIndex: 99 }} />}
                    <button onClick={() => setShowUserMenu(v => !v)}
                      style={{ width: 26, height: 26, borderRadius: "50%", background: "linear-gradient(135deg,var(--accent-strong),var(--violet-soft))", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, color: "white", border: "none", cursor: "pointer" }}>
                      {currentUser.name?.[0]?.toUpperCase() || "?"}
                    </button>
                    {showUserMenu && (
                      <div style={{ position: "absolute", top: 32, right: 0, background: "var(--border-solid)", border: "1px solid rgb(var(--c-border) / 0.6)", borderRadius: 8, minWidth: 148, zIndex: 100, overflow: "hidden", boxShadow: "0 8px 24px rgb(var(--c-shadow) / 0.4)" }}>
                        <button onClick={() => { setShowSettings(true); setShowUserMenu(false); }}
                          style={{ display: "block", width: "100%", textAlign: "left", padding: "0.55rem 0.85rem", fontSize: "0.78rem", color: "var(--text-muted)", background: "none", border: "none", cursor: "pointer" }}>
                          ⚙️ Settings
                        </button>
                        <div style={{ height: 1, background: "rgb(var(--c-border) / 0.4)" }} />
                        <button onClick={() => { clearToken(); setCurrentUser(null); setChatHistory([]); setShowUserMenu(false); }}
                          style={{ display: "block", width: "100%", textAlign: "left", padding: "0.55rem 0.85rem", fontSize: "0.78rem", color: "var(--danger)", background: "none", border: "none", cursor: "pointer" }}>
                          Sign out
                        </button>
                      </div>
                    )}
                  </div>
                ) : (
                  <a href={`${API}/auth/google`} style={{ fontSize: "0.68rem", color: "var(--accent)", textDecoration: "none" }}>Sign in</a>
                )}
              </div>
            </div>

            {/* Row 2 — mobile only: DNA + sign out spread across full width */}
            <div className="gc-header-row2" style={{ width: "100%", boxSizing: "border-box" }}>
              <button
                onClick={() => dnaData ? updateDnaData(null) : requestDnaUpload()}
                style={{ fontSize: "0.72rem", color: dnaData ? "var(--accent)" : "var(--text-dim)", background: dnaData ? "rgb(var(--c-accent) / 0.08)" : "none", border: `1px solid ${dnaData ? "rgb(var(--c-accent) / 0.3)" : "rgb(var(--c-border) / 0.4)"}`, borderRadius: 8, padding: "0.35rem 0.75rem", cursor: "pointer" }}
              >
                {dnaData ? "🧬 DNA loaded" : "Upload DNA"}
              </button>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginLeft: "auto" }}>
                {messages.length > 0 && (
                  <button onClick={exportReport} disabled={exporting} style={{ fontSize: "0.68rem", color: "var(--text-dimmer)", background: "none", border: "1px solid rgb(var(--c-border) / 0.4)", borderRadius: 8, padding: "0.3rem 0.6rem", cursor: "pointer" }}>
                    {exporting ? "Building…" : "Export PDF"}
                  </button>
                )}
              </div>
            </div>
          </header>

          <DNASessionBanner dnaData={dnaData} onClear={() => updateDnaData(null)} />

          {/* Messages */}
          <div className={messages.length > 0 ? "gc-msg-pad" : ""} style={{ flex: 1, overflowY: "auto" }}>
            {messages.length === 0 ? (
              // justify-content is deliberately absent from this inline style:
              // it lives in .gc-empty-inner, and an inline value would beat the
              // safe-centring rule that keeps the top of the logo reachable
              // while the DNA banner is showing.
              <div className="gc-empty-pad gc-empty-inner" style={{ display: "flex", flexDirection: "column", alignItems: "center", height: "100%" }}>
                <img src="/logo-stacked.png" alt="MyDNA" className="gc-empty-hero" style={{ objectFit: "contain", display: "block" }} />
                <h2 className="gc-empty-title" style={{ fontWeight: 700, color: "var(--text)", textAlign: "center" }}>
                  {dnaData ? "Your DNA — where would you like to start?" : "What would you like to research?"}
                </h2>
                <p className="gc-empty-subtitle" style={{ color: "var(--text-dimmer)", textAlign: "center", maxWidth: 420, lineHeight: 1.6 }}>
                  {dnaData
                    ? "These suggestions are based on notable variants found in your file."
                    : "Ask about genes, variants, or genetic diseases. I'll query live databases and explain the relationships."}
                </p>
                {(() => {
                  const personal = getPersonalizedSuggestions(dnaData);
                  if (personal) {
                    return (
                      <div className="gc-suggestions">
                        {personal.map(s => (
                          <button key={s.label} className="gc-suggestion-item" onClick={() => sendMessage(s.query)}
                            style={{ alignItems: "flex-start", gap: 10, padding: "0.75rem", borderRadius: 12, background: s.bg, border: `1px solid ${s.border}`, cursor: "pointer", textAlign: "left", transition: "all 0.15s" }}
                            onMouseEnter={e => e.currentTarget.style.filter = "brightness(1.15)"}
                            onMouseLeave={e => e.currentTarget.style.filter = ""}>
                            <div>
                              <p style={{ fontSize: "0.6rem", fontWeight: 700, letterSpacing: "0.04em", textTransform: "uppercase", color: s.color, margin: "0 0 3px", opacity: 0.75 }}>{s.category}</p>
                              <p style={{ fontSize: "0.78rem", fontWeight: 600, color: s.color, margin: 0, lineHeight: 1.4 }}>{s.label}</p>
                              <p style={{ fontSize: "0.68rem", color: "var(--text-dimmer)", marginTop: 2 }}>{s.sublabel}</p>
                            </div>
                          </button>
                        ))}
                      </div>
                    );
                  }
                  return (
                    <div className="gc-suggestions">
                      {SUGGESTIONS.map(s => (
                        <button key={s.label} className="gc-suggestion-item" onClick={() => sendMessage(s.label)} style={{ alignItems: "flex-start", gap: 10, padding: "0.75rem", borderRadius: 12, background: "rgb(var(--c-surface) / 0.4)", border: "1px solid rgb(var(--c-border) / 0.35)", cursor: "pointer", textAlign: "left", transition: "border-color 0.15s" }}
                          onMouseEnter={e => e.currentTarget.style.borderColor = "rgb(var(--c-accent) / 0.35)"}
                          onMouseLeave={e => e.currentTarget.style.borderColor = "rgb(var(--c-border) / 0.35)"}>
                          <span style={{ fontSize: "0.78rem", color: "var(--text-dim)", lineHeight: 1.5 }}>{s.label}</span>
                        </button>
                      ))}
                    </div>
                  );
                })()}
                <div className="gc-dna-upload-section">
                  {dnaData ? (
                    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "0.65rem 1rem", borderRadius: 12, background: "rgb(var(--c-accent) / 0.3)", border: "1px solid rgb(var(--c-accent) / 0.2)" }}>
                      <span style={{ fontSize: "1rem" }}>🧬</span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <p style={{ fontSize: "0.75rem", fontWeight: 600, color: "var(--accent)", margin: 0 }}>{dnaData.totalCount.toLocaleString()} variants loaded</p>
                        <p style={{ fontSize: "0.68rem", color: "var(--text-dimmer)", marginTop: 2 }}>{dnaData.filename} · {dnaData.format} · session only</p>
                      </div>
                      <button onClick={() => updateDnaData(null)} style={{ background: "none", border: "none", color: "var(--text-faintest)", cursor: "pointer", fontSize: "0.8rem" }}>Clear</button>
                    </div>
                  ) : (
                    <button
                      onClick={requestDnaUpload}
                      style={{ width: "100%", display: "flex", alignItems: "center", gap: 10, padding: "0.65rem 1rem", borderRadius: 12, background: "rgb(var(--c-surface) / 0.25)", border: "1px dashed rgb(var(--c-border) / 0.5)", cursor: "pointer", textAlign: "left", transition: "border-color 0.15s" }}
                      onMouseEnter={e => e.currentTarget.style.borderColor = "rgb(var(--c-accent) / 0.35)"}
                      onMouseLeave={e => e.currentTarget.style.borderColor = "rgb(var(--c-border) / 0.5)"}
                    >
                      <span style={{ fontSize: "1rem" }}>🧬</span>
                      <div style={{ flex: 1 }}>
                        <p style={{ fontSize: "0.75rem", fontWeight: 600, color: "var(--text-dimmer)", margin: 0 }}>Upload your DNA data</p>
                        <p style={{ fontSize: "0.68rem", color: "var(--text-faintest)", marginTop: 2 }}>23andMe · AncestryDNA · VCF · Processed locally, never stored</p>
                      </div>
                      <a
                        href="/sample_23andme.txt"
                        download="sample_23andme.txt"
                        onClick={e => e.stopPropagation()}
                        style={{ fontSize: "0.65rem", color: "var(--text-faintest)", border: "1px solid rgb(var(--c-border) / 0.4)", borderRadius: 6, padding: "0.2rem 0.5rem", whiteSpace: "nowrap", textDecoration: "none", flexShrink: 0 }}
                      >↓ sample</a>
                    </button>
                  )}
                </div>
                <DNASummaryDashboard dnaData={dnaData} onQuery={sendMessage} />
              </div>
            ) : (
              <div style={{ maxWidth: 820, margin: "0 auto", display: "flex", flexDirection: "column", gap: "1.5rem" }}>
                {messages.map((msg, i) => {
                  // The anchor is the last user turn, so a new answer opens with
                  // the question at the top and the response reading downward.
                  const isAnchor = i === messages.map(m => m.role).lastIndexOf("user");
                  return msg.role === "user"
                    ? <div key={i} ref={isAnchor ? latestTurnRef : null} style={{ scrollMarginTop: "1rem" }}><UserMessage content={msg.content} /></div>
                    : <AssistantMessage key={i} msg={msg} dnaData={dnaData} settings={settings} onLoadSection={(sec, instant, label) => loadSection(i, sec, instant, label)} onToggleSection={sec => toggleSection(i, sec)} onAsk={q => sendMessage(q)} sectionState={{ loading: loadingSections, errors: sectionErrors, idx: i }} />;
                })}
                {loading && <TypingIndicator stage={streamStage} />}
                <div ref={bottomRef} />
              </div>
            )}
          </div>

          {/* Input */}
          <div className="gc-input-pad" style={{ flexShrink: 0, borderTop: "1px solid rgb(var(--c-surface) / 0.5)", background: "rgb(var(--c-deep) / 0.3)" }}>
            <div style={{ maxWidth: 820, margin: "0 auto" }}>
              {showAboutNudge && (
                <AboutNudge
                  onOpen={() => { dismissAboutNudge(); setShowAboutNudge(false); if (onNavigate) onNavigate("/about"); }}
                  onDismiss={() => { dismissAboutNudge(); setShowAboutNudge(false); }}
                />
              )}
              <div style={{ display: "flex", gap: 10, alignItems: "flex-end", background: "rgb(var(--c-surface) / 0.55)", border: "1px solid rgb(var(--c-border) / 0.5)", borderRadius: 16, padding: "0.75rem 0.875rem" }}>
                <textarea
                  ref={inputRef}
                  value={input}
                  onChange={e => setInput(e.target.value)}
                  onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); } }}
                  placeholder="Ask about a gene (BRCA1 variants) or disease (Alzheimer's genes)…"
                  rows={1}
                  style={{ flex: 1, resize: "none", background: "transparent", color: "var(--text-secondary)", fontSize: "0.875rem", border: "none", outline: "none", lineHeight: 1.6, minHeight: 24, maxHeight: 160, overflowY: "auto", fontFamily: "inherit" }}
                  onInput={e => { e.target.style.height = "auto"; e.target.style.height = Math.min(e.target.scrollHeight, 160) + "px"; }}
                />
                <button
                  onClick={() => sendMessage()}
                  disabled={loading || !input.trim()}
                  style={{ width: 32, height: 32, borderRadius: 10, background: loading || !input.trim() ? "rgb(var(--c-border) / 0.4)" : "var(--accent-deep)", border: "none", cursor: loading || !input.trim() ? "not-allowed" : "pointer", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, transition: "background 0.15s" }}
                >
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="white" width={14} height={14}>
                    <path d="M3.105 2.289a.75.75 0 00-.826.95l1.414 4.925A1.5 1.5 0 005.135 9.25h6.115a.75.75 0 010 1.5H5.135a1.5 1.5 0 00-1.442 1.086l-1.414 4.926a.75.75 0 00.826.95 28.896 28.896 0 0015.293-7.154.75.75 0 000-1.115A28.897 28.897 0 003.105 2.289z" />
                  </svg>
                </button>
              </div>
              <p style={{ textAlign: "center", fontSize: "0.68rem", color: "var(--text-faintest)", marginTop: 8 }}>
                Ensembl · ClinVar · gnomAD · UniProt · PubMed · Claude AI
              </p>
              {/* Attribution above the rule, navigation below it. Without the
                  divider the two read as a single list, which is the same
                  reason the link is named rather than a bare "About". Privacy
                  and FAQ join this row once they exist. */}
              <div style={{
                height: 1, maxWidth: 220, margin: "9px auto 0",
                background: "rgb(var(--c-border) / 0.45)",
              }} />
              <p style={{ textAlign: "center", fontSize: "0.68rem", marginTop: 9 }}>
                <a href="/about"
                  onClick={(e) => { if (onNavigate) { e.preventDefault(); onNavigate("/about"); } }}
                  style={{ color: "var(--text-dim)", textDecoration: "none" }}>
                  About MyDNA
                </a>
              </p>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
