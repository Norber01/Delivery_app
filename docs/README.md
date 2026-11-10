# Documentation

| # | Document | Contents |
|---|---|---|
| 1 | [System architecture](01-system-architecture.md) | Interfaces, technical architecture diagram, layer responsibilities, key decisions, environments |
| 2 | [Database schema](02-database-schema.md) | Firestore collections, RTDB layout, relationships, indexes, retention, validation |
| 3 | [Roles & permissions](03-roles-permissions.md) | Role list, permission matrix, enforcement layers, escalation safeguards |
| 4 | [Booking & pricing](04-booking-and-pricing.md) | Booking workflow, delivery-type classification, pricing algorithm |
| 5 | [Delivery lifecycle](05-delivery-lifecycle.md) | State machine, shipment legs, custody scanning, proof of delivery, exceptions |
| 6 | [GPS tracking](06-gps-tracking.md) | Location pipeline, update policy, weak connectivity, staleness, privacy |
| 7 | [Payments](07-payments.md) | Provider evaluation (Paystack, Hubtel), verification flow, refunds, cash & invoices |
| 8 | [Project structure](08-project-structure.md) | Monorepo layout and justified adjustments |
| 9 | [Development plan](09-development-plan.md) | Phases 1–6 with test gates and current status |
| 10 | [Security plan](10-security.md) | Identity, data protection, app security, audit, backup & recovery |
| 11 | [Setup & deployment](11-deployment.md) | Local development, project setup, deployment, rollback |
| 12 | [Cost control](12-cost-control.md) | Free tiers, usage controls, budget alerts |

Screenshots of the booking, payment, tracking and account flows (Phases 1–2) are in [`screenshots/`](screenshots/).
