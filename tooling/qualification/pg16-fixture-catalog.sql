\set ON_ERROR_STOP on
\set ECHO none
\set VERBOSITY terse

\if :{?fixture_prefix}
\else
DO $$ BEGIN RAISE EXCEPTION 'CBQ_FIXTURE_PREFIX_REQUIRED'; END; $$;
\endif

SELECT
  :'fixture_prefix' ~ '^cbq_[0-9a-f]{8}$'
  AND current_database() IN (
    :'fixture_prefix' || '_source', :'fixture_prefix' || '_restore', :'fixture_prefix' || '_upgrade'
  )
  AND current_user::text IN (:'fixture_prefix' || '_migrator', :'fixture_prefix' || '_runtime')
  AND current_setting('server_version_num')::integer BETWEEN 160000 AND 169999
  AND EXISTS (
    SELECT
    FROM pg_catalog.pg_database db
    JOIN pg_catalog.pg_roles owner ON owner.oid = db.datdba
    WHERE db.datname = current_database() AND owner.rolname::text = :'fixture_prefix' || '_migrator'
  ) AS cbq_target_ok
\gset

\if :cbq_target_ok
\else
DO $$ BEGIN RAISE EXCEPTION 'CBQ_CATALOG_TARGET_MISMATCH'; END; $$;
\endif

BEGIN READ ONLY;
WITH fixture_roles AS (
  SELECT
    (SELECT oid FROM pg_catalog.pg_roles WHERE rolname::text = :'fixture_prefix' || '_runtime') AS runtime,
    (SELECT oid FROM pg_catalog.pg_roles WHERE rolname::text = :'fixture_prefix' || '_migrator') AS migrator
), database_acl AS (
  SELECT acl.grantee, acl.privilege_type
  FROM pg_catalog.pg_database db
  CROSS JOIN LATERAL pg_catalog.aclexplode(coalesce(db.datacl, pg_catalog.acldefault('d', db.datdba))) acl
  WHERE db.datname = current_database()
), expected_table_privileges AS (
  SELECT unnest(tables) AS table_name, permissions
  FROM (VALUES
    (ARRAY['sessions'], ARRAY['SELECT', 'INSERT', 'UPDATE', 'DELETE']),
    (ARRAY['appointments', 'clinical_flags', 'clinical_notes', 'failed_clinical_events',
       'notifications', 'review_jobs'], ARRAY['SELECT', 'INSERT', 'UPDATE']),
    (ARRAY['note_versions', 'provider_schedules'], ARRAY['SELECT', 'INSERT']),
    (ARRAY['audit_log'], ARRAY['INSERT']),
    (ARRAY['allergies', 'allergy_overrides', 'care_team_assignments', 'care_team_members',
       'diagnoses', 'emergency_access', 'encounters', 'family_relationships', 'lab_panels',
       'lab_results', 'medications', 'messages', 'notification_preferences', 'patient_observations',
       'patients', 'procedures', 'schedule_blocks', 'users', 'vitals'], ARRAY['SELECT'])
  ) AS profile(tables, permissions)
), public_tables AS (
  SELECT relation.oid, relation.relname::text AS table_name, relation.relowner
  FROM pg_catalog.pg_class relation
  JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
  WHERE namespace.nspname = 'public' AND relation.relkind IN ('r', 'p', 'v', 'm', 'f')
), table_privilege_checks AS (
  SELECT
    count(DISTINCT public_tables.oid) AS public_table_count,
    count(DISTINCT expected.table_name) AS provisioned_table_count,
    count(DISTINCT expected.table_name) = (SELECT count(*) FROM expected_table_privileges)
      AND coalesce(bool_and(
        pg_catalog.has_table_privilege(roles.runtime, public_tables.oid, privilege.name)
          = coalesce(privilege.name = ANY(expected.permissions), false)
        AND NOT pg_catalog.has_table_privilege(
          roles.runtime, public_tables.oid, privilege.name || ' WITH GRANT OPTION'
        )
      ), false) AS runtime_table_profile_matches,
    coalesce(bool_and(public_tables.relowner = roles.migrator), false) AS public_tables_owned_by_migrator
  FROM public_tables
  CROSS JOIN fixture_roles roles
  CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER'))
    AS privilege(name)
  LEFT JOIN expected_table_privileges expected ON expected.table_name = public_tables.table_name
), journal_checks AS (
  SELECT
    schema_object.nspowner = roles.migrator
      AND journal.relowner = roles.migrator AS journal_owned_by_migrator,
    pg_catalog.has_schema_privilege(roles.runtime, schema_object.oid, 'USAGE')
      AND NOT pg_catalog.has_schema_privilege(roles.runtime, schema_object.oid, 'CREATE')
      AND pg_catalog.has_table_privilege(roles.runtime, journal.oid, 'SELECT')
      AND NOT pg_catalog.has_table_privilege(
        roles.runtime, journal.oid, 'SELECT WITH GRANT OPTION, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'
      ) AS runtime_journal_read_only
  FROM pg_catalog.pg_namespace schema_object
  JOIN pg_catalog.pg_class journal ON journal.relnamespace = schema_object.oid
  CROSS JOIN fixture_roles roles
  WHERE schema_object.nspname = 'drizzle' AND journal.relname = '__drizzle_migrations'
), expected_triggers(table_name, trigger_name, trigger_type, function_name) AS (
  -- pg_trigger.tgtype adds ROW (1), BEFORE (2), DELETE (8), UPDATE (16) and TRUNCATE (32).
  VALUES
    ('audit_log', 'audit_log_no_update', 19, 'prevent_audit_log_modification'),
    ('audit_log', 'audit_log_no_delete', 11, 'prevent_audit_log_modification'),
    ('audit_log', 'audit_log_no_truncate', 34, 'prevent_audit_log_modification'),
    ('allergy_overrides', 'allergy_overrides_no_update', 19, 'prevent_allergy_override_modification'),
    ('allergy_overrides', 'allergy_overrides_no_delete', 11, 'prevent_allergy_override_modification')
), trigger_checks AS (
  SELECT
    count(*) AS fixture_trigger_count,
    count(*) = (SELECT count(*) FROM expected_triggers)
      AND coalesce(bool_and(
        expected.trigger_name IS NOT NULL AND trigger_row.tgenabled = 'O'
        AND trigger_row.tgtype = expected.trigger_type
        AND routine.proname::text = expected.function_name AND NOT routine.prosecdef
        AND routine.proowner = roles.migrator
      ), false) AS fixture_triggers_match
  FROM public_tables
  JOIN pg_catalog.pg_trigger trigger_row ON trigger_row.tgrelid = public_tables.oid
  JOIN pg_catalog.pg_proc routine ON routine.oid = trigger_row.tgfoid
  CROSS JOIN fixture_roles roles
  LEFT JOIN expected_triggers expected
    ON expected.table_name = public_tables.table_name AND expected.trigger_name = trigger_row.tgname::text
  WHERE NOT trigger_row.tgisinternal AND public_tables.table_name IN ('audit_log', 'allergy_overrides')
)
SELECT pg_catalog.jsonb_build_object(
  'pg16', true,
  'session_matches_migrator',
    session_user = current_user AND current_user::text = :'fixture_prefix' || '_migrator',
  'session_matches_runtime',
    session_user = current_user AND current_user::text = :'fixture_prefix' || '_runtime',
  'two_restricted_logins',
    (SELECT count(*) = 2 AND bool_and(rolcanlogin AND NOT rolsuper AND NOT rolcreatedb
        AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls AND NOT rolinherit)
     FROM pg_catalog.pg_roles
     WHERE oid IN (roles.migrator, roles.runtime)),
  'no_explicit_role_memberships',
    NOT EXISTS (SELECT FROM pg_catalog.pg_auth_members WHERE member IN (roles.migrator, roles.runtime)),
  'database_owned_by_migrator', true,
  'public_schema_owned_by_database_owner',
    (SELECT nspowner = 'pg_database_owner'::regrole FROM pg_catalog.pg_namespace WHERE nspname = 'public'),
  'runtime_can_connect', pg_catalog.has_database_privilege(roles.runtime, current_database(), 'CONNECT'),
  'runtime_cannot_create_schemas_or_public_objects',
    NOT pg_catalog.has_database_privilege(roles.runtime, current_database(), 'CREATE')
      AND pg_catalog.has_schema_privilege(roles.runtime, 'public', 'USAGE')
      AND NOT pg_catalog.has_schema_privilege(roles.runtime, 'public', 'CREATE'),
  'public_default_connect',
    EXISTS (SELECT FROM database_acl WHERE grantee = 0 AND privilege_type = 'CONNECT'),
  'public_default_temporary',
    EXISTS (SELECT FROM database_acl WHERE grantee = 0 AND privilege_type = 'TEMPORARY'),
  'public_table_count', tables.public_table_count,
  'provisioned_table_count', tables.provisioned_table_count,
  'runtime_table_profile_matches', tables.runtime_table_profile_matches,
  'public_tables_owned_by_migrator', tables.public_tables_owned_by_migrator,
  'runtime_audit_insert_only',
    pg_catalog.has_table_privilege(roles.runtime, 'public.audit_log', 'INSERT')
      AND NOT pg_catalog.has_table_privilege(
        roles.runtime, 'public.audit_log', 'SELECT, INSERT WITH GRANT OPTION, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER'
      )
      AND NOT pg_catalog.has_any_column_privilege(roles.runtime, 'public.audit_log', 'SELECT, UPDATE, REFERENCES'),
  'journal_owned_by_migrator', coalesce((SELECT journal_owned_by_migrator FROM journal_checks), false),
  'runtime_journal_read_only', coalesce((SELECT runtime_journal_read_only FROM journal_checks), false),
  'journal_sequence_owned_by_migrator',
    coalesce((
      SELECT relowner = roles.migrator
      FROM pg_catalog.pg_class
      WHERE oid = pg_catalog.to_regclass('drizzle.__drizzle_migrations_id_seq')
    ), false),
  'runtime_has_no_journal_sequence_privilege',
    coalesce(NOT pg_catalog.has_sequence_privilege(
      roles.runtime, pg_catalog.to_regclass('drizzle.__drizzle_migrations_id_seq'), 'USAGE, SELECT, UPDATE'
    ), false),
  'fixture_trigger_count', triggers.fixture_trigger_count,
  'fixture_triggers_match', triggers.fixture_triggers_match
)
FROM fixture_roles roles
CROSS JOIN table_privilege_checks tables
CROSS JOIN trigger_checks triggers;
COMMIT;
