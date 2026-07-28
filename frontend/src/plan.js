/**
 * How a user's plan is described, everywhere it is described.
 *
 * Extracted because the header badge, the Settings panel and the purchase modal
 * all render from this — if they disagreed, one of them would be quietly lying
 * about what someone had paid for.
 */

/** Single source of truth for how a user's plan is described across the UI. */
function getPlan(user) {
  if (!user) return { kind: "anon", label: "Not signed in", short: "Sign in", color: "var(--text-dim)" };
  if (user.unlimited_access) return { kind: "unlocked", label: "Unlimited access (allowlisted)", short: "Unlimited", color: "var(--success)" };
  if (user.byok_unlocked) return { kind: "unlocked", label: "Unlimited access", short: "Unlimited", color: "var(--success)" };
  if (user.has_stored_key) return { kind: "byok", label: "Using your own API key", short: "Own key", color: "var(--success)" };
  const credits = user.query_credits || 0;
  if (credits > 0) return { kind: "credits", label: `${credits} purchased credits remaining`, short: `${credits} credits`, color: "var(--accent)", credits };
  const used = user.total_queries || 0;
  const limit = user.free_limit || 20;
  const left = Math.max(0, limit - used);
  return {
    kind: "free",
    label: `${used} of ${limit} free queries used`,
    short: `${left} left`,
    color: left === 0 ? "var(--danger)" : left <= 3 ? "var(--warning)" : "var(--text-dim)",
    used, limit, left,
  };
}

export { getPlan };
