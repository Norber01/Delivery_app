# Ops & admin tools (Phase 2+ — not started)

Internal React + TypeScript + Tailwind app deployed to a separate hostname behind Cloudflare Access.
Planned areas: dispatch board and live map (Phase 3), hubs and manifests (Phase 4), pricing editor,
payments/refunds and finance reports (Phase 2+), fleet and maintenance (Phase 6).

Until it exists, pricing is published with `pnpm --filter @courier/functions seed` (validated and
audited exactly like the `publishPricingRules` function) and roles via `setUserRole`/`bootstrap-admin`.
