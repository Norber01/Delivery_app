# Driver app (Phase 3 — not started)

React Native + TypeScript, Android-first. Planned scope (see `docs/09-development-plan.md`, `docs/06-gps-tracking.md`):
device-bound login, shifts, assignments, navigation hand-off, QR scanning, pickup confirmation,
foreground-service GPS (30–60 s / distance-filtered), status updates, failed-delivery reporting,
proof of delivery (OTP, signature, photo) and an offline event queue.

It will consume `@courier/constants`, `@courier/shared-types`, `@courier/validation` and the
lifecycle state machine from `@courier/shared-utils`.
