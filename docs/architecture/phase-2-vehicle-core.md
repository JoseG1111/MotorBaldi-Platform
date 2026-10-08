# Phase 2 — Vehicle Core

Vehicle is a central business entity. Its UUIDv7 key is independent of a person, account, organization, garage entry, VIN, plate, or any other mutable identifier. A vehicle can therefore exist before an ownership or access claim is resolved. Garage visibility is not legal ownership.

The first Vehicle migration creates `vehicle_vehicles` with a bounded generic `kind_code` and object-shaped `specification_json`. It deliberately does not fix a road-vehicle-only taxonomy. A kind may be added without changing the table, and specifications carry descriptive attributes rather than identity or authorization. D1 enforces UUIDv7 shape, kind syntax, valid object JSON, positive version, and a one-step version increment on update. Application commands must still use optimistic compare-and-swap when they are introduced.

The next migration separates historical identifiers, explicit owner/driver/workshop relationships, pending relationship claims, access grants, and personal garage entries. Identifier history may only be retired; relationship history may only be ended; grants may only be revoked. A claim, relationship, plate, VIN, or garage entry grants no access by itself. The read-only `hasVehiclePermission` domain function requires an active account/person and an exact, unexpired, unrevoked grant. Organization grants additionally require an active organization and membership, with the grant location inside the membership's active location scope. No public vehicle lookup or mutation API exists yet.

Later checkpoints add append-oriented odometer/history and immutable final professional records corrected through amendments. Exact kind taxonomy, specification fields, claim review policy, grant issuance workflow, and professional record workflow are **UNKNOWN — VERIFY FROM REPOSITORY** at their respective checkpoints; do not invent business rules to fill them.

See the [master architecture](MOTORBALDI_MASTER.md), [execution order](../ai/EXECUTION_PLAN.md), and [D1 migration strategy](../adr/0016-d1-migration-strategy.md).
