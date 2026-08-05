/**
 * The Privacy Policy and Terms of Use, at /privacy and /terms.
 *
 * **The markdown in `legal/` is the source of truth and is rendered directly.**
 * These documents were written from an audit of what the code actually does,
 * and `legal/README.md` is the decision log behind them — so a hand-converted
 * JSX copy would be a second original, free to drift from the one that gets
 * reviewed. Importing the same files the documents live in makes drift
 * impossible rather than merely discouraged.
 *
 * **There is no draft banner and there should not be one.** These documents are
 * reviewed and approved, so a component whose job is to announce that they are
 * unfinished has nothing true left to say. The blank-detection guard moved
 * entirely into CI — `legal.test.js` fails if an unfilled `[PLACEHOLDER]` ever
 * appears in a published document, which catches it before a reader can rather
 * than explaining it to them afterwards.
 *
 * That means editing the policy is editing `legal/privacy-policy.md`, and the
 * page follows. It also means `vite.config.js` has to allow reading one level
 * above `frontend/` — see the `fs.allow` note there.
 */
import { Markdown } from "./markdown.jsx";
import privacyMd from "../../legal/privacy-policy.md?raw";
import termsMd from "../../legal/terms-of-use.md?raw";

function LegalPage({ markdown, onBack }) {
  return (
    <div style={{ minHeight: "100vh", background: "var(--bg)", overflowY: "auto" }}>
      <div style={{ maxWidth: 680, margin: "0 auto", padding: "2.5rem 1.5rem 4rem" }}>

        <button onClick={onBack}
          style={{
            background: "none", border: "none", padding: 0, cursor: "pointer",
            fontSize: "0.78rem", color: "var(--accent)", marginBottom: "2rem",
          }}>← Back to MyDNA</button>

        <img src="/logo-stacked.png" alt="MyDNA" width="140"
          style={{ display: "block", height: "auto", marginBottom: "1.5rem" }} />

        <div className="gc-legal">
          <Markdown content={markdown} />
        </div>

        <p style={{
          fontSize: "0.72rem", color: "var(--text-faintest)", lineHeight: 1.6,
          marginTop: "2.5rem", paddingTop: "1.25rem",
          borderTop: "1px solid var(--border-solid)",
        }}>
          MyDNA is published by Squire Studio. It is an educational research
          tool, not a medical service, and it does not diagnose.
        </p>
      </div>
    </div>
  );
}

export function PrivacyPage({ onBack }) {
  return <LegalPage markdown={privacyMd} onBack={onBack} />;
}

export function TermsPage({ onBack }) {
  return <LegalPage markdown={termsMd} onBack={onBack} />;
}
