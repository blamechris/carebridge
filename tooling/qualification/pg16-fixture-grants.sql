\set ON_ERROR_STOP on
\set ECHO none
\set VERBOSITY terse

\if :{?fixture_prefix}
\else
DO $$ BEGIN RAISE EXCEPTION 'CBQ_FIXTURE_PREFIX_REQUIRED'; END; $$;
\endif

SELECT
  :'fixture_prefix' || '_runtime' AS cbq_runtime,
  :'fixture_prefix' ~ '^cbq_[0-9a-f]{8}$'
  AND current_database() IN (
    :'fixture_prefix' || '_source', :'fixture_prefix' || '_restore', :'fixture_prefix' || '_upgrade'
  )
  AND session_user = current_user
  AND current_user::text = :'fixture_prefix' || '_migrator'
  AND current_setting('server_version_num')::integer BETWEEN 160000 AND 169999
  AND EXISTS (
    SELECT
    FROM pg_catalog.pg_database db
    JOIN pg_catalog.pg_roles owner ON owner.oid = db.datdba
    WHERE db.datname = current_database() AND owner.rolname = current_user
  )
  AND EXISTS (
    SELECT
    FROM pg_catalog.pg_namespace
    WHERE nspname = 'drizzle' AND nspowner = current_user::regrole
  )
  AND NOT EXISTS (
    SELECT
    FROM pg_catalog.pg_class relation
    JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname IN ('public', 'drizzle')
      AND relation.relkind IN ('r', 'p', 'v', 'm', 'f', 'S')
      AND relation.relowner <> current_user::regrole
  )
  AND (
    SELECT count(*) = 2
       AND bool_and(rolcanlogin AND NOT rolsuper AND NOT rolcreatedb
         AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls AND NOT rolinherit)
    FROM pg_catalog.pg_roles
    WHERE rolname::text IN (current_user::text, :'fixture_prefix' || '_runtime')
  )
  AND NOT EXISTS (
    SELECT
    FROM pg_catalog.pg_auth_members membership
    JOIN pg_catalog.pg_roles role_member ON role_member.oid = membership.member
    WHERE role_member.rolname::text IN (current_user::text, :'fixture_prefix' || '_runtime')
  ) AS cbq_target_ok
\gset

\if :cbq_target_ok
\else
DO $$ BEGIN RAISE EXCEPTION 'CBQ_GRANT_TARGET_MISMATCH'; END; $$;
\endif

BEGIN;
GRANT USAGE ON SCHEMA public, drizzle TO :"cbq_runtime";
GRANT SELECT ON TABLE drizzle.__drizzle_migrations TO :"cbq_runtime";

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.sessions TO :"cbq_runtime";
GRANT SELECT, INSERT, UPDATE ON TABLE
  public.appointments, public.clinical_flags, public.clinical_notes,
  public.failed_clinical_events, public.notifications, public.review_jobs
TO :"cbq_runtime";
GRANT SELECT, INSERT ON TABLE public.note_versions, public.provider_schedules TO :"cbq_runtime";
GRANT INSERT ON TABLE public.audit_log TO :"cbq_runtime";
GRANT SELECT ON TABLE
  public.allergies, public.allergy_overrides, public.care_team_assignments,
  public.care_team_members, public.diagnoses, public.emergency_access, public.encounters,
  public.family_relationships, public.lab_panels, public.lab_results, public.medications,
  public.messages, public.notification_preferences, public.patient_observations,
  public.patients, public.procedures, public.schedule_blocks, public.users, public.vitals
TO :"cbq_runtime";
COMMIT;

\echo CBQ_GRANTS_OK
