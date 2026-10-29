-- Tenant isolation for the booking domain, on top of the identity tables.
--
-- The policies are deliberately dull and identical: org_id must equal
-- app.current_org, for reads and for writes. A clever policy is a policy
-- somebody will get wrong, and the whole value here is that the rule holds
-- for every query including the ones not written yet.
--
-- One thing worth knowing about the interaction with 0001: constraints are
-- enforced regardless of row-level security, so a tenant can be refused by
-- the exclusion constraint on a row it cannot see. The composite
-- (org_id, id) foreign keys in 0001 make that harmless here -- a conflict
-- always involves a staff member or customer of the tenant's own
-- organization -- but it is the kind of thing to check before relying on an
-- error message being safe to show a user. The booking service turns 23P01
-- into a generic "that time is no longer available" rather than passing the
-- database's DETAIL through.

-- Tenant isolation. The application connects as the schema owner and drops to
-- the app_tenant role inside withTenant(); RLS applies to that role, so a
-- tenant transaction can only see and write rows for app.current_org.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_tenant') THEN
    CREATE ROLE app_tenant NOLOGIN;
  END IF;
END
$$;
--> statement-breakpoint
-- Postgres 16 gives a CREATEROLE creator ADMIN on the new role but not SET,
-- so grant SET explicitly; older servers only need plain membership.
DO $$
BEGIN
  IF current_setting('server_version_num')::int >= 160000 THEN
    EXECUTE format('GRANT app_tenant TO %I WITH INHERIT FALSE, SET TRUE', current_user);
  ELSIF NOT pg_has_role(current_user, 'app_tenant', 'MEMBER') THEN
    EXECUTE format('GRANT app_tenant TO %I', current_user);
  END IF;
END
$$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_current_org() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.current_org', true), '')::uuid $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_current_user() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT nullif(current_setting('app.current_user', true), '')::uuid $$;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public TO app_tenant;
--> statement-breakpoint
GRANT SELECT, UPDATE, DELETE ON organizations TO app_tenant;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON memberships, invitations, subscriptions, api_keys TO app_tenant;
--> statement-breakpoint
-- The booking domain. Every one of these carries org_id and gets the same
-- policy: a tenant transaction sees and writes only its own organization's
-- rows, whatever the query says.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  services, staff, staff_services, availability_rules, date_overrides,
  time_off, customers, appointments, reminders
TO app_tenant;
--> statement-breakpoint
GRANT SELECT, INSERT ON audit_logs TO app_tenant;
--> statement-breakpoint
GRANT SELECT ON users TO app_tenant;
--> statement-breakpoint
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON organizations TO app_tenant
  USING (id = app_current_org()) WITH CHECK (id = app_current_org());
--> statement-breakpoint
-- A signed-in user may list the organizations they belong to before any org is selected.
CREATE POLICY member_directory ON organizations FOR SELECT TO app_tenant
  USING (EXISTS (
    SELECT 1 FROM memberships m WHERE m.org_id = organizations.id AND m.user_id = app_current_user()
  ));
--> statement-breakpoint
ALTER TABLE memberships ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON memberships TO app_tenant
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());
--> statement-breakpoint
CREATE POLICY member_self ON memberships FOR SELECT TO app_tenant
  USING (user_id = app_current_user());
--> statement-breakpoint
ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON invitations TO app_tenant
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());
--> statement-breakpoint
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON subscriptions TO app_tenant
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());
--> statement-breakpoint
ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON api_keys TO app_tenant
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());
--> statement-breakpoint
ALTER TABLE services ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON services TO app_tenant
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());
--> statement-breakpoint
ALTER TABLE staff ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON staff TO app_tenant
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());
--> statement-breakpoint
ALTER TABLE staff_services ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON staff_services TO app_tenant
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());
--> statement-breakpoint
ALTER TABLE availability_rules ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON availability_rules TO app_tenant
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());
--> statement-breakpoint
ALTER TABLE date_overrides ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON date_overrides TO app_tenant
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());
--> statement-breakpoint
ALTER TABLE time_off ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON time_off TO app_tenant
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());
--> statement-breakpoint
ALTER TABLE customers ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON customers TO app_tenant
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());
--> statement-breakpoint
ALTER TABLE appointments ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON appointments TO app_tenant
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());
--> statement-breakpoint
ALTER TABLE reminders ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON reminders TO app_tenant
  USING (org_id = app_current_org()) WITH CHECK (org_id = app_current_org());
--> statement-breakpoint
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_read ON audit_logs FOR SELECT TO app_tenant
  USING (org_id = app_current_org());
--> statement-breakpoint
CREATE POLICY tenant_append ON audit_logs FOR INSERT TO app_tenant
  WITH CHECK (org_id = app_current_org());
--> statement-breakpoint
-- Identity rows are global, but a tenant may only see itself and people in the current org.
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY visible_users ON users FOR SELECT TO app_tenant
  USING (
    id = app_current_user()
    OR EXISTS (SELECT 1 FROM memberships m WHERE m.user_id = users.id AND m.org_id = app_current_org())
  );
