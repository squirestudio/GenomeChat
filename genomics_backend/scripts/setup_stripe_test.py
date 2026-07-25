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
PRODUCTS = [
    {"env": "STRIPE_PRICE_UNLOCK", "name": "GenomeChat Unlimited", "amount": 500},
    {"env": "STRIPE_PRICE_CREDITS", "name": "GenomeChat 50 Queries", "amount": 300},
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

        price = next(
            (p for p in stripe.Price.list(product=product["id"], limit=100, active=True).get("data", [])
             if p.get("unit_amount") == spec["amount"] and p.get("currency") == CURRENCY),
            None,
        )
        if price:
            print(f"  · price exists: {price['id']} (${spec['amount'] / 100:.2f})")
        else:
            price = stripe.Price.create(
                product=product["id"], unit_amount=spec["amount"], currency=CURRENCY,
            )
            print(f"  + created price: {price['id']} (${spec['amount'] / 100:.2f})")

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
