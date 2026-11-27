\set ON_ERROR_STOP on
\set ECHO none
\set VERBOSITY terse
\set SHOW_CONTEXT never

\if :{?fixture_prefix}
\else
DO $$ BEGIN RAISE EXCEPTION 'CBQ_FIXTURE_PREFIX_REQUIRED'; END; $$;
\endif

SELECT
  :'fixture_prefix' || '_migrator' AS cbq_migrator,
  :'fixture_prefix' || '_runtime' AS cbq_runtime,
  :'fixture_prefix' ~ '^cbq_[0-9a-f]{8}$'
  AND current_database() = 'postgres'
  AND session_user = current_user
  AND current_user::text = :'fixture_prefix' || '_admin'
  AND current_setting('server_version_num')::integer BETWEEN 160000 AND 169999
  AND EXISTS (
    SELECT FROM pg_catalog.pg_roles WHERE rolname = current_user AND rolsuper
  )
  AND NOT EXISTS (
    SELECT FROM pg_catalog.pg_roles
    WHERE rolname::text IN (:'fixture_prefix' || '_migrator', :'fixture_prefix' || '_runtime')
  ) AS cbq_target_ok
\gset

\if :cbq_target_ok
\else
DO $$ BEGIN RAISE EXCEPTION 'CBQ_ROLE_TARGET_MISMATCH'; END; $$;
\endif

\set cbq_migrator_password ''
\set cbq_runtime_password ''
\getenv cbq_migrator_password CBQ_MIGRATOR_PASSWORD
\getenv cbq_runtime_password CBQ_RUNTIME_PASSWORD

BEGIN;
SELECT length(:'cbq_migrator_password') > 0
   AND length(:'cbq_runtime_password') > 0
   AND :'cbq_migrator_password' <> :'cbq_runtime_password' AS cbq_passwords_ok
\gset

\if :cbq_passwords_ok
\else
DO $$ BEGIN RAISE EXCEPTION 'CBQ_DISTINCT_ROLE_PASSWORDS_REQUIRED'; END; $$;
\endif

CREATE ROLE :"cbq_migrator" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOREPLICATION NOBYPASSRLS NOINHERIT PASSWORD :'cbq_migrator_password';
CREATE ROLE :"cbq_runtime" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOREPLICATION NOBYPASSRLS NOINHERIT PASSWORD :'cbq_runtime_password';
\unset cbq_migrator_password
\unset cbq_runtime_password
COMMIT;

\echo CBQ_ROLES_OK
