/**
 * Minimal local declarations for @deepseek-ai/dsh-storage-domain.
 * The shipped package has no .d.ts (lib/types/ is not published), so we
 * declare only the two entry points this plugin uses, with structural types.
 */
declare module '@deepseek-ai/dsh-storage-domain' {
  /** Table declaration produced by domainTable(); opaque here. */
  export interface DomainTableDecl {
    valueSchema: unknown
  }

  /** Declare one table with a zod/schemastery record schema. */
  export function domainTable(schema: unknown): DomainTableDecl

  export interface DomainSpec {
    name: string
    version: number
    tables: Record<string, DomainTableDecl>
  }

  /** Declare a domain once at module load; pins literal types, validates fields. */
  export function defineDomain(spec: DomainSpec): DomainSpec
}
