# ADR 0011 — Identidad técnica y cuenta MotorBaldi

`iam.auth_users` es la identidad técnica de Better Auth. En Fase 1 `iam.accounts` será identidad de cuenta MotorBaldi 1:1 con shared primary key: `iam.accounts.id REFERENCES iam.auth_users(id)`. `principal.accountId` permanece estable. La cuenta añadirá `person_id` y `principal.personId` solo tendrá valor tras vínculo verificado. Una persona puede existir sin cuenta. Fase 0.1 no crea people/accounts ni onboarding.
