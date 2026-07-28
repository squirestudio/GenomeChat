import { describe, it, expect } from "vitest";
import { getPlan } from "./plan";

/**
 * The badge, Settings and the purchase modal all render from this. If it were
 * wrong, the app would be misdescribing what someone had paid for.
 */
describe("getPlan", () => {
  it("describes a signed-out visitor", () => {
    expect(getPlan(null).kind).toBe("anon");
  });

  it("puts allowlisted unlimited access above everything else", () => {
    const plan = getPlan({ unlimited_access: true, query_credits: 5, total_queries: 999 });
    expect(plan.kind).toBe("unlocked");
    expect(plan.label).toMatch(/allowlisted/i);
  });

  it("reports an active subscription as unlimited", () => {
    expect(getPlan({ byok_unlocked: true }).short).toBe("Unlimited");
  });

  it("reports a stored key as the reader's own", () => {
    expect(getPlan({ has_stored_key: true }).short).toBe("Own key");
  });

  it("shows purchased credits when there are some", () => {
    const plan = getPlan({ query_credits: 42 });
    expect(plan.kind).toBe("credits");
    expect(plan.short).toBe("42 credits");
  });

  it("counts down the free allowance", () => {
    const plan = getPlan({ total_queries: 3, free_limit: 20 });
    expect(plan.kind).toBe("free");
    expect(plan.short).toBe("17 left");
    expect(plan.left).toBe(17);
  });

  it("never reports a negative allowance", () => {
    expect(getPlan({ total_queries: 25, free_limit: 20 }).left).toBe(0);
  });

  it("warns by colour as the allowance runs down", () => {
    const plenty = getPlan({ total_queries: 0, free_limit: 20 });
    const nearly = getPlan({ total_queries: 18, free_limit: 20 });
    const spent = getPlan({ total_queries: 20, free_limit: 20 });
    expect(plenty.color).not.toBe(nearly.color);
    expect(nearly.color).not.toBe(spent.color);
  });

  it("prefers a subscription over leftover credits", () => {
    expect(getPlan({ byok_unlocked: true, query_credits: 10 }).kind).toBe("unlocked");
  });

  it("falls back to a sensible free limit when the server omits one", () => {
    expect(getPlan({ total_queries: 5 }).short).toBe("15 left");
  });
});
