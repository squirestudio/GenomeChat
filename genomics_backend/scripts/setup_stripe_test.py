#!/usr/bin/env python3
"""Create the test-mode products and prices that mirror live, and print .env lines.

Stripe keeps test and live in completely separate namespaces: a live price id is
unusable with a test key and vice versa, so switching local development to test
mode means recreating both products. This does that idempotently — re-running
reuses whatever already exists rather than piling up duplicates.

Usage:
    STRIPE_TEST_KEY=sk_test_... python scripts/setup_stripe_test.py

Get the key from Stripe → toggle to Test mode → Developers → API keys.
"""
import os
import sys

# Mirrors the live catalogue. Amounts in cents.
# Mirrors the live catalogue exactly, including the billing model — test mode
# is worthless as a rehearsal if the unlock is one-time here and a subscription
# in production.
PRODUCTS = [
    {"env": "STRIPE_PRICE_UNLOCK", "name": "MyDNA - Unlimited (Monthly)", "amount": 1000, "interval": "month"},
    {"env": "STRIPE_PRICE_CREDITS", "name": "MyDNA - 50 Queries", "amount": 300, "interval": None},
]
CURRENCY = "usd"


def main() -> int:
    key = os.environ.get("STRIPE_TEST_KEY", "").strip()
    if not key:
        print("ERROR: set STRIPE_TEST_KEY (Stripe → Test mode → Developers → API keys)")
        return 1
    # The whole point is to stop touching live data from a dev machine, so make
    # it impossible to run this against live by accident.
    if not key.startswith("sk_test_"):
        print(f"ERROR: refusing to run — key starts {key[:8]!r}, expected 'sk_test_'.")
        return 1

    # Imported after validation so a bad/missing key reports clearly even
    # where the SDK isn't installed.
    import stripe

    stripe.api_key = key
    account = stripe.Account.retrieve()
    print(f"Test mode on account: {account.get('id')}\n")

    lines = []
    for spec in PRODUCTS:
        # Reuse an existing product with the same name if one is there.
        product = next(
            (p for p in stripe.Product.list(limit=100, active=True).get("data", [])
             if p.get("name") == spec["name"]),
            None,
        )
        if product:
            print(f"· product exists: {spec['name']} ({product['id']})")
        else:
            product = stripe.Product.create(name=spec["name"])
            print(f"+ created product: {spec['name']} ({product['id']})")

        wants_recurring = bool(spec.get("interval"))
        price = next(
            (p for p in stripe.Price.list(product=product["id"], limit=100, active=True).get("data", [])
             if p.get("unit_amount") == spec["amount"] and p.get("currency") == CURRENCY
             and bool(p.get("recurring")) == wants_recurring),
            None,
        )
        if price:
            suffix = f"/{spec['interval']}" if spec.get("interval") else " one-time"
            print(f"  · price exists: {price['id']} (${spec['amount'] / 100:.2f}{suffix})")
        else:
            create_args = dict(product=product["id"], unit_amount=spec["amount"], currency=CURRENCY)
            if spec.get("interval"):
                create_args["recurring"] = {"interval": spec["interval"]}
            price = stripe.Price.create(**create_args)
            suffix = f"/{spec['interval']}" if spec.get("interval") else " one-time"
            print(f"  + created price: {price['id']} (${spec['amount'] / 100:.2f}{suffix})")

        lines.append(f"{spec['env']}={price['id']}")

    print("\n" + "=" * 62)
    print("Put these in genomics_backend/.env:\n")
    print(f"STRIPE_SECRET_KEY={key}")
    for line in lines:
        print(line)
    print("\nFor STRIPE_WEBHOOK_SECRET, run the Stripe CLI listener:")
    print("    stripe listen --forward-to localhost:8000/billing/webhook")
    print("and copy the whsec_... it prints. Keep it running while you test.")
    print("=" * 62)
    return 0


if __name__ == "__main__":
    sys.exit(main())
