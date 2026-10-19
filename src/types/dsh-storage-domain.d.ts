/**
 * Minimal local declarations for @deepseek-ai/dsh-storage-domain.
 *
 * 0.2.1-rc.2 DOES publish its own .d.ts (lib/types/), but consuming its real
 * `domainTable<ZodType<V>>` signature makes tsc give up on the zod record
 * schema with TS2589 "Type instantiation is excessively deep" at the
 * `domainTable(uploadRecordSchema)` call. The package's own types are
 * therefore structurally redeclared here, limited to the two entry points this
 * plugin uses; runtime behaviour always comes from the real installed package.
 */
declare module '@deepseek-ai/dsh-storage-domain' {
  /** Table declaration produced by domainTable(); opaque here. */
  export interface DomainTableDecl {
    valueSchema: unknown
  }

  /** Declare one table with a zod record schema (the domain calls `.parse`). */
  export function domainTable(schema: unknown): DomainTableDecl

  export interface DomainSpec {
    name: string
    version: number
    tables: Record<string, DomainTableDecl>
  }

  /** Declare a domain once at module load; pins literal types, validates fields. */
  export function defineDomain(spec: DomainSpec): DomainSpec
}
