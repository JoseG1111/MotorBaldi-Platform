# ADR 0025 — Account membership and separate partner commissions

Status: Accepted — owner directive, 2026-10-09.

MotorBaldi's two revenue streams are account-owned customer subscriptions and separate partner referral commissions. Customers may remain free. Partner organizations/mechanics are commercial capabilities/relationships and owe no subscription fee. The approved plans, benefits and safe Development policy defaults are specified in the [Phase 5 contract](../architecture/phase-5-membership-billing.md).

D1 remains the operational subscription source of truth; Wompi processes payments. A paid period requires verified, reference/amount/currency/environment-bound provider evidence, while an explicitly authorized finite administrative entitlement is distinct from payment. Calendar annual billing is separate from monthly billing. Vehicle coverage never confers authorization or legal ownership. Premium expiry does not remove basic service records.

Subscription and commission commands share the established atomic command infrastructure, but have distinct domain state and financial events. Agreement/rate/rounding/settlement terms must be configured and approved; no commercial rate is invented. Attribution needs purpose-specific customer consent and verified completed-service evidence. Recognition is permanently unique, monetary corrections append new events, and settlement tracking has no automatic charge/payout side effect.

Owner approvals for production tax/refund/grace/retry/vehicle-limit/recurring/settlement rules remain outstanding. The implementation can progress in Development with fail-closed policy defaults; it cannot enable real production billing or bypass the existing human release boundary. This decision adds no paid infrastructure, government data integration, messaging promise or scanner exception.
