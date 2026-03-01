-- CA Comply Complete Schema
-- Runs on first startup via Docker init

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- ── ENUMS
CREATE TYPE subscription_tier AS ENUM ('silver', 'gold', 'platinum');
CREATE TYPE subscription_status AS ENUM ('trial', 'active', 'past_due', 'cancelled', 'suspended');
CREATE TYPE user_role AS ENUM ('super_admin', 'partner', 'manager', 'staff', 'client');
CREATE TYPE task_status AS ENUM ('unassigned', 'pending', 'in_progress', 'review', 'done', 'overdue', 'cancelled');
CREATE TYPE task_priority AS ENUM ('low', 'medium', 'high', 'critical');
CREATE TYPE compliance_type AS ENUM ('advance_tax', 'tds_return', 'gst_filing', 'itr_filing', 'roc_filing', 'tds_deposit', 'pt_filing', 'custom');
CREATE TYPE document_type AS ENUM ('itr', 'form_16', 'bank_statement', 'gst_return', 'balance_sheet', 'pnl', 'tds_certificate', 'pan_card', 'aadhaar', 'other');
CREATE TYPE client_type AS ENUM ('individual', 'company', 'partnership', 'llp', 'trust');

-- ── TENANTS
CREATE TABLE tenants (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name            VARCHAR(200) NOT NULL,
    slug            VARCHAR(100) UNIQUE NOT NULL,
    tier            subscription_tier NOT NULL DEFAULT 'silver',
    status          subscription_status NOT NULL DEFAULT 'trial',
    max_users       INTEGER NOT NULL DEFAULT 10,
    max_clients     INTEGER NOT NULL DEFAULT 50,
    logo_url        VARCHAR(500),
    primary_color   VARCHAR(7) DEFAULT '#3b82f6',
    firm_city       VARCHAR(100),
    icai_membership VARCHAR(50),
    timezone        VARCHAR(50) DEFAULT 'Asia/Kolkata',
    billing_email   VARCHAR(200),
    trial_ends_at   TIMESTAMPTZ DEFAULT NOW() + INTERVAL '30 days',
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW(),
    deleted_at      TIMESTAMPTZ
);

-- ── USERS
CREATE TABLE users (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    email           VARCHAR(200) NOT NULL,
    password_hash   VARCHAR(200) NOT NULL,
    full_name       VARCHAR(200) NOT NULL,
    phone           VARCHAR(20),
    role            user_role NOT NULL DEFAULT 'staff',
    avatar_url      VARCHAR(500),
    is_active       BOOLEAN DEFAULT TRUE,
    email_verified  BOOLEAN DEFAULT TRUE,
    last_login_at   TIMESTAMPTZ,
    preferences     JSONB DEFAULT '{"theme":"dark"}',
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW(),
    deleted_at      TIMESTAMPTZ
);
CREATE UNIQUE INDEX idx_users_email_tenant ON users(email, tenant_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_users_tenant ON users(tenant_id);

-- ── CLIENTS
CREATE TABLE clients (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    client_code     VARCHAR(20) NOT NULL,
    full_name       VARCHAR(200) NOT NULL,
    client_type     client_type NOT NULL DEFAULT 'individual',
    email           VARCHAR(200),
    phone           VARCHAR(20),
    pan_number      VARCHAR(10),
    gst_number      VARCHAR(15),
    city            VARCHAR(100),
    state           VARCHAR(100),
    assigned_manager_id UUID REFERENCES users(id),
    itr_applicable  BOOLEAN DEFAULT TRUE,
    gst_applicable  BOOLEAN DEFAULT FALSE,
    tds_applicable  BOOLEAN DEFAULT FALSE,
    advance_tax_applicable BOOLEAN DEFAULT FALSE,
    notes           TEXT,
    is_active       BOOLEAN DEFAULT TRUE,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW(),
    deleted_at      TIMESTAMPTZ,
    created_by      UUID REFERENCES users(id)
);
CREATE UNIQUE INDEX idx_clients_code_tenant ON clients(client_code, tenant_id);
CREATE INDEX idx_clients_tenant ON clients(tenant_id);

-- Auto client code
CREATE OR REPLACE FUNCTION generate_client_code()
RETURNS TRIGGER AS $$
DECLARE seq INTEGER;
BEGIN
  SELECT COUNT(*) + 1 INTO seq FROM clients WHERE tenant_id = NEW.tenant_id;
  NEW.client_code := 'CLI' || LPAD(seq::TEXT, 4, '0');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER trg_client_code BEFORE INSERT ON clients FOR EACH ROW EXECUTE FUNCTION generate_client_code();

-- ── COMPLIANCE TASKS
CREATE TABLE compliance_tasks (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    client_id       UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    compliance_type compliance_type NOT NULL,
    title           VARCHAR(200) NOT NULL,
    description     TEXT,
    due_date        DATE NOT NULL,
    financial_year  VARCHAR(10),
    quarter         VARCHAR(5),
    assigned_to     UUID REFERENCES users(id),
    assigned_by     UUID REFERENCES users(id),
    assigned_at     TIMESTAMPTZ,
    status          task_status NOT NULL DEFAULT 'unassigned',
    priority        task_priority NOT NULL DEFAULT 'medium',
    completed_at    TIMESTAMPTZ,
    completed_by    UUID REFERENCES users(id),
    completion_notes TEXT,
    escalated       BOOLEAN DEFAULT FALSE,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    updated_at      TIMESTAMPTZ DEFAULT NOW(),
    created_by      UUID REFERENCES users(id)
);
CREATE INDEX idx_tasks_tenant ON compliance_tasks(tenant_id);
CREATE INDEX idx_tasks_client ON compliance_tasks(client_id);
CREATE INDEX idx_tasks_due_date ON compliance_tasks(due_date);
CREATE INDEX idx_tasks_status ON compliance_tasks(status);
CREATE INDEX idx_tasks_assigned ON compliance_tasks(assigned_to);

-- ── DOCUMENTS
CREATE TABLE documents (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    client_id       UUID NOT NULL REFERENCES clients(id) ON DELETE CASCADE,
    file_name       VARCHAR(300) NOT NULL,
    original_name   VARCHAR(300) NOT NULL,
    file_size       BIGINT,
    mime_type       VARCHAR(100),
    document_type   document_type NOT NULL DEFAULT 'other',
    financial_year  VARCHAR(10),
    storage_path    VARCHAR(500) NOT NULL,
    uploaded_by     UUID REFERENCES users(id),
    notes           TEXT,
    created_at      TIMESTAMPTZ DEFAULT NOW(),
    deleted_at      TIMESTAMPTZ
);
CREATE INDEX idx_docs_tenant ON documents(tenant_id);
CREATE INDEX idx_docs_client ON documents(client_id);

-- ── NOTIFICATIONS
CREATE TABLE notifications (
    id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    recipient_user_id UUID REFERENCES users(id),
    task_id         UUID REFERENCES compliance_tasks(id),
    title           VARCHAR(300) NOT NULL,
    body            TEXT NOT NULL,
    channel         VARCHAR(20) DEFAULT 'in_app',
    is_read         BOOLEAN DEFAULT FALSE,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_notifs_user ON notifications(recipient_user_id, is_read);
CREATE INDEX idx_notifs_tenant ON notifications(tenant_id);

-- ── ACTIVITY LOGS
CREATE TABLE activity_logs (
    id              BIGSERIAL PRIMARY KEY,
    tenant_id       UUID REFERENCES tenants(id),
    user_id         UUID REFERENCES users(id),
    action          VARCHAR(100) NOT NULL,
    entity_type     VARCHAR(50),
    entity_id       UUID,
    metadata        JSONB,
    ip_address      INET,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_activity_tenant ON activity_logs(tenant_id, created_at DESC);

-- ── ERROR LOGS
CREATE TABLE error_logs (
    id              BIGSERIAL PRIMARY KEY,
    tenant_id       UUID REFERENCES tenants(id),
    user_id         UUID REFERENCES users(id),
    level           VARCHAR(20) NOT NULL DEFAULT 'error',
    message         TEXT NOT NULL,
    stack_trace     TEXT,
    endpoint        VARCHAR(200),
    method          VARCHAR(10),
    status_code     INTEGER,
    error_code      VARCHAR(50),
    metadata        JSONB,
    resolved        BOOLEAN DEFAULT FALSE,
    resolved_at     TIMESTAMPTZ,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_errors_level ON error_logs(level, created_at DESC);
CREATE INDEX idx_errors_tenant ON error_logs(tenant_id, created_at DESC);

-- ── FEATURE USAGE
CREATE TABLE feature_usage (
    id              BIGSERIAL PRIMARY KEY,
    tenant_id       UUID NOT NULL REFERENCES tenants(id),
    user_id         UUID REFERENCES users(id),
    feature         VARCHAR(50) NOT NULL,
    action          VARCHAR(100),
    duration_ms     INTEGER,
    session_id      VARCHAR(100),
    metadata        JSONB,
    created_at      TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_usage_tenant ON feature_usage(tenant_id, feature, created_at DESC);

-- ── AUTO UPDATE TIMESTAMPS
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$ LANGUAGE plpgsql;
CREATE TRIGGER trg_tenants_updated BEFORE UPDATE ON tenants FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_users_updated BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_clients_updated BEFORE UPDATE ON clients FOR EACH ROW EXECUTE FUNCTION update_updated_at();
CREATE TRIGGER trg_tasks_updated BEFORE UPDATE ON compliance_tasks FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ── SEED: Demo tenant + users + clients + tasks
-- Password for all demo users: Demo@1234

-- Tenant: CA Ravi Ranjan & Associates
INSERT INTO tenants (id, name, slug, tier, status, firm_city, icai_membership, billing_email, max_users, max_clients, primary_color)
VALUES (
  '11111111-1111-1111-1111-111111111111',
  'CA Ravi Ranjan & Associates',
  'raviranjan',
  'gold',
  'active',
  'Patna, Bihar',
  'ICAI-MRN-054321',
  'ravi@raviranjan-ca.in',
  50,
  200,
  '#3b82f6'
);

-- Partner (super user of the firm)
INSERT INTO users (id, tenant_id, email, password_hash, full_name, phone, role)
VALUES (
  'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  '11111111-1111-1111-1111-111111111111',
  'ravi@raviranjan-ca.in',
  '$2a$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxMQJqhN8/LewdBPj2NJVnjXCGy', -- Demo@1234
  'CA Ravi Ranjan',
  '+919876543210',
  'partner'
);

-- Manager
INSERT INTO users (id, tenant_id, email, password_hash, full_name, phone, role)
VALUES (
  'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  '11111111-1111-1111-1111-111111111111',
  'priya@raviranjan-ca.in',
  '$2a$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxMQJqhN8/LewdBPj2NJVnjXCGy', -- Demo@1234
  'Priya Sharma',
  '+919876543211',
  'manager'
);

-- Staff 1
INSERT INTO users (id, tenant_id, email, password_hash, full_name, phone, role)
VALUES (
  'cccccccc-cccc-cccc-cccc-cccccccccccc',
  '11111111-1111-1111-1111-111111111111',
  'amit@raviranjan-ca.in',
  '$2a$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxMQJqhN8/LewdBPj2NJVnjXCGy', -- Demo@1234
  'Amit Kumar',
  '+919876543212',
  'staff'
);

-- Staff 2
INSERT INTO users (id, tenant_id, email, password_hash, full_name, phone, role)
VALUES (
  'dddddddd-dddd-dddd-dddd-dddddddddddd',
  '11111111-1111-1111-1111-111111111111',
  'sunita@raviranjan-ca.in',
  '$2a$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxMQJqhN8/LewdBPj2NJVnjXCGy', -- Demo@1234
  'Sunita Devi',
  '+919876543213',
  'staff'
);

-- Clients
INSERT INTO clients (id, tenant_id, client_code, full_name, client_type, email, phone, pan_number, gst_number, city, state, itr_applicable, gst_applicable, tds_applicable, advance_tax_applicable, assigned_manager_id, created_by)
VALUES
('c1111111-1111-1111-1111-111111111111', '11111111-1111-1111-1111-111111111111', 'CLI0001', 'Rajesh Kumar Gupta', 'individual', 'rajesh@example.com', '9801234567', 'ABCPG1234H', NULL, 'Patna', 'Bihar', true, false, false, true, 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
('c2222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 'CLI0002', 'Sunrise Traders Pvt Ltd', 'company', 'info@sunrise.com', '9802234567', 'SUNPT1234K', '10SUNPT1234K1Z5', 'Patna', 'Bihar', true, true, true, true, 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
('c3333333-3333-3333-3333-333333333333', '11111111-1111-1111-1111-111111111111', 'CLI0003', 'Anita Singh', 'individual', 'anita@example.com', '9803234567', 'BCDPS5678M', NULL, 'Muzaffarpur', 'Bihar', true, false, false, false, 'cccccccc-cccc-cccc-cccc-cccccccccccc', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
('c4444444-4444-4444-4444-444444444444', '11111111-1111-1111-1111-111111111111', 'CLI0004', 'Bihar Steel Works LLP', 'llp', 'accounts@bswllp.in', '9804234567', 'BISPL9012N', '10BISPL9012N1Z1', 'Patna', 'Bihar', true, true, true, true, 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
('c5555555-5555-5555-5555-555555555555', '11111111-1111-1111-1111-111111111111', 'CLI0005', 'Dr. Suresh Prasad', 'individual', 'dr.suresh@example.com', '9805234567', 'CDQPR3456O', NULL, 'Gaya', 'Bihar', true, false, false, true, 'cccccccc-cccc-cccc-cccc-cccccccccccc', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
('c6666666-6666-6666-6666-666666666666', '11111111-1111-1111-1111-111111111111', 'CLI0006', 'Patna Real Estate Co', 'company', 'finance@patnarealco.in', '9806234567', 'PRECO7890P', '10PRECO7890P1Z2', 'Patna', 'Bihar', true, true, true, true, 'dddddddd-dddd-dddd-dddd-dddddddddddd', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
('c7777777-7777-7777-7777-777777777777', '11111111-1111-1111-1111-111111111111', 'CLI0007', 'Meena Kumari', 'individual', 'meena@example.com', '9807234567', 'DEMKM2345Q', NULL, 'Bhagalpur', 'Bihar', true, false, false, false, 'cccccccc-cccc-cccc-cccc-cccccccccccc', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
('c8888888-8888-8888-8888-888888888888', '11111111-1111-1111-1111-111111111111', 'CLI0008', 'Galaxy Pharma Pvt Ltd', 'company', 'cfo@galaxypharma.com', '9808234567', 'GAXPP4567R', '10GAXPP4567R1Z3', 'Patna', 'Bihar', true, true, true, true, 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');

-- Compliance Tasks (realistic for current year)
INSERT INTO compliance_tasks (id, tenant_id, client_id, compliance_type, title, due_date, financial_year, status, priority, assigned_to, assigned_by, assigned_at, created_by)
VALUES
-- OVERDUE tasks
('t0000001-0000-0000-0000-000000000001', '11111111-1111-1111-1111-111111111111', 'c2222222-2222-2222-2222-222222222222', 'tds_deposit', 'TDS Deposit - Jan 2026', '2026-02-07', '2025-26', 'overdue', 'critical', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', NOW() - INTERVAL '20 days', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
('t0000001-0000-0000-0000-000000000002', '11111111-1111-1111-1111-111111111111', 'c4444444-4444-4444-4444-444444444444', 'gst_filing', 'GSTR-3B Filing - Jan 2026', '2026-02-20', '2025-26', 'overdue', 'high', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', NOW() - INTERVAL '15 days', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
('t0000001-0000-0000-0000-000000000003', '11111111-1111-1111-1111-111111111111', 'c8888888-8888-8888-8888-888888888888', 'tds_deposit', 'TDS Deposit - Jan 2026', '2026-02-07', '2025-26', 'overdue', 'critical', 'dddddddd-dddd-dddd-dddd-dddddddddddd', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', NOW() - INTERVAL '20 days', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),

-- DUE THIS WEEK
('t0000001-0000-0000-0000-000000000004', '11111111-1111-1111-1111-111111111111', 'c1111111-1111-1111-1111-111111111111', 'advance_tax', 'Advance Tax Q4 Final', '2026-03-15', '2025-26', 'pending', 'high', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', NOW() - INTERVAL '5 days', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
('t0000001-0000-0000-0000-000000000005', '11111111-1111-1111-1111-111111111111', 'c2222222-2222-2222-2222-222222222222', 'gst_filing', 'GSTR-1 Filing - Feb 2026', '2026-03-10', '2025-26', 'in_progress', 'high', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', NOW() - INTERVAL '3 days', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
('t0000001-0000-0000-0000-000000000006', '11111111-1111-1111-1111-111111111111', 'c5555555-5555-5555-5555-555555555555', 'advance_tax', 'Advance Tax Q4 Final', '2026-03-15', '2025-26', 'pending', 'medium', 'dddddddd-dddd-dddd-dddd-dddddddddddd', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', NOW() - INTERVAL '2 days', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
('t0000001-0000-0000-0000-000000000007', '11111111-1111-1111-1111-111111111111', 'c6666666-6666-6666-6666-666666666666', 'tds_deposit', 'TDS Deposit - Feb 2026', '2026-03-07', '2025-26', 'pending', 'high', 'dddddddd-dddd-dddd-dddd-dddddddddddd', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', NOW() - INTERVAL '1 day', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),

-- UNASSIGNED
('t0000001-0000-0000-0000-000000000008', '11111111-1111-1111-1111-111111111111', 'c3333333-3333-3333-3333-333333333333', 'itr_filing', 'ITR Filing FY 2025-26', '2026-07-31', '2025-26', 'unassigned', 'medium', NULL, NULL, NULL, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
('t0000001-0000-0000-0000-000000000009', '11111111-1111-1111-1111-111111111111', 'c7777777-7777-7777-7777-777777777777', 'itr_filing', 'ITR Filing FY 2025-26', '2026-07-31', '2025-26', 'unassigned', 'low', NULL, NULL, NULL, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
('t0000001-0000-0000-0000-000000000010', '11111111-1111-1111-1111-111111111111', 'c4444444-4444-4444-4444-444444444444', 'tds_return', 'TDS Return Q3 FY 2025-26', '2026-01-31', '2025-26', 'unassigned', 'high', NULL, NULL, NULL, 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),

-- COMPLETED
('t0000001-0000-0000-0000-000000000011', '11111111-1111-1111-1111-111111111111', 'c1111111-1111-1111-1111-111111111111', 'advance_tax', 'Advance Tax Q3 (75%)', '2025-12-15', '2025-26', 'done', 'high', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', NOW() - INTERVAL '30 days', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
('t0000001-0000-0000-0000-000000000012', '11111111-1111-1111-1111-111111111111', 'c2222222-2222-2222-2222-222222222222', 'gst_filing', 'GSTR-3B Filing - Dec 2025', '2026-01-20', '2025-26', 'done', 'medium', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', NOW() - INTERVAL '40 days', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
('t0000001-0000-0000-0000-000000000013', '11111111-1111-1111-1111-111111111111', 'c8888888-8888-8888-8888-888888888888', 'gst_filing', 'GSTR-1 Filing - Dec 2025', '2026-01-10', '2025-26', 'done', 'medium', 'dddddddd-dddd-dddd-dddd-dddddddddddd', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', NOW() - INTERVAL '45 days', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
('t0000001-0000-0000-0000-000000000014', '11111111-1111-1111-1111-111111111111', 'c5555555-5555-5555-5555-555555555555', 'advance_tax', 'Advance Tax Q3 (75%)', '2025-12-15', '2025-26', 'done', 'medium', 'dddddddd-dddd-dddd-dddd-dddddddddddd', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', NOW() - INTERVAL '28 days', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa');

-- Update completed_at for done tasks
UPDATE compliance_tasks SET completed_at = created_at + INTERVAL '3 days', completed_by = assigned_to WHERE status = 'done';

-- Demo activity logs
INSERT INTO activity_logs (tenant_id, user_id, action, entity_type, metadata) VALUES
('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 'user.login', 'user', '{"ip":"192.168.1.1"}'),
('11111111-1111-1111-1111-111111111111', 'cccccccc-cccc-cccc-cccc-cccccccccccc', 'task.completed', 'task', '{"title":"GSTR-3B Dec 2025"}'),
('11111111-1111-1111-1111-111111111111', 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', 'client.created', 'client', '{"name":"Galaxy Pharma"}'),
('11111111-1111-1111-1111-111111111111', 'dddddddd-dddd-dddd-dddd-dddddddddddd', 'task.completed', 'task', '{"title":"ITR Q3 Advance Tax"}');

-- Demo notifications
INSERT INTO notifications (tenant_id, recipient_user_id, title, body, channel) VALUES
('11111111-1111-1111-1111-111111111111', 'cccccccc-cccc-cccc-cccc-cccccccccccc', '🔴 Task Overdue', 'TDS Deposit for Sunrise Traders is overdue', 'in_app'),
('11111111-1111-1111-1111-111111111111', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', '⚠️ 3 tasks unassigned', 'Please assign ITR filings for Q1', 'in_app'),
('11111111-1111-1111-1111-111111111111', 'dddddddd-dddd-dddd-dddd-dddddddddddd', '📅 Due in 7 days', 'TDS Deposit for Patna Real Estate due Mar 7', 'in_app');
