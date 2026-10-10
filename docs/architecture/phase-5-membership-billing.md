# Phase 5 — Membership, subscription billing and partner commissions

The owner directive of 2026-10-09 is the approved business foundation. This contract extends the existing modular monolith; [master architecture](MOTORBALDI_MASTER.md), [Vehicle Core](phase-2-vehicle-core.md), [Workshop Operations](phase-3-workshop-operations.md), [atomic coordination](../adr/0019-durable-object-coordination.md) and [scanner deferral](../adr/0024-owner-antimalware-deferral.md) remain accepted.

## Customer membership

Vehicle owners subscribe through their MotorBaldi **account**, separately from people and organization memberships. A free account remains valid without a paid subscription: existing identity, vehicle access, basic records and Workshop authorization do not acquire a premium requirement. Free customer service requests, appointments, quotation review/approval, basic tracking and completed-order records remain required customer workflows in the subsequent service/support roadmap; internal Workshop completion alone does not prove those customer workflows exist.

Premium name: **ACOMPAÑAMIENTO MOTORBALDI**. Brand positioning: **TODO SOBRE TU VEHÍCULO. SIEMPRE CONTIGO.**

| Billing option | COP price | Integer COP cents | Period                         |
| -------------- | --------: | ----------------: | ------------------------------ |
| Monthly        |    29,900 |         2,990,000 | One calendar month             |
| Annual         |   288,000 |        28,800,000 | One calendar year, one payment |

Prices come only from the server-side plan catalog. Pending periods snapshot price/currency; client prices are rejected. Calendar periods use UTC and clamp an unavailable day to the destination month's last day. Annual billing is a distinct plan, never twelve monthly installments. The Development vehicle limit is configurable and provisionally two; final public-launch approval is outstanding. Subscription coverage does not grant vehicle access: selection and use still require current exact Vehicle Core authorization.

Subscription states are PENDING_ACTIVATION, ACTIVE, PENDING_RENEWAL, PAST_DUE, CANCELLED, EXPIRED and SUSPENDED. Premium access is derived from current paid-period/provider confirmation evidence or a finite, reasoned, MFA-authorized administrative entitlement, while account/person and subscription remain eligible. A requested cancellation stops future renewal and preserves already-paid access until its end. Expired or suspended premium never erases or blocks basic purchased service history.

Approved entitlement interfaces cover assisted WhatsApp guidance, enhanced history, maintenance reminders, workshop assistance, appointment/service assistance, verified service follow-up, expense management and real partner benefits. Availability is independently reported: a paid membership is not proof that an unimplemented integration is ready. Initial foundation UI labels these benefits as in preparation rather than fabricating operational support. Later communication/service/reporting milestones implement them. Future preventive recommendations, monthly summaries, parts assistance and additional vehicle management remain configurable and disabled until ready.

WhatsApp uses a future provider port and configurable human availability/usage limits; no paid messaging service, unlimited/24-hour promise or remote diagnosis is implied. Reminders use verified or customer-provided dates/mileage, with provenance; there is no government-API access assumption. Partner suitability takes precedence over commissions. Exclusive discounts require a real approved agreement. The basic/paid history distinction preserves lawful access to already-purchased records.

## Separate partner revenue domain

Partner workshops/mechanics do not pay subscription fees. Versioned, partner-specific agreements contain service-specific percentage rules (integer basis points) or fixed integer amounts, currency and an explicitly selected rounding rule. No commission rate or settlement term is seeded. Draft agreement terms are immutable once approved; changes require a new agreement version.

Attribution requires a customer-scoped consent event for the order/agreement, separately from marketing consent, plus current account/vehicle boundaries. A referral alone generates no commission. Recognition requires the agreed service, a verified COMPLETED/CLOSED Workshop order and its immutable FINAL professional completion record within agreement validity. Authorized finance staff attest the applicable service amount with an evidence reference; existing Workshop records do not pretend to contain a price ledger. Recognition is unique for referral/rule and immutable in monetary terms. Adjustments/reversals are separate signed audit events; disputes are explicit states.

Settlement is **manual tracking only** and requires approved agreement settlement rules. It records/reconciles an external reference; it does not charge workshops, collect commissions or send payouts. Approved operational tracking never implies owner approval of unconfigured commercial terms.

## Financial and release controls

D1 owns canonical plans, policies, subscriptions, period snapshots, payments/attempts/confirmations, administrative grants, covered vehicles, agreements/referrals/commissions/adjustments/settlements and append-only financial events. Existing account ownership, default-deny authorization, finance permissions and post-enrollment MFA apply. Prepared commands commit business changes, financial audit, governance audit, minimal-ID outbox and durable replay atomically; a generic replay TTL is not lifetime payment deduplication. Payment reference/period/provider identifiers provide permanent financial uniqueness.

Development defaults: automatic renewal off, no grace extension, no automatic retries/refunds/proration, no automatic partner settlements, no trial or fabricated discounts. These are fail-closed technical defaults, not legal/commercial policy. Production billing stays disabled until tax treatment, refunds, grace/retry policy, final vehicle limits and recurring authorizations are approved. Required owner approvals are a release checklist, not a reason to block independently testable Development implementation. All real validation transactions must use the official sandbox; never charge real money for testing.

Raw card data never enters MotorBaldi storage. Provider credentials/integrity/event secrets belong in Cloudflare Worker secrets. Client redirects and unsigned payment notifications cannot activate access. Provider evidence must match internal reference, account-linked period, integer amount, currency, environment and transaction identity. Uncertain external outcomes require reconciliation, not blind retry. Private R2/quarantine controls remain intact; real scanner work is owner-deferred and public unscanned delivery is prohibited.

## Verified provider capability research

Official Wompi documentation checked on 2026-10-09: [payment sources](https://docs.wompi.co/docs/colombia/fuentes-de-pago/), [transactions](https://docs.wompi.co/docs/colombia/transacciones/), [acceptance tokens](https://docs.wompi.co/docs/colombia/tokens-de-aceptacion/), [webhook events](https://docs.wompi.co/docs/colombia/eventos/), [checkout integrity](https://docs.wompi.co/docs/colombia/widget-checkout-web/). Card and Nequi sources support subsequent charges; Nequi needs initial customer approval. PSE is a single-use payment method. MotorBaldi owns scheduling/lifecycle; reusable-source capability does not establish customer consent or a provider-managed subscription contract. These findings guide MB-P5-002/003; they are not evidence of a successful merchant sandbox integration.
