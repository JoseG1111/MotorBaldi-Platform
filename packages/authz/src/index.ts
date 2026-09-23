export interface Actor {
  accountId: string;
  personId: string | null;
  active: boolean;
  permissions: ReadonlySet<string>;
}
export interface Resource {
  type: string;
  id: string;
  organizationId?: string;
}
export interface Context {
  requestId: string;
  now: Date;
  organizationId?: string;
}
export type Policy = (
  actor: Actor,
  resource: Resource,
  context: Context,
) => boolean;
export function authorization(
  policies: ReadonlyMap<string, Policy> = new Map(),
) {
  const registered = new Map(policies);
  return {
    can(
      actor: Actor | null,
      action: string,
      resource: Resource,
      context: Context,
    ): boolean {
      if (!actor?.active || !actor.permissions.has(action)) return false;
      const policy = registered.get(action);
      if (!policy) return false;
      try {
        return policy(actor, resource, context) === true;
      } catch {
        return false;
      }
    },
  };
}
export const { can } = authorization();
