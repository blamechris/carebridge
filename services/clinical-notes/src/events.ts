/**
 * Re-export of the shared clinical event emitter.
 *
 * The single source of truth lives in `@carebridge/outbox` so that
 * both `clinical-data` and `clinical-notes` share one implementation.
 * See: https://github.com/blamechris/carebridge/issues/817
 */
export { emitClinicalEvent } from "@carebridge/outbox";
export type { ClinicalEvent } from "@carebridge/shared-types";
