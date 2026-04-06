# care_team_members vs care_team_assignments

The database has two tables with similar names that serve **different purposes**.
This document explains why both exist and when to use each one.

## care_team_members — Clinical Roster

| Aspect   | Detail |
|----------|--------|
| Purpose  | Tracks which providers are clinically involved in a patient's care. |
| Consumed by | Patient chart UI (clinician-portal, patient-portal), ai-oversight context builder. |
| Key columns | `provider_id`, `role` (primary / specialist / nurse / coordinator), `specialty`, `is_active`. |
| Access control? | **No.** This table is never checked during authorization. |

Use this table when you need to display or reason about the clinical care team
(e.g., listing a patient's providers, assembling context for AI reviews).

## care_team_assignments — RBAC Access Control

| Aspect   | Detail |
|----------|--------|
| Purpose  | Determines which users are authorized to view/modify a patient's records. |
| Consumed by | api-gateway RBAC middleware (`assertPatientAccess`). |
| Key columns | `user_id`, `patient_id`, `role` (attending / consulting / nursing), `removed_at`. |
| Access control? | **Yes.** This is the authorization source of truth. |

Use this table when you need to grant, revoke, or check a user's access to a
patient's data.

## Why two tables?

A provider can be part of a patient's clinical care team without having system
access (e.g., an outside specialist listed for coordination purposes). Conversely,
a user may be granted temporary access to a patient's records for administrative
or coverage reasons without being a member of the clinical care team.

Keeping the concerns separate avoids coupling clinical documentation with
authorization logic and makes each table easier to query and audit independently.

## Schema location

Both tables are defined in `packages/db-schema/src/schema/patients.ts`.
