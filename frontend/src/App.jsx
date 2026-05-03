import { useState, useEffect, useRef, useCallback } from "react";
import jsPDF from "jspdf";
import html2canvas from "html2canvas";

// Registry so exportPDF can grab a live protein viewer snapshot (WebGL → PNG)
const viewerRegistry = new Map(); // geneName -> $3Dmol viewer instance

// ─── DNA File Parser (client-side only — never uploaded or stored) ────────────
function parseDNAFile(text) {
  const lines = text.split(/\r?\n/);
  const variants = new Map(); // rsid -> { genotype, chromosome, position }
  let format = "23andMe";

  if (lines.some(l => l.startsWith("##fileformat=VCF"))) {
    format = "VCF";
  } else {
    const header = lines.find(l => l.trim() && !l.startsWith("#"));
    if (header && (header.includes("allele1") || header.includes("allele2"))) {
      format = "AncestryDNA";
    }
  }

  if (format === "VCF") {
    for (const line of lines) {
      if (line.startsWith("#") || !line.trim()) continue;
      const cols = line.split("\t");
      if (cols.length < 9) continue;
      const [chrom, pos, id, ref, alt, , , , , ...samples] = cols;
      if (!id || id === ".") continue;
      const rsid = id.split(";").find(x => x.startsWith("rs")) || id;
      const gt = (samples[0] || "").split(":")[0] || "";
      const alleles = [ref, ...alt.split(",")];
      const indices = gt.split(/[|/]/).map(Number);
      const genotype = indices.map(i => alleles[i] || ".").join("");
      variants.set(rsid, { genotype, chromosome: chrom, position: pos });
    }
  } else if (format === "AncestryDNA") {
    for (const line of lines) {
      if (line.startsWith("#") || !line.trim()) continue;
      const cols = line.split("\t");
      if (!cols[0] || cols[0] === "rsid" || !cols[0].startsWith("rs")) continue;
      const [rsid, chromosome, position, allele1, allele2] = cols;
      variants.set(rsid, { genotype: (allele1 + allele2).replace(/0/g, ""), chromosome, position });
    }
  } else {
    // 23andMe
    for (const line of lines) {
      if (line.startsWith("#") || !line.trim()) continue;
      const cols = line.split("\t");
      if (!cols[0] || cols[0] === "rsid" || !cols[0].startsWith("rs")) continue;
      const [rsid, chromosome, position, genotype] = cols;
      variants.set(rsid, { genotype: (genotype || "").trim(), chromosome, position });
    }
  }

  return { variants, totalCount: variants.size, format };
}

// sessionStorage helpers — Map isn't JSON-serializable so we convert to/from entries
const SESSION_KEY = "genomechat_dna_session";

// ─── Settings (persisted to localStorage) ────────────────────────────────────
const SETTINGS_KEY = "genomechat_settings";

const DEFAULT_SETTINGS = {
  fontSize: "medium",          // small | medium | large
  responseDetail: "standard",  // concise | standard | detailed
  variantDefault: "collapsed", // collapsed | expanded
  defaultSort: "default",      // default | pathogenic_first | frequency
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

function saveDnaToSession(data) {
  if (!data) { sessionStorage.removeItem(SESSION_KEY); return; }
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({
      entries: Array.from(data.variants.entries()),
      totalCount: data.totalCount,
      format: data.format,
      filename: data.filename,
    }));
  } catch { /* quota exceeded or private mode — fail silently */ }
}

function loadDnaFromSession() {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const { entries, totalCount, format, filename } = JSON.parse(raw);
    return { variants: new Map(entries), totalCount, format, filename };
  } catch { return null; }
}

// ─── Notable Variants Lookup Table (client-side, no API needed) ──────────────
const NOTABLE_VARIANTS = [
  // Pharmacogenomics
  { rsid: "rs4244285",  gene: "CYP2C19", category: "pharmacogenomics", name: "CYP2C19*2", riskAllele: "A", desc: "Poor metabolizer — reduced activation of clopidogrel, PPIs, antidepressants" },
  { rsid: "rs4986893",  gene: "CYP2C19", category: "pharmacogenomics", name: "CYP2C19*3", riskAllele: "A", desc: "Poor metabolizer — compounded effect with *2" },
  { rsid: "rs12248560", gene: "CYP2C19", category: "pharmacogenomics", name: "CYP2C19*17", riskAllele: "T", desc: "Rapid/ultrarapid metabolizer — may need higher doses of some drugs" },
  { rsid: "rs4149056",  gene: "SLCO1B1", category: "pharmacogenomics", name: "SLCO1B1*5", riskAllele: "C", desc: "Reduced statin transport — increased risk of statin-induced myopathy" },
  { rsid: "rs1800462",  gene: "TPMT",    category: "pharmacogenomics", name: "TPMT*2",   riskAllele: "A", desc: "Poor thiopurine metabolizer — risk of severe toxicity on azathioprine" },
  { rsid: "rs1801280",  gene: "NAT2",    category: "pharmacogenomics", name: "NAT2 slow", riskAllele: "A", desc: "Slow acetylator — increased risk of adverse effects from isoniazid, dapsone" },
  { rsid: "rs1799929",  gene: "NAT2",    category: "pharmacogenomics", name: "NAT2 slow", riskAllele: "A", desc: "Slow acetylator — contributes to drug accumulation" },
  // Cardiovascular & Thrombosis
  { rsid: "rs6025",     gene: "F5",      category: "cardiovascular", name: "Factor V Leiden", riskAllele: "A", desc: "Increased blood clot risk — 5-10× higher DVT/PE risk if homozygous" },
  { rsid: "rs1799963",  gene: "F2",      category: "cardiovascular", name: "Prothrombin G20210A", riskAllele: "A", desc: "Elevated prothrombin — 3× increased venous thrombosis risk" },
  { rsid: "rs1801133",  gene: "MTHFR",   category: "cardiovascular", name: "MTHFR C677T", riskAllele: "A", desc: "Reduced folate metabolism — elevated homocysteine, cardiovascular and neural tube implications" },
  { rsid: "rs1801131",  gene: "MTHFR",   category: "cardiovascular", name: "MTHFR A1298C", riskAllele: "C", desc: "Mild folate pathway impact — compounded with C677T" },
  { rsid: "rs2228671",  gene: "LDLR",    category: "cardiovascular", name: "LDLR variant", riskAllele: "T", desc: "Familial hypercholesterolemia marker — affects LDL receptor function" },
  // Neurological & Alzheimer's
  { rsid: "rs429358",   gene: "APOE",    category: "neurological", name: "APOE ε4", riskAllele: "C", desc: "Strongest genetic risk factor for late-onset Alzheimer's — 3-4× risk per allele" },
  { rsid: "rs7412",     gene: "APOE",    category: "neurological", name: "APOE ε2", riskAllele: "T", desc: "APOE ε2 allele — associated with reduced Alzheimer's risk and longevity" },
  // Cancer Risk
  { rsid: "rs1799950",  gene: "BRCA1",   category: "cancer", name: "BRCA1 N372H", riskAllele: "G", desc: "Common BRCA1 variant — modest breast/ovarian cancer association" },
  { rsid: "rs799917",   gene: "BRCA1",   category: "cancer", name: "BRCA1 S694S", riskAllele: "T", desc: "BRCA1 synonymous variant — population screening marker" },
  { rsid: "rs1801406",  gene: "BRCA2",   category: "cancer", name: "BRCA2 N289H", riskAllele: "A", desc: "BRCA2 variant — associated with DNA repair pathway" },
  { rsid: "rs206076",   gene: "BRCA2",   category: "cancer", name: "BRCA2 K3326*", riskAllele: "A", desc: "BRCA2 truncating variant — associated with elevated cancer risk" },
  // Hereditary Conditions
  { rsid: "rs1800562",  gene: "HFE",     category: "hereditary", name: "HFE C282Y", riskAllele: "A", desc: "Primary hemochromatosis variant — iron overload if homozygous" },
  { rsid: "rs1799945",  gene: "HFE",     category: "hereditary", name: "HFE H63D", riskAllele: "C", desc: "Minor hemochromatosis variant — risk increases if compound heterozygous with C282Y" },
  // Metabolism & Nutrition
  { rsid: "rs13266634", gene: "SLC30A8", category: "metabolism", name: "SLC30A8 R325W", riskAllele: "T", desc: "Type 2 diabetes risk variant — affects zinc transport in pancreatic beta cells" },
  { rsid: "rs1801282",  gene: "PPARG",   category: "metabolism", name: "PPARG Pro12Ala", riskAllele: "G", desc: "Protective variant for type 2 diabetes — improves insulin sensitivity" },
];

const CATEGORY_META = {
  pharmacogenomics: { label: "Pharmacogenomics",    icon: "💊", color: "#818cf8", bg: "rgba(99,102,241,0.12)",  border: "rgba(99,102,241,0.25)" },
  cardiovascular:   { label: "Cardiovascular",       icon: "❤️", color: "#f87171", bg: "rgba(239,68,68,0.1)",   border: "rgba(239,68,68,0.2)" },
  neurological:     { label: "Neurological",         icon: "🧠", color: "#a78bfa", bg: "rgba(139,92,246,0.12)", border: "rgba(139,92,246,0.25)" },
  cancer:           { label: "Cancer Risk",           icon: "🔬", color: "#fb923c", bg: "rgba(249,115,22,0.1)",  border: "rgba(249,115,22,0.2)" },
  hereditary:       { label: "Hereditary Conditions",icon: "🧬", color: "#34d399", bg: "rgba(52,211,153,0.1)",  border: "rgba(52,211,153,0.2)" },
  metabolism:       { label: "Metabolism",            icon: "⚡", color: "#fbbf24", bg: "rgba(251,191,36,0.1)",  border: "rgba(251,191,36,0.2)" },
};

function computeDnaSummary(dnaData) {
  if (!dnaData) return null;
  const findings = [];
  for (const nv of NOTABLE_VARIANTS) {
    const userVariant = dnaData.variants.get(nv.rsid);
    if (!userVariant) continue;
    const genotype = userVariant.genotype || "";
    const hasRisk = genotype.includes(nv.riskAllele);
    const isHomozygous = genotype.length === 2 && genotype[0] === genotype[1];
    findings.push({ ...nv, genotype, hasRisk, isHomozygous, userVariant });
  }
  // Group by category
  const byCategory = {};
  for (const f of findings) {
    if (!byCategory[f.category]) byCategory[f.category] = [];
    byCategory[f.category].push(f);
  }
  return { findings, byCategory, totalFound: findings.length };
}

function DNASummaryDashboard({ dnaData, onQuery }) {
  const summary = computeDnaSummary(dnaData);
  const [expanded, setExpanded] = useState(null);
  if (!summary || summary.totalFound === 0) return null;

  const categories = Object.keys(summary.byCategory);

  return (
    <div style={{ maxWidth: 760, width: "100%", marginTop: 28 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
        <span style={{ fontSize: "1rem" }}>🧬</span>
        <p style={{ fontSize: "0.78rem", fontWeight: 700, color: "#94a3b8", margin: 0, textTransform: "uppercase", letterSpacing: "0.07em" }}>
          Your DNA — {summary.totalFound} notable variant{summary.totalFound !== 1 ? "s" : ""} found
        </p>
        <span style={{ fontSize: "0.65rem", color: "#1e3a5f", marginLeft: "auto" }}>educational only · not medical advice</span>
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
              style={{ display: "flex", alignItems: "center", gap: 6, padding: "0.3rem 0.75rem", borderRadius: 100, background: isActive ? meta.bg : "rgba(15,23,42,0.5)", border: `1px solid ${isActive ? meta.border : "rgba(51,65,85,0.35)"}`, cursor: "pointer", transition: "all 0.15s" }}
            >
              <span style={{ fontSize: "0.8rem" }}>{meta.icon}</span>
              <span style={{ fontSize: "0.7rem", fontWeight: 600, color: isActive ? meta.color : "#475569" }}>{meta.label}</span>
              <span style={{ fontSize: "0.62rem", padding: "0.05em 0.4em", borderRadius: 4, background: isActive ? meta.bg : "rgba(30,41,59,0.5)", color: isActive ? meta.color : "#334155", border: `1px solid ${isActive ? meta.border : "rgba(51,65,85,0.3)"}` }}>{count}</span>
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
                style={{ display: "flex", alignItems: "flex-start", gap: 12, padding: "0.75rem 1rem", borderRadius: 12, background: "rgba(15,23,42,0.5)", border: `1px solid ${meta.border}`, cursor: "pointer", textAlign: "left", transition: "border-color 0.15s", width: "100%" }}
                onMouseEnter={e => e.currentTarget.style.background = meta.bg}
                onMouseLeave={e => e.currentTarget.style.background = "rgba(15,23,42,0.5)"}
              >
                <div style={{ flexShrink: 0, marginTop: 2 }}>
                  <span style={{ fontFamily: "monospace", fontSize: "0.7rem", padding: "0.15em 0.5em", borderRadius: 5, background: f.hasRisk ? meta.bg : "rgba(30,41,59,0.5)", color: f.hasRisk ? meta.color : "#475569", border: `1px solid ${f.hasRisk ? meta.border : "rgba(51,65,85,0.3)"}` }}>
                    {f.genotype}
                  </span>
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                    <span style={{ fontSize: "0.78rem", fontWeight: 700, color: meta.color }}>{f.gene}</span>
                    <span style={{ fontSize: "0.7rem", color: "#475569" }}>{f.name}</span>
                    <span style={{ fontFamily: "monospace", fontSize: "0.65rem", color: "#334155" }}>{f.rsid}</span>
                  </div>
                  <p style={{ fontSize: "0.72rem", color: "#64748b", marginTop: 3, lineHeight: 1.5 }}>{f.desc}</p>
                </div>
                <span style={{ fontSize: "0.65rem", color: "#334155", flexShrink: 0, marginTop: 2 }}>Ask →</span>
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
# Generated by GenomeChat

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
          backgroundColor: "#0a0f1e",
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
    a.download = `${geneName}_genomechat.pml`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  const openChimeraX = () => {
    window.open(`chimerax://open?url=${encodeURIComponent(pdbUrl)}`, "_self");
  };

  const btnStyle = (active) => ({
    fontSize: "0.68rem", padding: "0.2rem 0.55rem", borderRadius: 5, cursor: "pointer",
    background: active ? "rgba(14,165,233,0.25)" : "rgba(30,41,59,0.7)",
    border: `1px solid ${active ? "rgba(14,165,233,0.6)" : "rgba(51,65,85,0.4)"}`,
    color: active ? "#38bdf8" : "#94a3b8",
    transition: "all 0.15s",
  });

  const actionBtnStyle = {
    fontSize: "0.68rem", padding: "0.2rem 0.55rem", borderRadius: 5, cursor: "pointer",
    background: "rgba(30,41,59,0.7)", border: "1px solid rgba(51,65,85,0.4)",
    color: "#94a3b8", textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 3,
  };

  return (
    <div style={{ marginTop: "1rem", background: "rgba(10,15,30,0.8)", border: "1px solid rgba(14,165,233,0.2)", borderRadius: 12, overflow: "hidden" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0.6rem 0.875rem", borderBottom: "1px solid rgba(14,165,233,0.1)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <span style={{ fontSize: "0.78rem", fontWeight: 600, color: "#38bdf8" }}>{geneName} — 3D Structure</span>
          {entryId && <span style={{ fontSize: "0.65rem", color: "#334155", fontFamily: "monospace" }}>{entryId}</span>}
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
        <div style={{ padding: "0.45rem 0.875rem", borderBottom: "1px solid rgba(14,165,233,0.07)", display: "flex", flexWrap: "wrap", gap: 5, alignItems: "center" }}>
          <span style={{ fontSize: "0.65rem", color: "#475569", marginRight: 4 }}>View:</span>
          {REPRESENTATIONS.map(r => (
            <button key={r} onClick={() => handleRep(r)} style={btnStyle(rep === r)}>{r}</button>
          ))}
          <span style={{ fontSize: "0.65rem", color: "#475569", marginLeft: 8, marginRight: 4 }}>Color:</span>
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
            <div style={{ width: 28, height: 28, borderRadius: "50%", border: "2px solid #0ea5e9", borderTopColor: "transparent", animation: "spin 0.8s linear infinite" }} />
            <p style={{ fontSize: "0.75rem", color: "#475569" }}>Loading AlphaFold structure…</p>
          </div>
        )}
        {status === "error" && (
          <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
            <p style={{ fontSize: "0.75rem", color: "#475569" }}>Structure unavailable for this protein</p>
          </div>
        )}
      </div>

      {/* Footer: legend + export */}
      {status === "ready" && (
        <div style={{ padding: "0.5rem 0.875rem", borderTop: "1px solid rgba(14,165,233,0.1)" }}>
          {scheme === "pLDDT" && (
            <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap", marginBottom: "0.4rem" }}>
              <span style={{ fontSize: "0.65rem", color: "#475569" }}>pLDDT:</span>
              {[["#0053D6","Very high >90"], ["#65CBF3","High 70–90"], ["#FFDB13","Medium 50–70"], ["#FF7D45","Low <50"]].map(([color, label]) => (
                <div key={label} style={{ display: "flex", alignItems: "center", gap: 4 }}>
                  <div style={{ width: 8, height: 8, borderRadius: 2, background: color }} />
                  <span style={{ fontSize: "0.63rem", color: "#475569" }}>{label}</span>
                </div>
              ))}
            </div>
          )}
          <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
            <span style={{ fontSize: "0.63rem", color: "#334155" }}>Export:</span>
            <a href={pdbUrl} download target="_blank" rel="noreferrer" style={actionBtnStyle}>↓ PDB file</a>
            <button onClick={downloadPymol} style={actionBtnStyle} title="Download PyMOL script to open in PyMOL desktop app">↓ PyMOL script (.pml)</button>
            <button onClick={openChimeraX} style={actionBtnStyle} title="Opens in ChimeraX if installed locally">⬡ Open in ChimeraX</button>
            <span style={{ marginLeft: "auto", fontSize: "0.62rem", color: "#1e293b" }}>AlphaFold DB</span>
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
            style={{ flex: 1, padding: "0.35rem 0.5rem", borderRadius: 8, fontSize: "0.72rem", fontWeight: active ? 600 : 400, cursor: "pointer", transition: "all 0.15s", border: `1px solid ${active ? "rgba(14,165,233,0.4)" : "rgba(51,65,85,0.35)"}`, background: active ? "rgba(14,165,233,0.12)" : "rgba(15,23,42,0.5)", color: active ? "#38bdf8" : "#475569" }}>
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

function SettingsPanel({ settings, onChange, onClose }) {
  const set = (key, val) => {
    const next = { ...settings, [key]: val };
    onChange(next);
    saveSettings(next);
    if (key === "fontSize") applyFontSize(val);
  };

  return (
    <>
      {/* Backdrop */}
      <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 300, background: "rgba(0,0,0,0.5)" }} />
      {/* Drawer */}
      <div style={{ position: "fixed", top: 0, right: 0, bottom: 0, zIndex: 301, width: 320, maxWidth: "100vw", background: "#0d1424", borderLeft: "1px solid rgba(30,41,59,0.8)", display: "flex", flexDirection: "column", boxShadow: "-8px 0 32px rgba(0,0,0,0.4)", animation: "slideInRight 0.2s ease-out" }}>
        <style>{`@keyframes slideInRight { from { transform: translateX(100%); } to { transform: translateX(0); } }`}</style>

        {/* Header */}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "1rem 1.25rem", borderBottom: "1px solid rgba(30,41,59,0.6)", flexShrink: 0 }}>
          <p style={{ fontSize: "0.9rem", fontWeight: 700, color: "#f1f5f9", margin: 0 }}>Settings</p>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "#475569", cursor: "pointer", fontSize: "1.2rem", lineHeight: 1, padding: 4 }}>×</button>
        </div>

        {/* Body */}
        <div style={{ flex: 1, overflowY: "auto", padding: "1.25rem" }}>

          <Section label="Text Size" hint="Adjusts all text across the app">
            <SettingSegment value={settings.fontSize}
              options={[{ value: "small", label: "Small" }, { value: "medium", label: "Medium" }, { value: "large", label: "Large" }]}
              onChange={v => set("fontSize", v)} />
          </Section>

          <Section label="AI Response Detail" hint="Controls how thorough Claude's explanations are">
            <SettingSegment value={settings.responseDetail}
              options={[{ value: "concise", label: "Concise" }, { value: "standard", label: "Standard" }, { value: "detailed", label: "Detailed" }]}
              onChange={v => set("responseDetail", v)} />
            <p style={{ fontSize: "0.68rem", color: "#334155", marginTop: 6, lineHeight: 1.5 }}>
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

        </div>

        {/* Footer */}
        <div style={{ padding: "0.875rem 1.25rem", borderTop: "1px solid rgba(30,41,59,0.5)", flexShrink: 0 }}>
          <p style={{ fontSize: "0.65rem", color: "#1e3a5f", margin: "0 0 8px", lineHeight: 1.5 }}>Preferences are saved locally in your browser and never sent to our servers.</p>
          <button onClick={() => { onChange({ ...DEFAULT_SETTINGS }); saveSettings(DEFAULT_SETTINGS); applyFontSize(DEFAULT_SETTINGS.fontSize); }}
            style={{ fontSize: "0.68rem", color: "#334155", background: "none", border: "1px solid rgba(51,65,85,0.35)", borderRadius: 6, padding: "0.25rem 0.6rem", cursor: "pointer" }}>
            Reset to defaults
          </button>
        </div>
      </div>
    </>
  );
}

function Section({ label, hint, children }) {
  return (
    <div style={{ marginBottom: "1.5rem" }}>
      <p style={{ fontSize: "0.72rem", fontWeight: 700, color: "#94a3b8", textTransform: "uppercase", letterSpacing: "0.07em", margin: "0 0 3px" }}>{label}</p>
      {hint && <p style={{ fontSize: "0.67rem", color: "#334155", margin: "0 0 10px", lineHeight: 1.4 }}>{hint}</p>}
      {children}
    </div>
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
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.75)", zIndex: 1000, display: "flex", alignItems: "center", justifyContent: "center", padding: "1rem" }}>
      <div style={{ background: "#0f172a", border: "1px solid rgba(14,165,233,0.25)", borderRadius: 16, padding: "1.75rem", maxWidth: 520, width: "100%", boxShadow: "0 25px 50px rgba(0,0,0,0.6)" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: "1.25rem" }}>
          <div>
            <p style={{ fontSize: "1rem", fontWeight: 700, color: "#f1f5f9", margin: 0 }}>Upload DNA Data</p>
            <p style={{ fontSize: "0.72rem", color: "#475569", marginTop: 3 }}>23andMe · AncestryDNA · VCF</p>
          </div>
          <button onClick={onClose} style={{ background: "none", border: "none", color: "#475569", cursor: "pointer", fontSize: "1.2rem", lineHeight: 1, padding: 4 }}>×</button>
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: "1.25rem" }}>
          {[
            { icon: "🔒", title: "Processed in your browser", body: "Your file is parsed entirely on your device. The raw data never leaves your browser." },
            { icon: "🚫", title: "Nothing stored or transmitted", body: "Variants are held in browser session memory only and cleared automatically when you close the tab. They are never sent to our servers." },
            { icon: "💻", title: "Personal device only", body: "Do not upload your DNA data on a shared, public, or work computer. Session data persists until the tab is closed and could be accessed by the next user." },
            { icon: "⚕️", title: "Not medical advice", body: "This tool is for research and educational purposes. Consult a licensed genetic counselor for health decisions." },
          ].map(({ icon, title, body }) => (
            <div key={title} style={{ display: "flex", gap: 10, padding: "0.6rem 0.75rem", background: "rgba(30,41,59,0.4)", borderRadius: 10, border: "1px solid rgba(51,65,85,0.3)" }}>
              <span style={{ fontSize: "0.95rem", flexShrink: 0, marginTop: 1 }}>{icon}</span>
              <div>
                <p style={{ fontSize: "0.73rem", fontWeight: 600, color: "#cbd5e1", margin: 0 }}>{title}</p>
                <p style={{ fontSize: "0.68rem", color: "#64748b", marginTop: 2, lineHeight: 1.5 }}>{body}</p>
              </div>
            </div>
          ))}
        </div>

        <label style={{ display: "flex", alignItems: "flex-start", gap: 8, marginBottom: "1.25rem", cursor: "pointer" }}>
          <input type="checkbox" checked={agreed} onChange={e => setAgreed(e.target.checked)}
            style={{ width: 15, height: 15, marginTop: 2, accentColor: "#0ea5e9", flexShrink: 0 }} />
          <span style={{ fontSize: "0.72rem", color: "#94a3b8", lineHeight: 1.55 }}>
            I understand this tool does not provide medical diagnoses, and my raw genetic data will not be stored on any server, transmitted to any third party, or used for any purpose beyond this browser session. Data persists until I close this tab.
          </span>
        </label>

        {error && <p style={{ fontSize: "0.72rem", color: "#f87171", marginBottom: "0.75rem" }}>{error}</p>}

        <input ref={fileRef} type="file" accept=".txt,.csv,.vcf" style={{ display: "none" }} onChange={handleFile} />
        <button
          disabled={!agreed || parsing}
          onClick={() => fileRef.current?.click()}
          style={{ width: "100%", padding: "0.625rem", borderRadius: 10, background: agreed && !parsing ? "#0284c7" : "rgba(51,65,85,0.4)", border: "none", color: agreed && !parsing ? "white" : "#334155", fontSize: "0.8rem", fontWeight: 600, cursor: agreed && !parsing ? "pointer" : "not-allowed", transition: "background 0.15s" }}
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
    <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "0.3rem 1.25rem", background: "rgba(8,47,73,0.35)", borderBottom: "1px solid rgba(14,165,233,0.1)", fontSize: "0.68rem", flexShrink: 0 }}>
      <span style={{ fontSize: "0.75rem" }}>🧬</span>
      <span style={{ color: "#38bdf8", fontWeight: 600 }}>DNA session active</span>
      <span style={{ color: "#1e3a5f" }}>·</span>
      <span style={{ color: "#475569" }}>{dnaData.totalCount.toLocaleString()} variants</span>
      <span style={{ color: "#1e3a5f" }}>·</span>
      <span style={{ color: "#475569" }}>{dnaData.format}</span>
      <span style={{ color: "#1e3a5f" }}>·</span>
      <span style={{ color: "#1e3a5f" }}>not stored · session only</span>
      <button onClick={onClear}
        style={{ marginLeft: "auto", background: "none", border: "none", color: "#334155", cursor: "pointer", fontSize: "0.9rem", padding: "0 2px", lineHeight: 1 }}
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

const SUGGESTIONS = [
  { label: "BRCA1 pathogenic variants", icon: "🧬" },
  { label: "What genes cause hereditary breast cancer?", icon: "🔬" },
  { label: "TP53 variants and cancer", icon: "🧬" },
  { label: "Alzheimer's disease genes", icon: "🔬" },
  { label: "EGFR variants in lung cancer", icon: "🧬" },
  { label: "Which genes are linked to Parkinson's?", icon: "🔬" },
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
        icon: meta.icon,
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
    if (m[2]) parts.push(<strong key={m.index} style={{ color: "#e2e8f0", fontWeight: 600 }}>{m[2]}</strong>);
    else if (m[3]) parts.push(<code key={m.index} style={{ fontFamily: "monospace", fontSize: "0.78em", background: "#1e293b", color: "#7dd3fc", padding: "0.1em 0.35em", borderRadius: 3 }}>{m[3]}</code>);
    else if (m[4]) parts.push(<em key={m.index} style={{ color: "#cbd5e1" }}>{m[4]}</em>);
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
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
        <h2 key={i} style={{ fontSize: "0.875rem", fontWeight: 700, color: "#f1f5f9", margin: "1.25rem 0 0.5rem", paddingBottom: "0.375rem", borderBottom: "1px solid #1e293b" }}>
          {renderInline(line.slice(3))}
        </h2>
      );
    } else if (line.startsWith("### ")) {
      elements.push(
        <h3 key={i} style={{ fontSize: "0.8rem", fontWeight: 600, color: "#cbd5e1", margin: "0.875rem 0 0.25rem" }}>
          {renderInline(line.slice(4))}
        </h3>
      );
    } else if (line.startsWith("- ") || line.startsWith("• ")) {
      const items = [];
      while (i < lines.length && (lines[i].startsWith("- ") || lines[i].startsWith("• "))) {
        items.push(<li key={i} style={{ color: "#94a3b8", fontSize: "0.875rem", lineHeight: 1.65, marginBottom: "0.2rem" }}>{renderInline(lines[i].slice(2))}</li>);
        i++;
      }
      elements.push(<ul key={`ul${i}`} style={{ paddingLeft: "1.25rem", listStyle: "disc", margin: "0.5rem 0" }}>{items}</ul>);
      continue;
    } else if (line.trim() === "") {
      elements.push(<div key={i} style={{ height: "0.375rem" }} />);
    } else {
      elements.push(<p key={i} style={{ color: "#94a3b8", fontSize: "0.875rem", lineHeight: 1.7, margin: "0.25rem 0" }}>{renderInline(line)}</p>);
    }
    i++;
  }
  return <div>{elements}</div>;
}

// ─── Data Cards ──────────────────────────────────────────────────────────────

const SIG_COLORS = {
  "Pathogenic": { bg: "rgba(127,29,29,0.4)", color: "#fca5a5", border: "rgba(185,28,28,0.3)" },
  "Likely pathogenic": { bg: "rgba(124,45,18,0.4)", color: "#fdba74", border: "rgba(194,65,12,0.3)" },
  "Benign": { bg: "rgba(5,46,22,0.4)", color: "#86efac", border: "rgba(21,128,61,0.3)" },
  "Likely benign": { bg: "rgba(4,47,46,0.4)", color: "#5eead4", border: "rgba(15,118,110,0.3)" },
  "Uncertain significance": { bg: "rgba(66,32,6,0.4)", color: "#fde68a", border: "rgba(161,98,7,0.3)" },
};

function VariantCard({ variant, userVariant, defaultExpanded }) {
  const [expanded, setExpanded] = useState(defaultExpanded || false);
  const sig = variant.clinical_significance || "Unknown";
  const c = SIG_COLORS[sig] || { bg: "rgba(30,41,59,0.6)", color: "#94a3b8", border: "rgba(51,65,85,0.4)" };
  const hasDetail = variant.condition || variant.consequence || variant.frequency != null || variant.review_status || variant.hgvs;
  return (
    <div
      onClick={() => hasDetail && setExpanded(e => !e)}
      style={{ background: "rgba(30,41,59,0.35)", border: `1px solid ${userVariant ? "rgba(14,165,233,0.4)" : expanded ? "rgba(14,165,233,0.35)" : "rgba(51,65,85,0.4)"}`, borderRadius: 10, padding: "0.75rem", cursor: hasDetail ? "pointer" : "default", transition: "border-color 0.15s" }}
    >
      {userVariant && (
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6, padding: "0.2rem 0.5rem", background: "rgba(14,165,233,0.1)", borderRadius: 6, border: "1px solid rgba(14,165,233,0.2)" }}>
          <span style={{ fontSize: "0.62rem", color: "#38bdf8", fontWeight: 600 }}>YOUR DATA</span>
          <span style={{ fontFamily: "monospace", fontSize: "0.7rem", color: "#7dd3fc", fontWeight: 700 }}>{userVariant.genotype}</span>
          {userVariant.chromosome && <span style={{ fontSize: "0.6rem", color: "#334155" }}>chr{userVariant.chromosome}</span>}
        </div>
      )}
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
        <div style={{ minWidth: 0 }}>
          <p style={{ fontFamily: "monospace", fontSize: "0.78rem", color: "#7dd3fc", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{variant.variant_id}</p>
          {!expanded && variant.condition && <p style={{ fontSize: "0.72rem", color: "#64748b", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{variant.condition}</p>}
        </div>
        <div style={{ textAlign: "right", flexShrink: 0 }}>
          <span style={{ fontSize: "0.7rem", padding: "0.2em 0.55em", borderRadius: 5, background: c.bg, color: c.color, border: `1px solid ${c.border}`, display: "inline-block" }}>{sig}</span>
          {!expanded && variant.frequency != null && (
            <p style={{ fontSize: "0.7rem", color: "#475569", marginTop: 3 }}>
              AF {variant.frequency < 0.0001 ? variant.frequency.toExponential(1) : variant.frequency.toFixed(5)}
            </p>
          )}
          {hasDetail && <p style={{ fontSize: "0.6rem", color: "#334155", marginTop: 3 }}>{expanded ? "▲ less" : "▼ more"}</p>}
        </div>
      </div>
      {expanded && (
        <div style={{ marginTop: "0.6rem", paddingTop: "0.6rem", borderTop: "1px solid rgba(51,65,85,0.3)", display: "flex", flexDirection: "column", gap: 4 }}>
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
              style={{ fontSize: "0.68rem", color: "#38bdf8", marginTop: 2 }}
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
      <span style={{ fontSize: "0.65rem", color: "#334155", flexShrink: 0, width: 110 }}>{label}</span>
      <span style={{ fontSize: mono ? "0.68rem" : "0.72rem", color: "#94a3b8", fontFamily: mono ? "monospace" : "inherit", wordBreak: "break-all" }}>{value}</span>
    </div>
  );
}

function GeneCard({ gene }) {
  return (
    <div style={{ background: "rgba(30,41,59,0.35)", border: "1px solid rgba(51,65,85,0.4)", borderRadius: 10, padding: "0.75rem" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
        <div style={{ minWidth: 0 }}>
          <p style={{ fontFamily: "monospace", fontSize: "0.85rem", color: "#c4b5fd", fontWeight: 700 }}>{gene.gene_symbol}</p>
          {gene.description && <p style={{ fontSize: "0.75rem", color: "#64748b", marginTop: 4, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{gene.description}</p>}
        </div>
        <div style={{ textAlign: "right", flexShrink: 0 }}>
          {gene.chromosome && <span style={{ fontSize: "0.7rem", padding: "0.2em 0.55em", borderRadius: 5, background: "rgba(30,41,59,0.7)", color: "#64748b", border: "1px solid rgba(51,65,85,0.4)", display: "inline-block" }}>Chr {gene.chromosome}</span>}
          {gene.publication_count > 0 && <p style={{ fontSize: "0.7rem", color: "#475569", marginTop: 3 }}>{gene.publication_count.toLocaleString()} pubs</p>}
        </div>
      </div>
    </div>
  );
}

function GeneInfoBanner({ geneInfo, proteinInfo, pubCount }) {
  if (!geneInfo) return null;
  return (
    <div style={{ background: "rgba(8,47,73,0.4)", border: "1px solid rgba(14,116,144,0.25)", borderRadius: 10, padding: "0.75rem", marginBottom: "1rem" }}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
        <div>
          <p style={{ fontFamily: "monospace", fontWeight: 700, color: "#7dd3fc", fontSize: "0.875rem" }}>{geneInfo.symbol}</p>
          {geneInfo.description && <p style={{ fontSize: "0.75rem", color: "#64748b", marginTop: 3 }}>{geneInfo.description}</p>}
          {proteinInfo?.protein_name && <p style={{ fontSize: "0.72rem", color: "#0ea5e9", opacity: 0.7, marginTop: 4 }}>Protein: {proteinInfo.protein_name}</p>}
        </div>
        <div style={{ textAlign: "right", flexShrink: 0 }}>
          {geneInfo.chromosome && <p style={{ fontSize: "0.72rem", color: "#475569" }}>Chr {geneInfo.chromosome}</p>}
          {pubCount > 0 && <p style={{ fontSize: "0.72rem", color: "#475569", marginTop: 3 }}>{pubCount.toLocaleString()} publications</p>}
        </div>
      </div>
      {proteinInfo?.function && <p style={{ fontSize: "0.72rem", color: "#475569", marginTop: 8, display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" }}>{proteinInfo.function}</p>}
    </div>
  );
}

const SIG_FILTER_OPTIONS = ["All", "Pathogenic", "Likely pathogenic", "Uncertain significance", "Likely benign", "Benign"];
const SIG_FILTER_SHORT = { "All": "All", "Pathogenic": "Path.", "Likely pathogenic": "Likely path.", "Uncertain significance": "VUS", "Likely benign": "Likely benign", "Benign": "Benign" };

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
          <p style={{ fontSize: "0.7rem", fontWeight: 600, color: "#475569", textTransform: "uppercase", letterSpacing: "0.08em" }}>
            {isGene
              ? `${items.length}${items.length !== allItems.length ? ` / ${allItems.length}` : ""} Variant${allItems.length !== 1 ? "s" : ""}`
              : `${allItems.length} Associated Genes`}
          </p>
          {matchCount > 0 && (
            <span style={{ fontSize: "0.62rem", padding: "0.15em 0.5em", borderRadius: 4, background: "rgba(14,165,233,0.15)", color: "#38bdf8", border: "1px solid rgba(14,165,233,0.25)" }}>
              {matchCount} in your data
            </span>
          )}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          {items.length > 6 && (
            <button onClick={() => setExpanded(e => !e)} style={{ fontSize: "0.72rem", color: "#38bdf8", background: "none", border: "none", cursor: "pointer" }}>
              {expanded ? "Show less" : `Show all ${items.length}`}
            </button>
          )}
          {isGene && (
            <select value={sortBy} onChange={e => setSortBy(e.target.value)}
              style={{ fontSize: "0.68rem", color: "#64748b", background: "rgba(15,23,42,0.7)", border: "1px solid rgba(51,65,85,0.4)", borderRadius: 6, padding: "0.2rem 0.4rem", cursor: "pointer", outline: "none" }}>
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
                  background: active && c ? c.bg : active ? "rgba(14,165,233,0.15)" : "rgba(15,23,42,0.5)",
                  color: active && c ? c.color : active ? "#38bdf8" : "#475569",
                  border: `1px solid ${active && c ? c.border : active ? "rgba(14,165,233,0.3)" : "rgba(51,65,85,0.3)"}` }}>
                {SIG_FILTER_SHORT[opt]}
              </button>
            );
          })}
          {matchCount > 0 && dnaData && (
            <button onClick={() => { setMyDataOnly(v => !v); setExpanded(false); }}
              style={{ fontSize: "0.65rem", padding: "0.18em 0.6em", borderRadius: 100, cursor: "pointer", marginLeft: 4, transition: "all 0.12s",
                background: myDataOnly ? "rgba(14,165,233,0.15)" : "rgba(15,23,42,0.5)",
                color: myDataOnly ? "#38bdf8" : "#475569",
                border: `1px solid ${myDataOnly ? "rgba(14,165,233,0.3)" : "rgba(51,65,85,0.3)"}`,
                fontWeight: myDataOnly ? 700 : 400 }}>
              🧬 My data only
            </button>
          )}
          {(sigFilter !== "All" || myDataOnly) && (
            <button onClick={() => { setSigFilter("All"); setMyDataOnly(false); }}
              style={{ fontSize: "0.62rem", color: "#334155", background: "none", border: "none", cursor: "pointer", marginLeft: 2 }}>
              Clear
            </button>
          )}
        </div>
      )}

      {items.length === 0 ? (
        <p style={{ fontSize: "0.75rem", color: "#334155", padding: "0.75rem 0" }}>No variants match the current filter.</p>
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
  "#0ea5e9","#6366f1","#8b5cf6","#ec4899","#f59e0b",
  "#10b981","#14b8a6","#f97316","#ef4444","#84cc16",
];

function PathwayViewer({ pathways }) {
  const [expanded, setExpanded] = useState(false);
  if (!pathways?.length) return null;
  const shown = expanded ? pathways : pathways.slice(0, 8);

  return (
    <div style={{ marginTop: "1rem", background: "rgba(15,23,42,0.6)", border: "1px solid rgba(99,102,241,0.2)", borderRadius: 12, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0.625rem 0.875rem", borderBottom: "1px solid rgba(99,102,241,0.15)" }}>
        <span style={{ fontSize: "0.78rem", fontWeight: 600, color: "#a5b4fc" }}>Biological Pathways</span>
        <span style={{ fontSize: "0.68rem", color: "#334155" }}>Reactome · {pathways.length} pathways</span>
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
    <div style={{ marginTop: "1rem", background: "rgba(15,23,42,0.6)", border: "1px solid rgba(16,185,129,0.2)", borderRadius: 12, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0.625rem 0.875rem", borderBottom: "1px solid rgba(16,185,129,0.15)" }}>
        <span style={{ fontSize: "0.78rem", fontWeight: 600, color: "#6ee7b7" }}>Tissue Expression</span>
        <span style={{ fontSize: "0.68rem", color: "#334155" }}>GTEx v8 · median TPM</span>
      </div>
      <div style={{ padding: "0.75rem", display: "flex", flexDirection: "column", gap: 5 }}>
        {top.map((e, i) => {
          const pct = max > 0 ? (e.median_tpm / max) * 100 : 0;
          const intensity = Math.max(0.3, pct / 100);
          return (
            <div key={e.tissue} style={{ display: "flex", alignItems: "center", gap: 8 }}>
              <span style={{ fontSize: "0.7rem", color: "#64748b", width: 140, flexShrink: 0, textAlign: "right", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{e.tissue}</span>
              <div style={{ flex: 1, height: 14, background: "rgba(30,41,59,0.5)", borderRadius: 3, overflow: "hidden" }}>
                <div style={{ width: `${pct}%`, height: "100%", background: `rgba(16,185,129,${intensity})`, borderRadius: 3, transition: "width 0.5s ease", minWidth: pct > 0 ? 2 : 0 }} />
              </div>
              <span style={{ fontSize: "0.68rem", color: "#475569", width: 50, textAlign: "right", flexShrink: 0 }}>{e.median_tpm}</span>
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
    <div style={{ marginTop: "1rem", background: "rgba(15,23,42,0.6)", border: "1px solid rgba(245,158,11,0.2)", borderRadius: 12, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0.625rem 0.875rem", borderBottom: "1px solid rgba(245,158,11,0.15)" }}>
        <span style={{ fontSize: "0.78rem", fontWeight: 600, color: "#fcd34d" }}>Protein Interactions</span>
        <span style={{ fontSize: "0.68rem", color: "#334155" }}>STRING DB · {interactions.length} partners</span>
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
          <circle cx={cx} cy={cy} r={22} fill="rgba(14,165,233,0.2)" stroke="#0ea5e9" strokeWidth={1.5} />
          <text x={cx} y={cy + 4} textAnchor="middle" fill="#7dd3fc" fontSize={10} fontWeight={700} fontFamily="monospace">{centerGene}</text>
          {nodes.map((node, i) => {
            const angle = (i / nodes.length) * 2 * Math.PI - Math.PI / 2;
            const nx = cx + r * Math.cos(angle);
            const ny = cy + r * Math.sin(angle);
            return (
              <g key={`n${i}`}>
                <circle cx={nx} cy={ny} r={16} fill="rgba(245,158,11,0.12)" stroke={`rgba(245,158,11,${0.4 + node.interaction_score * 0.6})`} strokeWidth={1} />
                <text x={nx} y={ny + 4} textAnchor="middle" fill="#fcd34d" fontSize={8} fontFamily="monospace">{node.gene}</text>
              </g>
            );
          })}
        </svg>
        <div style={{ flex: 1, padding: "0.75rem 0.75rem 0.75rem 0", overflowY: "auto", maxHeight: 360 }}>
          {nodes.map((node, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0.3rem 0", borderBottom: "1px solid rgba(30,41,59,0.4)" }}>
              <span style={{ fontFamily: "monospace", fontSize: "0.75rem", color: "#fcd34d" }}>{node.gene}</span>
              <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <div style={{ width: 40, height: 4, background: "rgba(30,41,59,0.5)", borderRadius: 2, overflow: "hidden" }}>
                  <div style={{ width: `${node.score_pct}%`, height: "100%", background: `rgba(245,158,11,${0.4 + node.interaction_score * 0.6})`, borderRadius: 2 }} />
                </div>
                <span style={{ fontSize: "0.65rem", color: "#475569" }}>{node.score_pct}%</span>
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
  4: { bg: "rgba(5,46,22,0.4)", color: "#86efac", border: "rgba(21,128,61,0.3)" },
  3: { bg: "rgba(8,47,73,0.4)", color: "#7dd3fc", border: "rgba(3,105,161,0.3)" },
  2: { bg: "rgba(23,37,84,0.4)", color: "#93c5fd", border: "rgba(29,78,216,0.25)" },
  1: { bg: "rgba(49,46,129,0.4)", color: "#c4b5fd", border: "rgba(109,40,217,0.3)" },
  0: { bg: "rgba(30,41,59,0.5)", color: "#94a3b8", border: "rgba(51,65,85,0.4)" },
};

function DrugPanel({ drugs }) {
  const [expanded, setExpanded] = useState(false);
  if (!drugs?.length) return null;
  const shown = expanded ? drugs : drugs.slice(0, 6);

  return (
    <div style={{ marginTop: "1rem", background: "rgba(15,23,42,0.6)", border: "1px solid rgba(134,239,172,0.2)", borderRadius: 12, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0.625rem 0.875rem", borderBottom: "1px solid rgba(134,239,172,0.12)" }}>
        <span style={{ fontSize: "0.78rem", fontWeight: 600, color: "#86efac" }}>Drug Interactions</span>
        <span style={{ fontSize: "0.68rem", color: "#334155" }}>Open Targets · {drugs.length} compounds</span>
      </div>
      <div style={{ padding: "0.75rem", display: "flex", flexDirection: "column", gap: 6 }}>
        {shown.map((drug, i) => {
          const phase = drug.phase ?? 0;
          const pc = PHASE_COLOR[Math.min(phase, 4)] || PHASE_COLOR[0];
          return (
            <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "0.5rem 0.6rem", background: "rgba(30,41,59,0.3)", borderRadius: 8, border: "1px solid rgba(51,65,85,0.25)" }}>
              <span style={{ fontSize: "0.68rem", padding: "0.2em 0.55em", borderRadius: 5, background: pc.bg, color: pc.color, border: `1px solid ${pc.border}`, flexShrink: 0, whiteSpace: "nowrap" }}>
                {PHASE_LABEL[Math.min(phase, 4)] || `Phase ${phase}`}
              </span>
              <div style={{ minWidth: 0, flex: 1 }}>
                <p style={{ fontFamily: "monospace", fontSize: "0.78rem", color: "#e2e8f0", fontWeight: 600 }}>{drug.name}</p>
                {drug.mechanism && <p style={{ fontSize: "0.7rem", color: "#64748b", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{drug.mechanism}</p>}
                {drug.indication && <p style={{ fontSize: "0.68rem", color: "#475569", marginTop: 1 }}>{drug.indication}</p>}
              </div>
              {drug.drug_type && <span style={{ fontSize: "0.62rem", color: "#334155", flexShrink: 0, alignSelf: "center" }}>{drug.drug_type}</span>}
            </div>
          );
        })}
      </div>
      {drugs.length > 6 && (
        <div style={{ padding: "0 0.875rem 0.625rem" }}>
          <button onClick={() => setExpanded(e => !e)} style={{ fontSize: "0.72rem", color: "#86efac", background: "none", border: "none", cursor: "pointer", padding: 0 }}>
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
    <div style={{ marginTop: "1rem", background: "rgba(15,23,42,0.6)", border: "1px solid rgba(99,102,241,0.15)", borderRadius: 12, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0.625rem 0.875rem", borderBottom: "1px solid rgba(99,102,241,0.1)" }}>
        <span style={{ fontSize: "0.78rem", fontWeight: 600, color: "#a5b4fc" }}>Population Frequencies</span>
        <span style={{ fontSize: "0.68rem", color: "#334155" }}>gnomAD r4 · aggregated AF by ancestry</span>
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
              <span style={{ fontSize: "0.68rem", color: "#64748b", width: 160, flexShrink: 0, textAlign: "right", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{pop.population}</span>
              <div style={{ flex: 1, height: 14, background: "rgba(30,41,59,0.5)", borderRadius: 3, overflow: "hidden" }}>
                <div style={{ width: `${pct}%`, height: "100%", background: color, borderRadius: 3, opacity: 0.8, transition: "width 0.5s ease", minWidth: pct > 0 ? 2 : 0 }} />
              </div>
              <span style={{ fontSize: "0.65rem", color: "#475569", width: 70, textAlign: "right", flexShrink: 0, fontFamily: "monospace" }}>{afDisplay}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Cancer Mutations Panel (COSMIC / NCI GDC) ───────────────────────────────

const CONSEQUENCE_COLORS = {
  "Missense": "#f97316", "Stop Gained": "#ef4444", "Frameshift": "#dc2626",
  "Splice Acceptor": "#8b5cf6", "Splice Donor": "#7c3aed", "Synonymous": "#22c55e",
  "Intron": "#64748b", "Start Lost": "#f59e0b", "Stop Lost": "#fb923c",
};

function CancerMutationsPanel({ data }) {
  if (!data?.cancer_types?.length) return null;
  const { cancer_types, consequence_types, total_mutations } = data;
  const max = Math.max(...cancer_types.map(c => c.mutation_count));

  return (
    <div style={{ marginTop: "1rem", background: "rgba(15,23,42,0.6)", border: "1px solid rgba(239,68,68,0.2)", borderRadius: 12, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0.625rem 0.875rem", borderBottom: "1px solid rgba(239,68,68,0.12)" }}>
        <span style={{ fontSize: "0.78rem", fontWeight: 600, color: "#fca5a5" }}>Somatic Cancer Mutations</span>
        <span style={{ fontSize: "0.68rem", color: "#334155" }}>NCI GDC / TCGA · {total_mutations?.toLocaleString()} mutations</span>
      </div>

      <div style={{ display: "flex", gap: 0 }}>
        {/* Cancer type bars */}
        <div style={{ flex: 1, padding: "0.75rem", display: "flex", flexDirection: "column", gap: 5 }}>
          {cancer_types.map((c) => {
            const pct = max > 0 ? (c.mutation_count / max) * 100 : 0;
            return (
              <div key={c.project_id} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: "0.68rem", color: "#64748b", width: 150, flexShrink: 0, textAlign: "right", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.cancer_type}</span>
                <div style={{ flex: 1, height: 14, background: "rgba(30,41,59,0.5)", borderRadius: 3, overflow: "hidden" }}>
                  <div style={{ width: `${pct}%`, height: "100%", background: `rgba(239,68,68,${0.3 + (pct / 100) * 0.6})`, borderRadius: 3, transition: "width 0.5s ease", minWidth: pct > 0 ? 2 : 0 }} />
                </div>
                <span style={{ fontSize: "0.65rem", color: "#475569", width: 40, textAlign: "right", flexShrink: 0 }}>{c.mutation_count}</span>
              </div>
            );
          })}
        </div>

        {/* Consequence type breakdown */}
        {consequence_types?.length > 0 && (
          <div style={{ width: 160, padding: "0.75rem", borderLeft: "1px solid rgba(30,41,59,0.5)", display: "flex", flexDirection: "column", gap: 5 }}>
            <p style={{ fontSize: "0.63rem", color: "#334155", textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 4 }}>Mutation Type</p>
            {consequence_types.map((ct, i) => {
              const color = CONSEQUENCE_COLORS[ct.type] || "#6366f1";
              return (
                <div key={i} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 4 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 4, minWidth: 0 }}>
                    <div style={{ width: 6, height: 6, borderRadius: 1, background: color, flexShrink: 0 }} />
                    <span style={{ fontSize: "0.65rem", color: "#64748b", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{ct.type}</span>
                  </div>
                  <span style={{ fontSize: "0.63rem", color: "#475569", flexShrink: 0 }}>{ct.count}</span>
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
  "Definitive":           { color: "#86efac", bg: "rgba(5,46,22,0.5)",   border: "rgba(21,128,61,0.4)" },
  "Strong":               { color: "#7dd3fc", bg: "rgba(8,47,73,0.5)",   border: "rgba(3,105,161,0.4)" },
  "Moderate":             { color: "#fde68a", bg: "rgba(66,32,6,0.4)",   border: "rgba(161,98,7,0.35)" },
  "Limited":              { color: "#fdba74", bg: "rgba(124,45,18,0.4)", border: "rgba(194,65,12,0.3)" },
  "Disputed":             { color: "#fca5a5", bg: "rgba(127,29,29,0.4)", border: "rgba(185,28,28,0.3)" },
  "Refuted":              { color: "#f87171", bg: "rgba(127,29,29,0.5)", border: "rgba(185,28,28,0.4)" },
  "No Reported Evidence": { color: "#94a3b8", bg: "rgba(30,41,59,0.5)", border: "rgba(51,65,85,0.4)" },
};

function ClinGenPanel({ curations }) {
  if (!curations?.length) return null;
  return (
    <div style={{ marginTop: "1rem", background: "rgba(15,23,42,0.6)", border: "1px solid rgba(134,239,172,0.18)", borderRadius: 12, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0.625rem 0.875rem", borderBottom: "1px solid rgba(134,239,172,0.1)" }}>
        <span style={{ fontSize: "0.78rem", fontWeight: 600, color: "#86efac" }}>ClinGen Gene-Disease Validity</span>
        <span style={{ fontSize: "0.68rem", color: "#334155" }}>Expert curated · {curations.length} associations</span>
      </div>
      <div style={{ padding: "0.75rem", display: "flex", flexDirection: "column", gap: 6 }}>
        {curations.map((c, i) => {
          const cs = CLINGEN_STYLE[c.classification] || CLINGEN_STYLE["No Reported Evidence"];
          return (
            <a key={i} href={c.url} target="_blank" rel="noreferrer" style={{ textDecoration: "none" }}>
              <div style={{ padding: "0.5rem 0.65rem", background: "rgba(30,41,59,0.3)", border: "1px solid rgba(51,65,85,0.25)", borderRadius: 8, display: "flex", alignItems: "center", gap: 10 }}
                onMouseEnter={e => e.currentTarget.style.borderColor = "rgba(134,239,172,0.3)"}
                onMouseLeave={e => e.currentTarget.style.borderColor = "rgba(51,65,85,0.25)"}
              >
                <span style={{ fontSize: "0.68rem", padding: "0.2em 0.55em", borderRadius: 5, background: cs.bg, color: cs.color, border: `1px solid ${cs.border}`, flexShrink: 0, whiteSpace: "nowrap" }}>
                  {c.classification}
                </span>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <p style={{ fontSize: "0.73rem", color: "#94a3b8", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{c.disease}</p>
                  {(c.moi || c.gcep) && (
                    <p style={{ fontSize: "0.63rem", color: "#475569", marginTop: 2 }}>
                      {[c.moi, c.gcep].filter(Boolean).join(" · ")}
                    </p>
                  )}
                </div>
                <span style={{ fontSize: "0.6rem", color: "#334155", flexShrink: 0 }}>↗</span>
              </div>
            </a>
          );
        })}
      </div>
      <div style={{ padding: "0.35rem 0.875rem 0.6rem", borderTop: "1px solid rgba(30,41,59,0.4)", display: "flex", flexWrap: "wrap", gap: 6 }}>
        {Object.entries(CLINGEN_STYLE).map(([label, s]) => (
          <div key={label} style={{ display: "flex", alignItems: "center", gap: 3 }}>
            <span style={{ fontSize: "0.58rem", padding: "0.1em 0.35em", borderRadius: 3, background: s.bg, color: s.color, border: `1px solid ${s.border}` }}>{label}</span>
          </div>
        ))}
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
    <div style={{ marginTop: "1rem", background: "rgba(15,23,42,0.6)", border: "1px solid rgba(251,191,36,0.18)", borderRadius: 12, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0.625rem 0.875rem", borderBottom: "1px solid rgba(251,191,36,0.1)" }}>
        <span style={{ fontSize: "0.78rem", fontWeight: 600, color: "#fbbf24" }}>Publication Timeline</span>
        <span style={{ fontSize: "0.68rem", color: "#334155" }}>PubMed · papers per year</span>
      </div>
      <div style={{ padding: "0.75rem 0.875rem 0.6rem" }}>
        <div style={{ display: "flex", alignItems: "flex-end", gap: 4, height: BAR_H + 24 }}>
          {timeline.map(({ year, count }) => {
            const barH = count > 0 ? Math.max(4, Math.round((count / max) * BAR_H)) : 2;
            const opacity = count > 0 ? 0.7 + 0.3 * (count / max) : 0.15;
            return (
              <div key={year} style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 3 }}
                title={`${year}: ${count.toLocaleString()} publications`}>
                <span style={{ fontSize: "0.58rem", color: count > 0 ? "#fbbf24" : "#334155", lineHeight: 1 }}>
                  {count > 0 ? (count >= 1000 ? `${(count/1000).toFixed(1)}k` : count) : ""}
                </span>
                <div style={{ width: "100%", height: barH, background: `rgba(251,191,36,${opacity})`, borderRadius: "3px 3px 0 0", transition: "height 0.3s" }} />
                <span style={{ fontSize: "0.58rem", color: "#475569", transform: "rotate(-45deg)", transformOrigin: "top center", marginTop: 2, whiteSpace: "nowrap" }}>
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
    if (p === null || p === undefined) return "#94a3b8";
    if (p < 5e-8) return "#f87171";   // genome-wide significant
    if (p < 1e-5) return "#fb923c";   // suggestive
    return "#fbbf24";                  // nominal
  };

  return (
    <div style={{ marginTop: "1rem", background: "rgba(15,23,42,0.6)", border: "1px solid rgba(248,113,113,0.18)", borderRadius: 12, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0.625rem 0.875rem", borderBottom: "1px solid rgba(248,113,113,0.1)" }}>
        <span style={{ fontSize: "0.78rem", fontWeight: 600, color: "#f87171" }}>GWAS Catalog</span>
        <span style={{ fontSize: "0.68rem", color: "#334155" }}>Trait associations · {gwas.length} results</span>
      </div>
      <div style={{ padding: "0.75rem", display: "flex", flexDirection: "column", gap: 5 }}>
        {gwas.map((a, i) => (
          <a key={i} href={a.url} target="_blank" rel="noreferrer" style={{ textDecoration: "none" }}>
            <div style={{ padding: "0.45rem 0.65rem", background: "rgba(30,41,59,0.3)", border: "1px solid rgba(51,65,85,0.25)", borderRadius: 8, display: "flex", alignItems: "center", gap: 10 }}
              onMouseEnter={e => e.currentTarget.style.borderColor = "rgba(248,113,113,0.3)"}
              onMouseLeave={e => e.currentTarget.style.borderColor = "rgba(51,65,85,0.25)"}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <p style={{ fontSize: "0.73rem", color: "#e2e8f0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{a.trait}</p>
                <div style={{ display: "flex", gap: 8, marginTop: 2, alignItems: "center" }}>
                  {a.risk_allele && <span style={{ fontSize: "0.62rem", color: "#64748b" }}>{a.risk_allele}</span>}
                  {a.or_beta != null && <span style={{ fontSize: "0.62rem", color: "#64748b" }}>OR/β={a.or_beta.toFixed(2)}</span>}
                  {a.pmid && <span style={{ fontSize: "0.62rem", color: "#475569" }}>PMID:{a.pmid}</span>}
                </div>
              </div>
              <span style={{ fontSize: "0.65rem", fontFamily: "monospace", color: sigColor(a.p_value), flexShrink: 0, whiteSpace: "nowrap" }}>
                {a.p_value_str !== "N/A" ? `p=${a.p_value_str}` : "p=N/A"}
              </span>
            </div>
          </a>
        ))}
      </div>
      <div style={{ padding: "0.35rem 0.875rem 0.5rem", borderTop: "1px solid rgba(30,41,59,0.4)", display: "flex", gap: 12, alignItems: "center" }}>
        {[["< 5×10⁻⁸", "#f87171", "Genome-wide"], ["< 1×10⁻⁵", "#fb923c", "Suggestive"], ["other", "#fbbf24", "Nominal"]].map(([thr, col, lbl]) => (
          <div key={lbl} style={{ display: "flex", alignItems: "center", gap: 4 }}>
            <div style={{ width: 7, height: 7, borderRadius: "50%", background: col }} />
            <span style={{ fontSize: "0.62rem", color: "#475569" }}>{lbl}</span>
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
      background: activeTab === id ? "rgba(139,92,246,0.15)" : "transparent",
      color: activeTab === id ? "#a78bfa" : "#475569",
      borderBottom: activeTab === id ? "2px solid #a78bfa" : "2px solid transparent",
    }}>
      {label}{count > 0 ? <span style={{ marginLeft: 4, fontSize: "0.62rem", color: "#334155" }}>({count})</span> : null}
    </button>
  );

  return (
    <div style={{ marginTop: "1rem", background: "rgba(15,23,42,0.6)", border: "1px solid rgba(167,139,250,0.18)", borderRadius: 12, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0.625rem 0.875rem", borderBottom: "1px solid rgba(167,139,250,0.1)" }}>
        <span style={{ fontSize: "0.78rem", fontWeight: 600, color: "#a78bfa" }}>Phenotype Associations</span>
        <span style={{ fontSize: "0.68rem", color: "#334155" }}>HPO · Monarch Initiative</span>
      </div>

      {/* Tabs */}
      <div style={{ display: "flex", borderBottom: "1px solid rgba(30,41,59,0.5)", paddingLeft: "0.5rem" }}>
        {hasHPO && <Tab id="hpo" label="HPO Terms" count={hpoTerms.length} />}
        {hpoDiseases.length > 0 && <Tab id="hpo_disease" label="HPO Diseases" count={hpoDiseases.length} />}
        {hasMonarch && <Tab id="monarch" label="Monarch" count={monarchDiseases.length + monarchPhenos.length} />}
      </div>

      <div style={{ padding: "0.65rem 0.75rem", maxHeight: 260, overflowY: "auto" }}>
        {activeTab === "hpo" && hpoTerms.map((t, i) => (
          <a key={i} href={t.url} target="_blank" rel="noreferrer" style={{ textDecoration: "none" }}>
            <div style={{ padding: "0.4rem 0.6rem", marginBottom: 4, background: "rgba(30,41,59,0.3)", border: "1px solid rgba(51,65,85,0.2)", borderRadius: 7, display: "flex", gap: 8, alignItems: "flex-start" }}
              onMouseEnter={e => e.currentTarget.style.borderColor = "rgba(167,139,250,0.3)"}
              onMouseLeave={e => e.currentTarget.style.borderColor = "rgba(51,65,85,0.2)"}
            >
              <span style={{ fontSize: "0.6rem", padding: "0.15em 0.4em", borderRadius: 4, background: "rgba(139,92,246,0.15)", color: "#a78bfa", border: "1px solid rgba(139,92,246,0.2)", flexShrink: 0, fontFamily: "monospace" }}>{t.id}</span>
              <div style={{ flex: 1 }}>
                <p style={{ fontSize: "0.72rem", color: "#e2e8f0" }}>{t.name}</p>
                {t.definition && <p style={{ fontSize: "0.62rem", color: "#475569", marginTop: 1, lineHeight: 1.4 }}>{t.definition.slice(0, 120)}{t.definition.length > 120 ? "…" : ""}</p>}
              </div>
            </div>
          </a>
        ))}

        {activeTab === "hpo_disease" && hpoDiseases.map((d, i) => (
          <div key={i} style={{ padding: "0.4rem 0.6rem", marginBottom: 4, background: "rgba(30,41,59,0.3)", border: "1px solid rgba(51,65,85,0.2)", borderRadius: 7, display: "flex", gap: 8, alignItems: "center" }}>
            <span style={{ fontSize: "0.6rem", padding: "0.15em 0.4em", borderRadius: 4, background: "rgba(139,92,246,0.1)", color: "#7c3aed", border: "1px solid rgba(109,40,217,0.2)", flexShrink: 0, fontFamily: "monospace" }}>{d.db}</span>
            <p style={{ fontSize: "0.72rem", color: "#e2e8f0" }}>{d.name}</p>
          </div>
        ))}

        {activeTab === "monarch" && (
          <>
            {monarchDiseases.length > 0 && (
              <>
                <p style={{ fontSize: "0.65rem", color: "#475569", marginBottom: 5, textTransform: "uppercase", letterSpacing: "0.08em" }}>Disease Associations</p>
                {monarchDiseases.map((d, i) => (
                  <a key={i} href={d.url} target="_blank" rel="noreferrer" style={{ textDecoration: "none" }}>
                    <div style={{ padding: "0.4rem 0.6rem", marginBottom: 4, background: "rgba(30,41,59,0.3)", border: "1px solid rgba(51,65,85,0.2)", borderRadius: 7, display: "flex", gap: 8, alignItems: "center" }}
                      onMouseEnter={e => e.currentTarget.style.borderColor = "rgba(167,139,250,0.3)"}
                      onMouseLeave={e => e.currentTarget.style.borderColor = "rgba(51,65,85,0.2)"}
                    >
                      <div style={{ flex: 1 }}>
                        <p style={{ fontSize: "0.72rem", color: "#e2e8f0" }}>{d.name}</p>
                        {d.predicate && <p style={{ fontSize: "0.62rem", color: "#475569", marginTop: 1 }}>{d.predicate}</p>}
                      </div>
                      <span style={{ fontSize: "0.6rem", fontFamily: "monospace", color: "#334155" }}>↗</span>
                    </div>
                  </a>
                ))}
              </>
            )}
            {monarchPhenos.length > 0 && (
              <>
                <p style={{ fontSize: "0.65rem", color: "#475569", margin: "8px 0 5px", textTransform: "uppercase", letterSpacing: "0.08em" }}>Phenotypic Features</p>
                {monarchPhenos.map((p, i) => (
                  <a key={i} href={p.url} target="_blank" rel="noreferrer" style={{ textDecoration: "none" }}>
                    <div style={{ padding: "0.35rem 0.6rem", marginBottom: 3, background: "rgba(30,41,59,0.2)", border: "1px solid rgba(51,65,85,0.15)", borderRadius: 6 }}
                      onMouseEnter={e => e.currentTarget.style.borderColor = "rgba(167,139,250,0.25)"}
                      onMouseLeave={e => e.currentTarget.style.borderColor = "rgba(51,65,85,0.15)"}
                    >
                      <p style={{ fontSize: "0.7rem", color: "#94a3b8" }}>{p.name}</p>
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
  "1A": { color: "#86efac", bg: "rgba(5,46,22,0.5)",   border: "rgba(21,128,61,0.4)" },
  "1B": { color: "#6ee7b7", bg: "rgba(5,46,22,0.35)",  border: "rgba(21,128,61,0.3)" },
  "2A": { color: "#7dd3fc", bg: "rgba(8,47,73,0.5)",   border: "rgba(3,105,161,0.4)" },
  "2B": { color: "#93c5fd", bg: "rgba(23,37,84,0.4)",  border: "rgba(29,78,216,0.25)" },
  "3":  { color: "#fde68a", bg: "rgba(66,32,6,0.4)",   border: "rgba(161,98,7,0.3)" },
  "4":  { color: "#94a3b8", bg: "rgba(30,41,59,0.5)",  border: "rgba(51,65,85,0.4)" },
};

function PharmGKBPanel({ pgkb }) {
  const [tab, setTab] = useState("annotations");
  if (!pgkb?.related_drugs?.length && !pgkb?.clinical_annotations?.length) return null;
  const annotations = pgkb.clinical_annotations || [];
  const relatedDrugs = pgkb.related_drugs || [];

  const tabBtn = (id, label, count) => (
    <button onClick={() => setTab(id)} style={{
      fontSize: "0.7rem", padding: "0.25rem 0.65rem", borderRadius: 6, cursor: "pointer", border: "none",
      background: tab === id ? "rgba(14,165,233,0.2)" : "transparent",
      color: tab === id ? "#38bdf8" : "#475569",
      borderBottom: tab === id ? "2px solid #0ea5e9" : "2px solid transparent",
    }}>
      {label} {count > 0 && <span style={{ fontSize: "0.62rem", color: tab === id ? "#38bdf8" : "#334155" }}>({count})</span>}
    </button>
  );

  return (
    <div style={{ marginTop: "1rem", background: "rgba(15,23,42,0.6)", border: "1px solid rgba(56,189,248,0.2)", borderRadius: 12, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0.625rem 0.875rem", borderBottom: "1px solid rgba(56,189,248,0.12)" }}>
        <span style={{ fontSize: "0.78rem", fontWeight: 600, color: "#38bdf8" }}>Pharmacogenomics</span>
        <a href={pgkb.url} target="_blank" rel="noreferrer" style={{ fontSize: "0.68rem", color: "#334155", textDecoration: "none" }}>PharmGKB ↗</a>
      </div>

      {/* Tabs */}
      <div style={{ display: "flex", gap: 2, padding: "0 0.875rem", borderBottom: "1px solid rgba(30,41,59,0.5)" }}>
        {tabBtn("annotations", "Clinical Annotations", annotations.length)}
        {tabBtn("drugs", "Related Drugs", relatedDrugs.length)}
      </div>

      <div style={{ padding: "0.75rem" }}>
        {tab === "annotations" && (
          annotations.length === 0
            ? <p style={{ fontSize: "0.72rem", color: "#475569", padding: "0.5rem 0" }}>No clinical annotations found for this gene.</p>
            : <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {annotations.map((ann, i) => {
                  const ls = PGX_LEVEL_STYLE[ann.level] || PGX_LEVEL_STYLE["4"];
                  return (
                    <a key={i} href={ann.url} target="_blank" rel="noreferrer" style={{ textDecoration: "none" }}>
                      <div style={{ padding: "0.5rem 0.65rem", background: "rgba(30,41,59,0.3)", border: "1px solid rgba(51,65,85,0.25)", borderRadius: 8, display: "flex", gap: 10, alignItems: "flex-start" }}
                        onMouseEnter={e => e.currentTarget.style.borderColor = "rgba(56,189,248,0.3)"}
                        onMouseLeave={e => e.currentTarget.style.borderColor = "rgba(51,65,85,0.25)"}
                      >
                        <span title={ann.level_label} style={{ fontSize: "0.65rem", padding: "0.2em 0.5em", borderRadius: 4, background: ls.bg, color: ls.color, border: `1px solid ${ls.border}`, flexShrink: 0, cursor: "help", whiteSpace: "nowrap" }}>
                          Level {ann.level}
                        </span>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          {ann.drugs.length > 0 && (
                            <p style={{ fontFamily: "monospace", fontSize: "0.75rem", color: "#e2e8f0", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                              {ann.drugs.join(", ")}
                            </p>
                          )}
                          {ann.phenotype && <p style={{ fontSize: "0.7rem", color: "#64748b", marginTop: 2 }}>{ann.phenotype}</p>}
                          {ann.variant && <p style={{ fontSize: "0.65rem", color: "#475569", marginTop: 1, fontFamily: "monospace" }}>{ann.variant}</p>}
                        </div>
                        <span style={{ fontSize: "0.6rem", color: "#334155", flexShrink: 0 }}>↗</span>
                      </div>
                    </a>
                  );
                })}
              </div>
        )}

        {tab === "drugs" && (
          relatedDrugs.length === 0
            ? <p style={{ fontSize: "0.72rem", color: "#475569", padding: "0.5rem 0" }}>No related drugs found.</p>
            : <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                {relatedDrugs.map((d, i) => (
                  <a key={i} href={d.url} target="_blank" rel="noreferrer" style={{ textDecoration: "none" }}>
                    <span style={{ display: "inline-block", fontSize: "0.72rem", padding: "0.25rem 0.65rem", borderRadius: 100, background: "rgba(14,165,233,0.1)", border: "1px solid rgba(14,165,233,0.2)", color: "#38bdf8", cursor: "pointer" }}
                      onMouseEnter={e => e.currentTarget.style.background = "rgba(14,165,233,0.2)"}
                      onMouseLeave={e => e.currentTarget.style.background = "rgba(14,165,233,0.1)"}
                    >
                      {d.name}
                    </span>
                  </a>
                ))}
              </div>
        )}
      </div>

      {/* Level legend */}
      {tab === "annotations" && annotations.length > 0 && (
        <div style={{ padding: "0.4rem 0.875rem 0.6rem", borderTop: "1px solid rgba(30,41,59,0.4)", display: "flex", flexWrap: "wrap", gap: 8 }}>
          {Object.entries(PGX_LEVEL_STYLE).map(([level, s]) => (
            <div key={level} style={{ display: "flex", alignItems: "center", gap: 3 }}>
              <span style={{ fontSize: "0.6rem", padding: "0.1em 0.35em", borderRadius: 3, background: s.bg, color: s.color, border: `1px solid ${s.border}` }}>{level}</span>
            </div>
          ))}
          <span style={{ fontSize: "0.6rem", color: "#334155", marginLeft: 4 }}>1A = highest evidence → 4 = case reports</span>
        </div>
      )}
    </div>
  );
}

// ─── Variant Domain Map (Lollipop) ───────────────────────────────────────────

const LOLLIPOP_SIG_COLOR = (sig) => {
  if (!sig) return "#94a3b8";
  const s = sig.toLowerCase();
  if (s.includes("pathogenic") && !s.includes("likely")) return "#ef4444";
  if (s.includes("likely pathogenic")) return "#f97316";
  if (s.includes("benign") && !s.includes("likely")) return "#22c55e";
  if (s.includes("likely benign")) return "#14b8a6";
  if (s.includes("uncertain")) return "#eab308";
  return "#94a3b8";
};

const DOMAIN_PALETTE = ["#3b82f6","#8b5cf6","#ec4899","#f59e0b","#10b981","#06b6d4","#f97316","#a855f7","#14b8a6","#6366f1"];

function LollipopMap({ variants, domains, proteinLength, geneName }) {
  const [tooltip, setTooltip] = useState(null);
  if (!proteinLength) return null;

  const positioned = (variants || [])
    .filter(v => v.protein_position > 0 && v.protein_position <= proteinLength)
    .sort((a, b) => a.protein_position - b.protein_position);

  if (!positioned.length && !domains?.length) return null;

  const W = 680, H = 225;
  const ML = 8, MR = 8, MB = 40;
  const plotW = W - ML - MR;
  const barY = H - MB - 18;
  const barH = 18;
  const toX = (pos) => ML + (pos / proteinLength) * plotW;

  // Lane assignment: stack colliding lollipops
  const LANE_Y = [28, 52, 76, 100, 120];
  const MIN_GAP = 12;
  const laneEnds = LANE_Y.map(() => -Infinity);
  const lollipops = positioned.map(v => {
    const x = toX(v.protein_position);
    let lane = laneEnds.findIndex(end => x - end > MIN_GAP);
    if (lane === -1) lane = LANE_Y.length - 1;
    laneEnds[lane] = x;
    return { ...v, x, cy: LANE_Y[lane] };
  });

  const ticks = [0, 0.25, 0.5, 0.75, 1.0];

  return (
    <div style={{ marginTop: "1rem", background: "rgba(15,23,42,0.6)", border: "1px solid rgba(99,102,241,0.2)", borderRadius: 12, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0.625rem 0.875rem", borderBottom: "1px solid rgba(99,102,241,0.12)" }}>
        <span style={{ fontSize: "0.78rem", fontWeight: 600, color: "#a5b4fc" }}>Variant Domain Map</span>
        <span style={{ fontSize: "0.68rem", color: "#334155" }}>
          {positioned.length} variants · {proteinLength} aa · UniProt / ClinVar
        </span>
      </div>

      <div style={{ padding: "0.75rem 0.875rem", position: "relative" }}>
        <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: "block", overflow: "visible" }}>
          {/* Protein bar */}
          <rect x={ML} y={barY} width={plotW} height={barH} rx={3}
            fill="rgba(30,41,59,0.9)" stroke="rgba(99,102,241,0.3)" strokeWidth={1} />

          {/* Domain blocks */}
          {(domains || []).map((d, i) => {
            const x = toX(d.start);
            const w = Math.max(4, toX(d.end) - x);
            const color = DOMAIN_PALETTE[i % DOMAIN_PALETTE.length];
            return (
              <g key={i}>
                <rect x={x} y={barY} width={w} height={barH} rx={2} fill={color} opacity={0.75} />
                {w > 32 && (
                  <text x={x + w / 2} y={barY + barH / 2 + 4} textAnchor="middle"
                    fill="white" fontSize={7.5} fontWeight={600} style={{ pointerEvents: "none" }}>
                    {d.name.length > 14 ? d.name.slice(0, 12) + "…" : d.name}
                  </text>
                )}
              </g>
            );
          })}

          {/* Position ticks */}
          {ticks.map(frac => {
            const pos = Math.round(frac * proteinLength);
            const x = ML + frac * plotW;
            return (
              <g key={frac}>
                <line x1={x} y1={barY + barH} x2={x} y2={barY + barH + 5} stroke="#334155" strokeWidth={1} />
                <text x={x} y={barY + barH + 15} textAnchor="middle" fill="#475569" fontSize={9}>{pos}</text>
              </g>
            );
          })}

          {/* Gene label */}
          <text x={ML} y={barY - 5} fill="#475569" fontSize={9}>{geneName}</text>
          <text x={W - MR} y={barY - 5} textAnchor="end" fill="#475569" fontSize={9}>{proteinLength} aa</text>

          {/* Lollipops */}
          {lollipops.map((v, i) => {
            const color = LOLLIPOP_SIG_COLOR(v.clinical_significance);
            const isHovered = tooltip?.variant_id === v.variant_id;
            return (
              <g key={i} style={{ cursor: "pointer" }}
                onMouseEnter={() => setTooltip(v)}
                onMouseLeave={() => setTooltip(null)}>
                <line x1={v.x} y1={v.cy + 5} x2={v.x} y2={barY}
                  stroke={color} strokeWidth={isHovered ? 1.5 : 1} opacity={isHovered ? 0.9 : 0.55} />
                <circle cx={v.x} cy={v.cy} r={isHovered ? 6.5 : 5}
                  fill={color} opacity={isHovered ? 1 : 0.8}
                  stroke={isHovered ? "white" : "none"} strokeWidth={1} />
              </g>
            );
          })}
        </svg>

        {/* Tooltip */}
        {tooltip && (
          <div style={{ position: "absolute", top: 8, left: "50%", transform: "translateX(-50%)",
            background: "rgba(15,23,42,0.97)", border: "1px solid rgba(99,102,241,0.45)",
            borderRadius: 8, padding: "0.5rem 0.75rem", pointerEvents: "none", zIndex: 10,
            minWidth: 210, boxShadow: "0 4px 20px rgba(0,0,0,0.5)" }}>
            <p style={{ fontFamily: "monospace", fontSize: "0.75rem", color: "#a5b4fc", fontWeight: 600 }}>
              {tooltip.hgvs || tooltip.variant_id}
            </p>
            <p style={{ fontSize: "0.7rem", color: LOLLIPOP_SIG_COLOR(tooltip.clinical_significance), marginTop: 3 }}>
              {tooltip.clinical_significance || "Unknown significance"}
            </p>
            {tooltip.condition && (
              <p style={{ fontSize: "0.68rem", color: "#64748b", marginTop: 3 }}>{tooltip.condition}</p>
            )}
            <p style={{ fontSize: "0.65rem", color: "#475569", marginTop: 3 }}>
              Position: {tooltip.protein_position}
            </p>
          </div>
        )}

        {/* Domain legend */}
        {domains?.length > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginTop: "0.5rem" }}>
            {domains.slice(0, 8).map((d, i) => (
              <div key={i} style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <div style={{ width: 10, height: 10, borderRadius: 2, background: DOMAIN_PALETTE[i % DOMAIN_PALETTE.length], opacity: 0.8 }} />
                <span style={{ fontSize: "0.62rem", color: "#475569" }}>{d.name}</span>
              </div>
            ))}
          </div>
        )}

        {/* Variant significance legend */}
        <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginTop: "0.4rem" }}>
          {[["#ef4444","Pathogenic"],["#f97316","Likely path."],["#eab308","VUS"],["#14b8a6","Likely benign"],["#22c55e","Benign"],["#94a3b8","Other"]].map(([color, label]) => (
            <div key={label} style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <svg width={10} height={10} style={{ flexShrink: 0 }}><circle cx={5} cy={5} r={4} fill={color} /></svg>
              <span style={{ fontSize: "0.62rem", color: "#475569" }}>{label}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── OMIM Panel ──────────────────────────────────────────────────────────────

const INHERITANCE_STYLE = {
  AD:  { color: "#7dd3fc", bg: "rgba(8,47,73,0.5)",   border: "rgba(3,105,161,0.4)" },
  AR:  { color: "#fdba74", bg: "rgba(124,45,18,0.4)", border: "rgba(194,65,12,0.3)" },
  XLD: { color: "#c4b5fd", bg: "rgba(49,46,129,0.4)", border: "rgba(109,40,217,0.3)" },
  XLR: { color: "#d8b4fe", bg: "rgba(59,7,100,0.4)",  border: "rgba(126,34,206,0.3)" },
  XL:  { color: "#d8b4fe", bg: "rgba(59,7,100,0.4)",  border: "rgba(126,34,206,0.3)" },
  MT:  { color: "#fca5a5", bg: "rgba(127,29,29,0.4)", border: "rgba(185,28,28,0.3)" },
  SMT: { color: "#fde68a", bg: "rgba(66,32,6,0.4)",   border: "rgba(161,98,7,0.3)" },
  DG:  { color: "#86efac", bg: "rgba(5,46,22,0.4)",   border: "rgba(21,128,61,0.3)" },
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
    <div style={{ marginTop: "1rem", background: "rgba(15,23,42,0.6)", border: "1px solid rgba(167,139,250,0.2)", borderRadius: 12, overflow: "hidden" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "0.625rem 0.875rem", borderBottom: "1px solid rgba(167,139,250,0.12)" }}>
        <span style={{ fontSize: "0.78rem", fontWeight: 600, color: "#c4b5fd" }}>OMIM — Genetic Disease Catalog</span>
        <span style={{ fontSize: "0.68rem", color: "#334155" }}>Online Mendelian Inheritance in Man</span>
      </div>

      <div style={{ padding: "0.75rem", display: "flex", flexDirection: "column", gap: 6 }}>
        {/* Gene entry */}
        {omim.gene_entry && (
          <a href={omim.gene_entry.url} target="_blank" rel="noreferrer" style={{ textDecoration: "none" }}>
            <div style={{ padding: "0.5rem 0.65rem", background: "rgba(167,139,250,0.08)", border: "1px solid rgba(167,139,250,0.2)", borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
              <div style={{ minWidth: 0 }}>
                <p style={{ fontSize: "0.72rem", color: "#c4b5fd", fontWeight: 600 }}>{omim.gene_entry.title}</p>
                <p style={{ fontSize: "0.65rem", color: "#475569", marginTop: 2 }}>Gene entry · MIM #{omim.gene_entry.mim_number}</p>
              </div>
              <span style={{ fontSize: "0.65rem", color: "#6366f1", flexShrink: 0 }}>↗</span>
            </div>
          </a>
        )}

        {/* Phenotype entries */}
        {phenotypes.length > 0 && (
          <>
            <p style={{ fontSize: "0.65rem", color: "#334155", textTransform: "uppercase", letterSpacing: "0.08em", marginTop: 4 }}>
              Associated Disorders ({phenotypes.length})
            </p>
            {shown.map((p, i) => {
              const iStyle = p.inheritance ? (INHERITANCE_STYLE[p.inheritance] || {}) : {};
              return (
                <a key={i} href={p.url} target="_blank" rel="noreferrer" style={{ textDecoration: "none" }}>
                  <div style={{ padding: "0.45rem 0.65rem", background: "rgba(30,41,59,0.3)", border: "1px solid rgba(51,65,85,0.3)", borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}
                    onMouseEnter={e => e.currentTarget.style.borderColor = "rgba(167,139,250,0.3)"}
                    onMouseLeave={e => e.currentTarget.style.borderColor = "rgba(51,65,85,0.3)"}
                  >
                    <p style={{ fontSize: "0.72rem", color: "#94a3b8", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.title}</p>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
                      {p.inheritance && (
                        <span title={INHERITANCE_FULL[p.inheritance]} style={{ fontSize: "0.62rem", padding: "0.15em 0.45em", borderRadius: 4, background: iStyle.bg, color: iStyle.color, border: `1px solid ${iStyle.border}`, cursor: "help" }}>
                          {p.inheritance}
                        </span>
                      )}
                      <span style={{ fontSize: "0.62rem", color: "#334155", fontFamily: "monospace" }}>#{p.mim_number}</span>
                      <span style={{ fontSize: "0.62rem", color: "#334155" }}>↗</span>
                    </div>
                  </div>
                </a>
              );
            })}
            {phenotypes.length > 5 && (
              <button onClick={() => setExpanded(e => !e)} style={{ fontSize: "0.72rem", color: "#a78bfa", background: "none", border: "none", cursor: "pointer", padding: "0.25rem 0", textAlign: "left" }}>
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
      <span style={{ fontSize: "0.68rem", color: "#475569", padding: "0.4rem 0.5rem", borderBottom: "1px solid rgba(30,41,59,0.5)" }}>{label}</span>
      <span style={{ fontSize: "0.72rem", color: "#94a3b8", padding: "0.4rem 0.5rem", borderBottom: "1px solid rgba(30,41,59,0.5)", textAlign: "center" }}>{a || "—"}</span>
      <span style={{ fontSize: "0.72rem", color: "#94a3b8", padding: "0.4rem 0.5rem", borderBottom: "1px solid rgba(30,41,59,0.5)", textAlign: "center" }}>{b || "—"}</span>
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
      background: activeTab === id ? "rgba(14,165,233,0.2)" : "transparent",
      color: activeTab === id ? "#38bdf8" : "#475569",
      borderBottom: activeTab === id ? "2px solid #0ea5e9" : "2px solid transparent",
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
      {data.protein_info?.length && <LollipopMap variants={data.variants || []} domains={data.domains || []} proteinLength={data.protein_info.length} geneName={gene} />}
      {data.drugs?.length > 0 && <DrugPanel drugs={data.drugs} />}
      {data.cancer_mutations?.cancer_types?.length > 0 && <CancerMutationsPanel data={data.cancer_mutations} />}
      {(data.clingen?.length > 0) && <ClinGenPanel curations={data.clingen} />}
      {(data.omim?.gene_entry || data.omim?.phenotypes?.length) && <OmimPanel omim={data.omim} />}
      {data.gwas?.length > 0 && <GWASPanel gwas={data.gwas} />}
      {(data.hpo?.phenotype_terms?.length > 0 || data.monarch?.diseases?.length > 0) && <PhenotypePanel hpo={data.hpo} monarch={data.monarch} />}
      {data.publication_timeline?.length > 0 && <PublicationTimeline timeline={data.publication_timeline} />}
    </div>
  );

  return (
    <div style={{ display: "flex", gap: 12, animation: "fadeSlideIn 0.25s ease-out" }}>
      <div style={{ width: 28, height: 28, borderRadius: "50%", background: "linear-gradient(135deg, #0ea5e9, #7c3aed)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, color: "white", flexShrink: 0, marginTop: 2 }}>G</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        {/* Title */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
          <span style={{ fontFamily: "monospace", fontSize: "0.85rem", fontWeight: 700, color: "#38bdf8" }}>{gene_a}</span>
          <span style={{ fontSize: "0.75rem", color: "#334155" }}>vs</span>
          <span style={{ fontFamily: "monospace", fontSize: "0.85rem", fontWeight: 700, color: "#a78bfa" }}>{gene_b}</span>
          <span style={{ fontSize: "0.68rem", color: "#334155" }}>· Gene Comparison</span>
        </div>

        {/* Tabs */}
        <div style={{ display: "flex", gap: 4, marginBottom: 12, borderBottom: "1px solid rgba(30,41,59,0.5)" }}>
          {tabBtn("overview", "Overview")}
          {tabBtn("gene_a", gene_a)}
          {tabBtn("gene_b", gene_b)}
        </div>

        {activeTab === "overview" && (
          <>
            {/* Comparison table */}
            <div style={{ marginBottom: 16, background: "rgba(15,23,42,0.5)", border: "1px solid rgba(51,65,85,0.3)", borderRadius: 10, overflow: "hidden" }}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr" }}>
                <span style={{ fontSize: "0.65rem", color: "#334155", padding: "0.4rem 0.5rem", background: "rgba(30,41,59,0.5)", textTransform: "uppercase", letterSpacing: "0.08em" }}></span>
                <span style={{ fontSize: "0.72rem", fontFamily: "monospace", fontWeight: 700, color: "#38bdf8", padding: "0.4rem 0.5rem", background: "rgba(30,41,59,0.5)", textAlign: "center" }}>{gene_a}</span>
                <span style={{ fontSize: "0.72rem", fontFamily: "monospace", fontWeight: 700, color: "#a78bfa", padding: "0.4rem 0.5rem", background: "rgba(30,41,59,0.5)", textAlign: "center" }}>{gene_b}</span>
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
            <span style={{ fontSize: "0.72rem", color: "#334155" }}>Sources:</span>
            {msg.sources.map(s => {
              const c = SOURCE_COLORS[s] || { color: "#94a3b8", bg: "rgba(30,41,59,0.5)", border: "rgba(51,65,85,0.4)" };
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
  ClinVar: { color: "#fca5a5", bg: "rgba(127,29,29,0.3)", border: "rgba(185,28,28,0.25)" },
  Ensembl: { color: "#86efac", bg: "rgba(5,46,22,0.3)", border: "rgba(21,128,61,0.25)" },
  gnomAD: { color: "#93c5fd", bg: "rgba(23,37,84,0.4)", border: "rgba(29,78,216,0.25)" },
  UniProt: { color: "#fde68a", bg: "rgba(66,32,6,0.3)", border: "rgba(161,98,7,0.25)" },
  NCBI: { color: "#d8b4fe", bg: "rgba(59,7,100,0.3)", border: "rgba(126,34,206,0.25)" },
  PubMed: { color: "#fdba74", bg: "rgba(124,45,18,0.3)", border: "rgba(194,65,12,0.25)" },
  OpenTargets: { color: "#86efac", bg: "rgba(5,46,22,0.3)", border: "rgba(21,128,61,0.25)" },
  OMIM: { color: "#c4b5fd", bg: "rgba(49,46,129,0.3)", border: "rgba(109,40,217,0.25)" },
  PharmGKB: { color: "#7dd3fc", bg: "rgba(8,47,73,0.3)", border: "rgba(3,105,161,0.25)" },
  "COSMIC/GDC": { color: "#fca5a5", bg: "rgba(127,29,29,0.3)", border: "rgba(185,28,28,0.25)" },
  ClinGen: { color: "#86efac", bg: "rgba(5,46,22,0.3)", border: "rgba(21,128,61,0.25)" },
  "GWAS Catalog": { color: "#f87171", bg: "rgba(127,29,29,0.3)", border: "rgba(185,28,28,0.25)" },
  HPO: { color: "#c4b5fd", bg: "rgba(76,29,149,0.3)", border: "rgba(109,40,217,0.25)" },
  Monarch: { color: "#a78bfa", bg: "rgba(76,29,149,0.25)", border: "rgba(109,40,217,0.2)" },
};

function AssistantMessage({ msg, dnaData, settings }) {
  if (msg.query_type === "comparison_query") return <ComparisonView msg={msg} />;
  return (
    <div style={{ display: "flex", gap: 12, animation: "fadeSlideIn 0.25s ease-out" }}>
      <div style={{ width: 28, height: 28, borderRadius: "50%", background: "linear-gradient(135deg, #0ea5e9, #7c3aed)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, color: "white", flexShrink: 0, marginTop: 2 }}>G</div>
      <div style={{ flex: 1, minWidth: 0 }}>
        {msg.target && (
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
            <span style={{ fontFamily: "monospace", fontSize: "0.78rem", fontWeight: 700, color: "#38bdf8" }}>{msg.target}</span>
            <span style={{ color: "#1e293b" }}>·</span>
            <span style={{ fontSize: "0.72rem", color: "#475569", textTransform: "capitalize" }}>{(msg.query_type || "").replace("_", " ")}</span>
            {msg.result_count > 0 && <><span style={{ color: "#1e293b" }}>·</span><span style={{ fontSize: "0.72rem", color: "#475569" }}>{msg.result_count} results</span></>}
            {msg.cached && <span style={{ fontSize: "0.68rem", padding: "0.15em 0.5em", borderRadius: 4, background: "#0f172a", color: "#475569", border: "1px solid #1e293b" }}>cached</span>}
          </div>
        )}
        {msg.data?.gene_info && <GeneInfoBanner geneInfo={msg.data.gene_info} proteinInfo={msg.data.protein_info} pubCount={msg.data.publication_count} />}
        {msg.data?.alphafold?.pdb_url && (
          <ProteinViewer
            pdbUrl={msg.data.alphafold.pdb_url}
            geneName={msg.data.alphafold.gene || msg.target}
            entryId={msg.data.alphafold.entry_id}
          />
        )}
        <Markdown content={msg.content} />
        {msg.data && <DataSection data={msg.data} queryType={msg.query_type} dnaData={dnaData} settings={settings} />}
        {msg.data?.pathways?.length > 0 && <PathwayViewer pathways={msg.data.pathways} />}
        {msg.data?.expression?.length > 0 && <ExpressionChart expression={msg.data.expression} />}
        {msg.data?.interactions?.length > 0 && <InteractionNetwork interactions={msg.data.interactions} centerGene={msg.target} />}
        {msg.data?.protein_info?.length && (
          <LollipopMap
            variants={msg.data.variants || []}
            domains={msg.data.domains || []}
            proteinLength={msg.data.protein_info.length}
            geneName={msg.target}
          />
        )}
        {msg.data?.drugs?.length > 0 && <DrugPanel drugs={msg.data.drugs} />}
        {msg.data?.population_summary?.length > 0 && <PopulationFrequencyChart populations={msg.data.population_summary} />}
        {(omim => omim?.gene_entry || omim?.phenotypes?.length)(msg.data?.omim) && <OmimPanel omim={msg.data.omim} />}
        {(pgkb => pgkb?.related_drugs?.length || pgkb?.clinical_annotations?.length)(msg.data?.pharmgkb) && <PharmGKBPanel pgkb={msg.data.pharmgkb} />}
        {msg.data?.cancer_mutations?.cancer_types?.length > 0 && <CancerMutationsPanel data={msg.data.cancer_mutations} />}
        {msg.data?.clingen?.length > 0 && <ClinGenPanel curations={msg.data.clingen} />}
        {msg.data?.gwas?.length > 0 && <GWASPanel gwas={msg.data.gwas} />}
        {(msg.data?.hpo?.phenotype_terms?.length > 0 || msg.data?.monarch?.diseases?.length > 0) && <PhenotypePanel hpo={msg.data.hpo} monarch={msg.data.monarch} />}
        {msg.data?.publication_timeline?.length > 0 && <PublicationTimeline timeline={msg.data.publication_timeline} />}
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
          <span style={{ fontSize: "0.72rem", color: "#334155" }}>Sources:</span>
          {msg.sources.map(s => {
            const c = SOURCE_COLORS[s] || { color: "#94a3b8", bg: "rgba(30,41,59,0.5)", border: "rgba(51,65,85,0.4)" };
            return <span key={s} style={{ fontSize: "0.7rem", padding: "0.2em 0.6em", borderRadius: 100, background: c.bg, color: c.color, border: `1px solid ${c.border}` }}>{s}</span>;
          })}
        </div>
      )}
      {msg.query_id && (
        <button onClick={share} disabled={sharing} style={{ fontSize: "0.68rem", color: copied ? "#34d399" : "#475569", background: "none", border: "1px solid rgba(51,65,85,0.35)", borderRadius: 6, padding: "0.2rem 0.55rem", cursor: "pointer", flexShrink: 0 }}>
          {copied ? "Link copied!" : sharing ? "Sharing…" : shareUrl ? "Copy link" : "Share"}
        </button>
      )}
    </div>
  );
}

function UserMessage({ content }) {
  return (
    <div style={{ display: "flex", justifyContent: "flex-end", animation: "fadeSlideIn 0.2s ease-out" }}>
      <div style={{ maxWidth: "60%", background: "rgba(14,165,233,0.12)", border: "1px solid rgba(14,165,233,0.2)", borderRadius: "16px 16px 4px 16px", padding: "0.625rem 1rem" }}>
        <p style={{ fontSize: "0.875rem", color: "#e2e8f0", lineHeight: 1.6 }}>{content}</p>
      </div>
    </div>
  );
}

function TypingIndicator() {
  return (
    <div style={{ display: "flex", gap: 12 }}>
      <div style={{ width: 28, height: 28, borderRadius: "50%", background: "linear-gradient(135deg, #0ea5e9, #7c3aed)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, color: "white", flexShrink: 0 }}>G</div>
      <div style={{ background: "rgba(30,41,59,0.5)", border: "1px solid rgba(51,65,85,0.35)", borderRadius: 12, padding: "0.75rem 1rem", display: "flex", alignItems: "center", gap: 6 }}>
        {[0, 1, 2].map(i => (
          <div key={i} style={{ width: 6, height: 6, borderRadius: "50%", background: "#38bdf8", animation: `pulse-dot 1.2s ${i * 0.2}s infinite` }} />
        ))}
        <span style={{ fontSize: "0.75rem", color: "#475569", marginLeft: 4 }}>Querying databases…</span>
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
      <div style={{ padding: "1rem", borderBottom: "1px solid rgba(30,41,59,0.6)", display: "flex", gap: 8 }}>
        <button onClick={onNewChat} style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", gap: 6, padding: "0.5rem 0.75rem", borderRadius: 10, background: "#0284c7", color: "white", fontSize: "0.8rem", fontWeight: 600, border: "none", cursor: "pointer" }}>
          + New Chat
        </button>
        <button onClick={onClose} className="gc-hamburger" style={{ padding: "0.5rem 0.6rem", borderRadius: 10, background: "rgba(30,41,59,0.5)", border: "1px solid rgba(51,65,85,0.4)", color: "#475569", cursor: "pointer", fontSize: "1rem", lineHeight: 1 }}>✕</button>
      </div>
      <div style={{ flex: 1, overflowY: "auto", padding: "0.75rem" }}>
        {!currentUser && chatHistory.length === 0 && (
          <a href={`${API}/auth/google`} style={{ display: "block", margin: "0 0 12px", padding: "8px 10px", background: "rgba(14,165,233,0.08)", border: "1px solid rgba(14,165,233,0.2)", borderRadius: 8, textDecoration: "none", textAlign: "center" }}>
            <p style={{ fontSize: "0.68rem", color: "#38bdf8", margin: 0 }}>Sign in to save history</p>
          </a>
        )}
        {chatHistory.length > 0 && (
          <div style={{ marginBottom: "1.25rem" }}>
            <p style={{ fontSize: "0.65rem", fontWeight: 700, color: "#334155", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 6 }}>History</p>
            {chatHistory.slice(0, 20).map((item, i) => (
              <div key={item.id || i}
                style={{ position: "relative", display: "flex", alignItems: "center", borderRadius: 6, marginBottom: 1 }}
                onMouseEnter={() => setHoveredId(item.id || i)}
                onMouseLeave={() => setHoveredId(null)}
              >
                <button onClick={() => onLoadHistory(item)}
                  style={{ flex: 1, textAlign: "left", fontSize: "0.72rem", color: hoveredId === (item.id || i) ? "#94a3b8" : "#64748b", padding: "0.35rem 0.5rem", paddingRight: hoveredId === (item.id || i) ? "1.4rem" : "0.5rem", borderRadius: 6, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", background: hoveredId === (item.id || i) ? "rgba(30,41,59,0.5)" : "none", border: "none", cursor: "pointer", minWidth: 0 }}
                  title={item.query_text}
                >
                  {item.target ? <span style={{ fontFamily: "monospace", color: "#38bdf8", marginRight: 4 }}>{item.target}</span> : null}
                  {item.query_text?.slice(0, 26)}
                </button>
                {hoveredId === (item.id || i) && item.id && (
                  <button
                    onClick={e => { e.stopPropagation(); onDeleteHistory(item.id); }}
                    style={{ position: "absolute", right: 4, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", color: "#475569", cursor: "pointer", fontSize: "0.75rem", lineHeight: 1, padding: "2px 3px", borderRadius: 3 }}
                    onMouseEnter={e => e.currentTarget.style.color = "#f87171"}
                    onMouseLeave={e => e.currentTarget.style.color = "#475569"}
                    title="Delete this query"
                  >×</button>
                )}
              </div>
            ))}
          </div>
        )}
        <div>
          <p style={{ fontSize: "0.65rem", fontWeight: 700, color: "#334155", textTransform: "uppercase", letterSpacing: "0.1em", marginBottom: 6 }}>Projects</p>
          <form onSubmit={e => { e.preventDefault(); if (newName.trim()) { onCreateProject(newName.trim()); setNewName(""); } }} style={{ display: "flex", gap: 6, marginBottom: 8 }}>
            <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="New project…" style={{ flex: 1, fontSize: "0.72rem", background: "rgba(30,41,59,0.6)", border: "1px solid rgba(51,65,85,0.4)", borderRadius: 6, padding: "0.35rem 0.5rem", color: "#94a3b8", outline: "none" }} />
            <button type="submit" style={{ padding: "0.35rem 0.6rem", background: "rgba(51,65,85,0.6)", border: "1px solid rgba(71,85,105,0.4)", borderRadius: 6, color: "#94a3b8", cursor: "pointer", fontSize: "0.8rem" }}>+</button>
          </form>
          <button onClick={() => onSelectProject(null)} style={{ width: "100%", textAlign: "left", padding: "0.35rem 0.5rem", borderRadius: 6, fontSize: "0.75rem", color: activeProjectId === null ? "#38bdf8" : "#64748b", background: activeProjectId === null ? "rgba(14,165,233,0.1)" : "transparent", border: "none", cursor: "pointer", marginBottom: 2 }}>
            All queries
          </button>
          {projects.map(p => (
            <div key={p.id} style={{ position: "relative", display: "flex", alignItems: "center", borderRadius: 6, marginBottom: 2 }}
              onMouseEnter={() => setHoveredId(`proj-${p.id}`)}
              onMouseLeave={() => setHoveredId(null)}
            >
            <button onClick={() => onSelectProject(p.id)} style={{ flex: 1, textAlign: "left", padding: "0.35rem 0.5rem", paddingRight: hoveredId === `proj-${p.id}` ? "1.4rem" : "0.5rem", borderRadius: 6, fontSize: "0.75rem", color: activeProjectId === p.id ? "#38bdf8" : "#64748b", background: activeProjectId === p.id ? "rgba(14,165,233,0.1)" : "transparent", border: "none", cursor: "pointer", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", display: "block" }}>
              {p.name}
            </button>
            {hoveredId === `proj-${p.id}` && (
              <button onClick={e => { e.stopPropagation(); onDeleteProject(p.id); }}
                style={{ position: "absolute", right: 4, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", color: "#475569", cursor: "pointer", fontSize: "0.75rem", lineHeight: 1, padding: "2px 3px", borderRadius: 3 }}
                onMouseEnter={e => e.currentTarget.style.color = "#f87171"}
                onMouseLeave={e => e.currentTarget.style.color = "#475569"}
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

export default function App() {
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

  useEffect(() => { applyFontSize(settings.fontSize); }, [settings.fontSize]);

  const updateDnaData = useCallback((data) => {
    setDnaData(data);
    saveDnaToSession(data);
  }, []);
  const bottomRef = useRef(null);
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

    checkHealth();
    fetchMe().then(() => { loadProjects(); loadChatHistory(); });
  }, []);
  useEffect(() => { bottomRef.current?.scrollIntoView({ behavior: "smooth" }); }, [messages, loading]);

  const checkHealth = async () => {
    try { const r = await apiFetch("/health"); setApiStatus(r.ok ? "online" : "error"); }
    catch { setApiStatus("offline"); }
  };

  const fetchMe = async () => {
    try {
      const r = await apiFetch("/auth/me");
      if (r.ok) {
        const { user } = await r.json();
        setCurrentUser(user);
      }
    } catch {}
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
    if (!item.content && !item.data) return;
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
  };

  const buildHistory = useCallback(() =>
    messages.map(m => ({ role: m.role, content: m.content })),
    [messages]
  );

  const sendMessage = useCallback(async (text) => {
    const msg = (text || input).trim();
    if (!msg || loading) return;
    setInput("");
    const userMsg = { role: "user", content: msg };
    setMessages(prev => [...prev, userMsg]);
    setLoading(true);

    try {
      const r = await apiFetch("/chat", {
        method: "POST",
        body: JSON.stringify({
          message: msg,
          history: buildHistory(),
          project_id: activeProjectId,
          response_detail: settings.responseDetail,
          // Send up to 200 variants so Claude can answer general DNA questions.
          // Real 23andMe files have 600k rows — we cap here to keep payload small.
          // For large files the variant cards still show matches client-side.
          personal_variants: dnaData
            ? Array.from(dnaData.variants.entries()).slice(0, 200).map(([rsid, v]) => ({ rsid, ...v }))
            : null,
        }),
      });
      const data = await r.json();

      // If DNA is loaded, cross-reference returned variant rsIDs with user's data
      // and attach matched variants so Claude can interpret them in a follow-up
      if (dnaData && data.data?.variants?.length > 0) {
        const matches = data.data.variants
          .map(v => {
            const rsid = v.variant_id?.startsWith("rs") ? v.variant_id : v.rsid;
            if (!rsid) return null;
            const uv = dnaData.variants.get(rsid);
            if (!uv) return null;
            return { rsid, genotype: uv.genotype, chromosome: uv.chromosome };
          })
          .filter(Boolean);
        if (matches.length > 0) {
          data._personalMatches = matches;
        }
      }
      if (!r.ok) {
        setMessages(prev => [...prev, { role: "assistant", content: `**Error:** ${data.detail || "Something went wrong."}` }]);
        return;
      }
      const assistantMsg = { role: "assistant", ...data };
      setMessages(prev => [...prev, assistantMsg]);
      setChatHistory(prev => [{ label: msg.slice(0, 50) }, ...prev.filter(h => h.label !== msg.slice(0, 50)).slice(0, 19)]);
    } catch (err) {
      setMessages(prev => [...prev, { role: "assistant", content: `**Connection error:** ${err.message}\n\nMake sure the backend is running: \`docker-compose up -d\`` }]);
    } finally {
      setLoading(false);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [input, loading, buildHistory, activeProjectId]);

  const exportReport = async () => {
    if (exporting) return;
    setExporting(true);
    try {
    // ── helpers ──────────────────────────────────────────────────────────────
    const esc = s => String(s ?? "").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");

    const inline = t => esc(t)
      .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
      .replace(/\*(.+?)\*/g, "<em>$1</em>")
      .replace(/`(.+?)`/g, `<code style="background:#f1f5f9;padding:1px 5px;border-radius:3px;font-size:12px;font-family:monospace">$1</code>`);

    const mdToHtml = text => {
      if (!text) return "";
      const out = []; let inList = false;
      for (const raw of text.split("\n")) {
        const l = raw.trimEnd();
        if (/^##\s/.test(l)) {
          if (inList) { out.push("</ul>"); inList = false; }
          out.push(`<h2 style="font-size:16px;font-weight:700;color:#1e40af;border-bottom:1px solid #dbeafe;padding-bottom:6px;margin:22px 0 10px">${inline(l.slice(3))}</h2>`);
        } else if (/^###\s/.test(l)) {
          if (inList) { out.push("</ul>"); inList = false; }
          out.push(`<h3 style="font-size:14px;font-weight:600;color:#1e3a8a;margin:16px 0 7px">${inline(l.slice(4))}</h3>`);
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

    const sectionHeader = (title, color = "#1e40af") =>
      `<div style="display:flex;align-items:center;gap:10px;margin:28px 0 12px"><div style="flex:1;height:1px;background:#e5e7eb"></div><span style="font-size:11px;font-weight:700;color:${color};text-transform:uppercase;letter-spacing:.08em;white-space:nowrap">${esc(title)}</span><div style="flex:1;height:1px;background:#e5e7eb"></div></div>`;

    const table = (headers, rows, colWidths) => {
      const wStyle = (i) => colWidths?.[i] ? `width:${colWidths[i]}` : "";
      return `<table style="width:100%;border-collapse:collapse;font-size:12px;margin:8px 0">
        <thead><tr>${headers.map((h,i) => `<th style="text-align:left;padding:6px 8px;background:#f0f4ff;color:#1e40af;font-weight:600;border-bottom:2px solid #dbeafe;${wStyle(i)}">${esc(h)}</th>`).join("")}</tr></thead>
        <tbody>${rows.map((r,ri) => `<tr style="background:${ri%2===0?"#fafafa":"#ffffff"}">${r.map((c,ci) => `<td style="padding:5px 8px;border-bottom:1px solid #f3f4f6;color:#374151;vertical-align:top;${wStyle(ci)}">${c}</td>`).join("")}</tr>`).join("")}</tbody>
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
    const proteinImgs = {};
    for (const { reply } of pairs) {
      if (!reply?.target) continue;
      const gene = reply.target.split(" vs ")[0];
      const viewer = viewerRegistry.get(gene);
      if (viewer) {
        try {
          viewer.spin(false);
          viewer.render();
          await new Promise(r => setTimeout(r, 120));
          proteinImgs[gene] = viewer.pngURI();
        } catch {}
      }
    }

    // ── build HTML report ─────────────────────────────────────────────────────
    let body = "";

    for (const { query, reply } of pairs) {
      const d = reply?.data || {};
      const gene = reply?.target || "";

      // Query block
      body += `<div style="background:#eff6ff;border-left:4px solid #3b82f6;border-radius:4px;padding:14px 16px;margin-bottom:18px">
        <p style="font-size:10px;font-weight:700;color:#6b7280;letter-spacing:.08em;margin-bottom:4px">RESEARCH QUERY</p>
        <p style="font-size:15px;font-weight:600;color:#1e3a8a;line-height:1.5">${esc(query)}</p>
        ${gene ? `<p style="font-size:12px;color:#3b82f6;margin-top:4px">${esc(gene)}${reply?.query_type ? " · " + reply.query_type.replace(/_/g," ") : ""}${reply?.result_count ? " · " + reply.result_count + " results" : ""}</p>` : ""}
      </div>`;

      // Protein structure
      const proteinPng = proteinImgs[gene];
      if (proteinPng) {
        body += `${sectionHeader("Protein Structure (AlphaFold)", "#7c3aed")}
          <div style="text-align:center;background:#0a0f1e;border-radius:10px;padding:8px;margin-bottom:8px">
            <img src="${proteinPng}" style="max-width:100%;border-radius:8px;display:block;margin:0 auto" />
          </div>
          <p style="font-size:11px;color:#9ca3af;text-align:center;margin-bottom:16px">AlphaFold predicted structure · ${esc(d.alphafold?.entry_id || gene)} · Colored by pLDDT confidence</p>`;
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
            `<div style="background:#e0e7ff;border-radius:3px;height:8px;width:120px"><div style="background:#3b82f6;border-radius:3px;height:8px;width:${barPct}%"></div></div>`,
          ];
        });
        body += `${sectionHeader("Population Allele Frequencies (gnomAD v4)")}
          <p style="font-size:12px;color:#6b7280;margin-bottom:8px">Aggregate allele frequency across all variants in this gene, by ancestry group.</p>
          ${table(["Population", "Allele Freq.", "AC / AN", "Relative"], popRows, ["30%","18%","28%","24%"])}`;
      }

      // HPO phenotypes
      const hpoTerms = d.hpo?.phenotype_terms || [];
      const monarchDiseases = d.monarch?.diseases || [];
      if (hpoTerms.length || monarchDiseases.length) {
        body += sectionHeader("Associated Phenotypes & Diseases (HPO · Monarch)");
        if (hpoTerms.length) {
          body += `<div style="display:flex;flex-wrap:wrap;gap:6px;margin:8px 0 12px">
            ${hpoTerms.slice(0,20).map(t => badge(t.name, "#f5f3ff", "#5b21b6")).join("")}
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
          `<strong style="color:${/likely/i.test(v.clinical_significance||"")?"#d97706":"#dc2626"}">${esc(v.clinical_significance)}</strong>`,
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
          `<span style="font-family:monospace;color:${g.p_value < 5e-8 ? "#dc2626" : g.p_value < 1e-5 ? "#d97706" : "#374151"}">${esc(g.p_value_str)}</span>`,
          g.or_beta != null ? g.or_beta.toFixed(3) : "—",
          g.risk_allele ? `<span style="font-family:monospace">${esc(g.risk_allele)}</span>` : "—",
        ]);
        body += `${sectionHeader("GWAS Trait Associations (EBI GWAS Catalog)")}
          <p style="font-size:12px;color:#6b7280;margin-bottom:8px">p &lt; 5×10⁻⁸ = genome-wide significant</p>
          ${table(["Trait","p-value","OR / β","Risk Allele"], gRows, ["45%","20%","17%","18%"])}`;
      }

      // Drug interactions
      if (d.drugs?.length) {
        const dRows = d.drugs.slice(0, 10).map(dr => [
          `<strong>${esc(dr.name)}</strong>`,
          dr.phase != null ? badge(`Phase ${dr.phase}`, dr.phase >= 4 ? "#dcfce7" : dr.phase >= 3 ? "#dbeafe" : "#f5f3ff", dr.phase >= 4 ? "#15803d" : dr.phase >= 3 ? "#1d4ed8" : "#6d28d9") : "—",
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
        body += `<p style="font-size:11px;color:#9ca3af;margin-top:20px"><strong style="color:#6b7280">Data sources:</strong> ${reply.sources.map(esc).join(" · ")}</p>`;
      }

      body += `<div style="height:32px;border-bottom:1px solid #e5e7eb;margin-bottom:32px"></div>`;
    }

    const reportHtml = `
      <div id="gc-pdf-report" style="width:794px;background:#ffffff;padding:48px 52px;font-family:'Georgia',serif;color:#1a1a1a;box-sizing:border-box">
        <!-- Header -->
        <div style="display:flex;align-items:center;justify-content:space-between;border-bottom:2px solid #1e40af;padding-bottom:20px;margin-bottom:28px">
          <div style="display:flex;align-items:center;gap:12px">
            <div style="width:38px;height:38px;background:linear-gradient(135deg,#1d4ed8,#7c3aed);border-radius:9px;display:flex;align-items:center;justify-content:center;font-size:20px">🧬</div>
            <div>
              <p style="font-size:20px;font-weight:700;color:#1e40af;margin:0">GenomeChat</p>
              <p style="font-size:11px;color:#9ca3af;margin:0">Genomics Research Report</p>
            </div>
          </div>
          <p style="font-size:12px;color:#9ca3af;text-align:right">Generated ${date}<br><span style="font-size:10px">Powered by Claude AI</span></p>
        </div>
        ${body}
        <!-- Footer -->
        <div style="margin-top:32px;border-top:1px solid #e5e7eb;padding-top:16px">
          <p style="font-size:11px;color:#d1d5db;text-align:center">GenomeChat · Data from Ensembl, ClinVar, gnomAD, UniProt, Open Targets, GWAS Catalog, HPO, Monarch, PharmGKB, OMIM, ClinGen, COSMIC/GDC · Powered by Claude AI</p>
          <p style="font-size:10px;color:#e5e7eb;text-align:center;margin-top:4px">For research purposes only. Not a substitute for clinical genetic counseling.</p>
        </div>
      </div>`;

    // ── render hidden div → html2canvas → jsPDF ───────────────────────────────
    const wrapper = document.createElement("div");
    wrapper.style.cssText = "position:fixed;left:-9999px;top:0;z-index:-1";
    wrapper.innerHTML = reportHtml;
    document.body.appendChild(wrapper);

    try {
      const el = wrapper.querySelector("#gc-pdf-report");
      const canvas = await html2canvas(el, {
        scale: 2,
        useCORS: true,
        allowTaint: false,
        backgroundColor: "#ffffff",
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
      pdf.save(`GenomeChat_${slug}_${Date.now()}.pdf`);
    } finally {
      document.body.removeChild(wrapper);
    }
    } finally {
      setExporting(false);
    }
  };

  const statusColor = { online: "#34d399", offline: "#f87171", checking: "#fbbf24", error: "#f87171" }[apiStatus];

  return (
    <>
      <style>{`
        @keyframes fadeSlideIn { from { opacity: 0; transform: translateY(6px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes pulse-dot { 0%,80%,100% { opacity:.2; transform:scale(.8); } 40% { opacity:1; transform:scale(1); } }
        .gc-sidebar {
          width: 220px; flex-shrink: 0; display: flex; flex-direction: column;
          border-right: 1px solid rgba(30,41,59,0.8); background: rgba(15,23,42,0.97);
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
        .gc-empty-hero { width: 56px; height: 56px; border-radius: 16px; font-size: 26px; margin-bottom: 20px; }
        .gc-empty-title { font-size: 1.25rem; margin: 0 0 8px; }
        .gc-empty-subtitle { font-size: 0.875rem; margin-bottom: 28px; }
        .gc-suggestion-item { display: flex; }
        .gc-dna-upload-section { margin-top: 20px; max-width: 560px; width: 100%; }
        /* Mobile header: two-row layout */
        .gc-header { display: flex; align-items: center; justify-content: space-between; padding: 0.75rem 1.25rem; border-bottom: 1px solid rgba(30,41,59,0.6); background: rgba(15,23,42,0.4); flex-shrink: 0; }
        .gc-header-row2 { display: none; }
        @media (max-width: 640px) {
          .gc-sidebar {
            position: fixed; top: 0; left: 0; bottom: 0; z-index: 200;
            transform: translateX(-100%); width: 260px;
          }
          .gc-sidebar.open { transform: translateX(0); }
          .gc-sidebar-overlay {
            display: block; position: fixed; inset: 0; z-index: 199;
            background: rgba(0,0,0,0.6);
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
          .gc-empty-hero { width: 36px !important; height: 36px !important; font-size: 18px !important; margin-bottom: 10px !important; border-radius: 10px !important; }
          .gc-empty-title { font-size: 1rem !important; margin: 0 0 4px !important; }
          .gc-empty-subtitle { font-size: 0.78rem !important; margin-bottom: 16px !important; }
          /* Hide suggestions beyond the 3rd on mobile */
          .gc-suggestion-item:nth-child(n+4) { display: none !important; }
          .gc-dna-upload-section { margin-top: 12px !important; }
          /* Two-row mobile header */
          .gc-header { flex-direction: column; align-items: stretch; padding: 0; gap: 0; }
          .gc-header-row1 { padding: 0.55rem 0.875rem !important; border-bottom: 1px solid rgba(30,41,59,0.5); }
          .gc-header-row2 { display: flex !important; align-items: center; padding: 0.4rem 0.875rem; gap: 8px; }
          .gc-header-actions-desktop { display: none !important; }
          .gc-header-actions-mobile { display: flex !important; }
        }
      `}</style>
      <div style={{ display: "flex", height: "100vh", background: "#080b14", color: "#e2e8f0", overflow: "hidden", fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif" }}>
        {showSettings && <SettingsPanel settings={settings} onChange={setSettings} onClose={() => setShowSettings(false)} />}
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
            onAccept={(result, filename) => { updateDnaData({ ...result, filename }); setShowConsentModal(false); }}
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
                  style={{ padding: "0.3rem 0.4rem", borderRadius: 8, background: "none", border: "1px solid rgba(51,65,85,0.4)", color: "#475569", cursor: "pointer", fontSize: "1.1rem", lineHeight: 1, alignItems: "center", justifyContent: "center" }}>
                  ☰
                </button>
                <div style={{ width: 28, height: 28, borderRadius: "50%", background: "linear-gradient(135deg, #0ea5e9, #7c3aed)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, color: "white" }}>G</div>
                <div>
                  <p style={{ fontSize: "0.875rem", fontWeight: 600, color: "#f1f5f9", margin: 0 }}>GenomeChat</p>
                  <p className="gc-header-subtitle" style={{ fontSize: "0.7rem", color: "#334155", margin: 0 }}>Genomics research · Powered by Claude AI</p>
                </div>
              </div>
              {/* Desktop-only actions */}
              <div className="gc-header-actions-desktop" style={{ display: "flex", alignItems: "center", gap: 12 }}>
                {messages.length > 0 && (
                  <button className="gc-export-btn" onClick={exportReport} disabled={exporting} style={{ fontSize: "0.72rem", color: exporting ? "#334155" : "#64748b", background: "none", border: "1px solid rgba(51,65,85,0.4)", borderRadius: 8, padding: "0.35rem 0.65rem", cursor: exporting ? "wait" : "pointer", transition: "color 0.15s" }}>
                    {exporting ? "Building PDF…" : "Export PDF"}
                  </button>
                )}
                <button
                  onClick={() => dnaData ? updateDnaData(null) : setShowConsentModal(true)}
                  style={{ fontSize: "0.72rem", color: dnaData ? "#38bdf8" : "#64748b", background: dnaData ? "rgba(14,165,233,0.08)" : "none", border: `1px solid ${dnaData ? "rgba(14,165,233,0.3)" : "rgba(51,65,85,0.4)"}`, borderRadius: 8, padding: "0.35rem 0.65rem", cursor: "pointer", transition: "all 0.15s" }}
                  title={dnaData ? "Clear DNA session data" : "Upload your DNA data"}
                >
                  {dnaData ? "🧬 DNA loaded" : "Upload DNA"}
                </button>
                <button onClick={() => setShowSettings(true)}
                  style={{ fontSize: "1.1rem", background: "none", border: "none", padding: "0.1rem 0.2rem", cursor: "pointer", color: "#94a3b8", lineHeight: 1 }}
                  title="Settings">⚙️</button>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <div style={{ width: 6, height: 6, borderRadius: "50%", background: statusColor }} />
                  <span style={{ fontSize: "0.72rem", color: "#334155", textTransform: "capitalize" }}>{apiStatus}</span>
                </div>
                {currentUser ? (
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <div style={{ width: 26, height: 26, borderRadius: "50%", background: "linear-gradient(135deg,#0ea5e9,#7c3aed)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, color: "white" }}>
                      {currentUser.name?.[0]?.toUpperCase() || "?"}
                    </div>
                    <button onClick={() => { clearToken(); setCurrentUser(null); setChatHistory([]); }}
                      style={{ fontSize: "0.68rem", color: "#475569", background: "none", border: "none", cursor: "pointer", padding: 0 }}
                      onMouseEnter={e => e.currentTarget.style.color = "#f87171"}
                      onMouseLeave={e => e.currentTarget.style.color = "#475569"}
                    >Sign out</button>
                  </div>
                ) : (
                  <a href={`${API}/auth/google`}
                    style={{ display: "flex", alignItems: "center", gap: 6, fontSize: "0.72rem", color: "#94a3b8", background: "rgba(30,41,59,0.6)", border: "1px solid rgba(51,65,85,0.4)", borderRadius: 8, padding: "0.3rem 0.65rem", textDecoration: "none" }}
                    onMouseEnter={e => e.currentTarget.style.borderColor = "rgba(14,165,233,0.4)"}
                    onMouseLeave={e => e.currentTarget.style.borderColor = "rgba(51,65,85,0.4)"}
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>
                    Sign in with Google
                  </a>
                )}
              </div>
              {/* Mobile-only: user avatar on right of title row */}
              <div className="gc-header-actions-mobile" style={{ display: "none", alignItems: "center", gap: 8 }}>
                <div style={{ width: 6, height: 6, borderRadius: "50%", background: statusColor }} />
                {currentUser ? (
                  <div style={{ width: 26, height: 26, borderRadius: "50%", background: "linear-gradient(135deg,#0ea5e9,#7c3aed)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 700, color: "white" }}>
                    {currentUser.name?.[0]?.toUpperCase() || "?"}
                  </div>
                ) : (
                  <a href={`${API}/auth/google`} style={{ fontSize: "0.68rem", color: "#38bdf8", textDecoration: "none" }}>Sign in</a>
                )}
              </div>
            </div>

            {/* Row 2 — mobile only: DNA + sign out spread across full width */}
            <div className="gc-header-row2" style={{ width: "100%", boxSizing: "border-box" }}>
              <button
                onClick={() => dnaData ? updateDnaData(null) : setShowConsentModal(true)}
                style={{ fontSize: "0.72rem", color: dnaData ? "#38bdf8" : "#64748b", background: dnaData ? "rgba(14,165,233,0.08)" : "none", border: `1px solid ${dnaData ? "rgba(14,165,233,0.3)" : "rgba(51,65,85,0.4)"}`, borderRadius: 8, padding: "0.35rem 0.75rem", cursor: "pointer" }}
              >
                {dnaData ? "🧬 DNA loaded" : "Upload DNA"}
              </button>
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginLeft: "auto" }}>
                {messages.length > 0 && (
                  <button onClick={exportReport} disabled={exporting} style={{ fontSize: "0.68rem", color: "#475569", background: "none", border: "1px solid rgba(51,65,85,0.4)", borderRadius: 8, padding: "0.3rem 0.6rem", cursor: "pointer" }}>
                    {exporting ? "Building…" : "Export PDF"}
                  </button>
                )}
                <button onClick={() => setShowSettings(true)}
                  style={{ fontSize: "1.1rem", background: "none", border: "none", padding: "0.1rem 0.2rem", cursor: "pointer", color: "#94a3b8", lineHeight: 1 }}>⚙️</button>
                {currentUser && (
                  <button onClick={() => { clearToken(); setCurrentUser(null); setChatHistory([]); }}
                    style={{ fontSize: "0.68rem", color: "#475569", background: "none", border: "none", cursor: "pointer", padding: 0 }}
                  >Sign out</button>
                )}
              </div>
            </div>
          </header>

          <DNASessionBanner dnaData={dnaData} onClear={() => updateDnaData(null)} />

          {/* Messages */}
          <div className={messages.length > 0 ? "gc-msg-pad" : ""} style={{ flex: 1, overflowY: "auto" }}>
            {messages.length === 0 ? (
              <div className="gc-empty-pad gc-empty-inner" style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%" }}>
                <div className="gc-empty-hero" style={{ background: "linear-gradient(135deg, #0ea5e9, #7c3aed)", display: "flex", alignItems: "center", justifyContent: "center", boxShadow: "0 8px 32px rgba(14,165,233,0.2)" }}>🧬</div>
                <h2 className="gc-empty-title" style={{ fontWeight: 700, color: "#f1f5f9", textAlign: "center" }}>
                  {dnaData ? "Your DNA — where would you like to start?" : "What would you like to research?"}
                </h2>
                <p className="gc-empty-subtitle" style={{ color: "#475569", textAlign: "center", maxWidth: 420, lineHeight: 1.6 }}>
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
                            <span style={{ fontSize: "1rem", flexShrink: 0 }}>{s.icon}</span>
                            <div>
                              <p style={{ fontSize: "0.78rem", fontWeight: 600, color: s.color, margin: 0, lineHeight: 1.4 }}>{s.label}</p>
                              <p style={{ fontSize: "0.68rem", color: "#475569", marginTop: 2 }}>{s.sublabel}</p>
                            </div>
                          </button>
                        ))}
                      </div>
                    );
                  }
                  return (
                    <div className="gc-suggestions">
                      {SUGGESTIONS.map(s => (
                        <button key={s.label} className="gc-suggestion-item" onClick={() => sendMessage(s.label)} style={{ alignItems: "flex-start", gap: 10, padding: "0.75rem", borderRadius: 12, background: "rgba(30,41,59,0.4)", border: "1px solid rgba(51,65,85,0.35)", cursor: "pointer", textAlign: "left", transition: "border-color 0.15s" }}
                          onMouseEnter={e => e.currentTarget.style.borderColor = "rgba(14,165,233,0.35)"}
                          onMouseLeave={e => e.currentTarget.style.borderColor = "rgba(51,65,85,0.35)"}>
                          <span style={{ fontSize: "1rem", flexShrink: 0 }}>{s.icon}</span>
                          <span style={{ fontSize: "0.78rem", color: "#64748b", lineHeight: 1.5 }}>{s.label}</span>
                        </button>
                      ))}
                    </div>
                  );
                })()}
                <div className="gc-dna-upload-section">
                  {dnaData ? (
                    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "0.65rem 1rem", borderRadius: 12, background: "rgba(8,47,73,0.3)", border: "1px solid rgba(14,165,233,0.2)" }}>
                      <span style={{ fontSize: "1rem" }}>🧬</span>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <p style={{ fontSize: "0.75rem", fontWeight: 600, color: "#38bdf8", margin: 0 }}>{dnaData.totalCount.toLocaleString()} variants loaded</p>
                        <p style={{ fontSize: "0.68rem", color: "#475569", marginTop: 2 }}>{dnaData.filename} · {dnaData.format} · session only</p>
                      </div>
                      <button onClick={() => updateDnaData(null)} style={{ background: "none", border: "none", color: "#334155", cursor: "pointer", fontSize: "0.8rem" }}>Clear</button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setShowConsentModal(true)}
                      style={{ width: "100%", display: "flex", alignItems: "center", gap: 10, padding: "0.65rem 1rem", borderRadius: 12, background: "rgba(30,41,59,0.25)", border: "1px dashed rgba(51,65,85,0.5)", cursor: "pointer", textAlign: "left", transition: "border-color 0.15s" }}
                      onMouseEnter={e => e.currentTarget.style.borderColor = "rgba(14,165,233,0.35)"}
                      onMouseLeave={e => e.currentTarget.style.borderColor = "rgba(51,65,85,0.5)"}
                    >
                      <span style={{ fontSize: "1rem" }}>🧬</span>
                      <div style={{ flex: 1 }}>
                        <p style={{ fontSize: "0.75rem", fontWeight: 600, color: "#475569", margin: 0 }}>Upload your DNA data</p>
                        <p style={{ fontSize: "0.68rem", color: "#334155", marginTop: 2 }}>23andMe · AncestryDNA · VCF · Processed locally, never stored</p>
                      </div>
                      <a
                        href="/sample_23andme.txt"
                        download="sample_23andme.txt"
                        onClick={e => e.stopPropagation()}
                        style={{ fontSize: "0.65rem", color: "#334155", border: "1px solid rgba(51,65,85,0.4)", borderRadius: 6, padding: "0.2rem 0.5rem", whiteSpace: "nowrap", textDecoration: "none", flexShrink: 0 }}
                      >↓ sample</a>
                    </button>
                  )}
                </div>
                <DNASummaryDashboard dnaData={dnaData} onQuery={sendMessage} />
              </div>
            ) : (
              <div style={{ maxWidth: 820, margin: "0 auto", display: "flex", flexDirection: "column", gap: "1.5rem" }}>
                {messages.map((msg, i) =>
                  msg.role === "user"
                    ? <UserMessage key={i} content={msg.content} />
                    : <AssistantMessage key={i} msg={msg} dnaData={dnaData} settings={settings} />
                )}
                {loading && <TypingIndicator />}
                <div ref={bottomRef} />
              </div>
            )}
          </div>

          {/* Input */}
          <div className="gc-input-pad" style={{ flexShrink: 0, borderTop: "1px solid rgba(30,41,59,0.5)", background: "rgba(15,23,42,0.3)" }}>
            <div style={{ maxWidth: 820, margin: "0 auto" }}>
              <div style={{ display: "flex", gap: 10, alignItems: "flex-end", background: "rgba(30,41,59,0.55)", border: "1px solid rgba(51,65,85,0.5)", borderRadius: 16, padding: "0.75rem 0.875rem" }}>
                <textarea
                  ref={inputRef}
                  value={input}
                  onChange={e => setInput(e.target.value)}
                  onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); sendMessage(); } }}
                  placeholder="Ask about a gene (BRCA1 variants) or disease (Alzheimer's genes)…"
                  rows={1}
                  style={{ flex: 1, resize: "none", background: "transparent", color: "#e2e8f0", fontSize: "0.875rem", border: "none", outline: "none", lineHeight: 1.6, minHeight: 24, maxHeight: 160, overflowY: "auto", fontFamily: "inherit" }}
                  onInput={e => { e.target.style.height = "auto"; e.target.style.height = Math.min(e.target.scrollHeight, 160) + "px"; }}
                />
                <button
                  onClick={() => sendMessage()}
                  disabled={loading || !input.trim()}
                  style={{ width: 32, height: 32, borderRadius: 10, background: loading || !input.trim() ? "rgba(51,65,85,0.4)" : "#0284c7", border: "none", cursor: loading || !input.trim() ? "not-allowed" : "pointer", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, transition: "background 0.15s" }}
                >
                  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" fill="white" width={14} height={14}>
                    <path d="M3.105 2.289a.75.75 0 00-.826.95l1.414 4.925A1.5 1.5 0 005.135 9.25h6.115a.75.75 0 010 1.5H5.135a1.5 1.5 0 00-1.442 1.086l-1.414 4.926a.75.75 0 00.826.95 28.896 28.896 0 0015.293-7.154.75.75 0 000-1.115A28.897 28.897 0 003.105 2.289z" />
                  </svg>
                </button>
              </div>
              <p style={{ textAlign: "center", fontSize: "0.68rem", color: "#1e293b", marginTop: 8 }}>
                Ensembl · ClinVar · gnomAD · UniProt · PubMed · Claude AI
              </p>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
