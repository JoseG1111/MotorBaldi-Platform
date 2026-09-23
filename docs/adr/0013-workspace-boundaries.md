# ADR 0013: Workspace Boundaries

Accepted.

MotorBaldi Core uses pnpm workspaces without Nx/Turborepo. Apps import package public APIs such as `@motorbaldi/db`, `@motorbaldi/db/outbox`, `@motorbaldi/storage` and `@motorbaldi/contracts/validation`. Deep imports into `packages/*/src/*` from apps or other packages are forbidden.

Each package declares its public API in `exports` and its real dependencies in `package.json`. Internal MotorBaldi dependencies use `workspace:*`. TypeScript paths mirror only exported public APIs for local typechecking.

`pnpm boundaries:check` enforces declared workspace dependencies, exported subpaths and an acyclic package graph. Cross-domain interaction must go through contracts or package APIs. A future module can be extracted by preserving its package exports and replacing its implementation behind the same API.
