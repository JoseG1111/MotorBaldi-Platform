# ADR 0011 — Technical Identity and Future MotorBaldi Accounts

Status: Accepted.

`auth_users` is Better Auth technical identity. A later business phase may introduce a MotorBaldi account and verified person relationship, but CF-0.1 does not create people, accounts, organizations, memberships, or onboarding.

The Foundation principal exposes the verified technical identity as `accountId`, keeps `personId` null, and reports the authenticated user's current two factor enabled state. There is no global role column or bootstrap super administrator.
