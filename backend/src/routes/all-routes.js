// ── USERS
const usersRouter = require('express').Router();
const bcrypt = require('bcryptjs');
const { pool } = require('../db/pool');
const { authenticate, requireRole } = require('../middleware/auth');

usersRouter.use(authenticate);

usersRouter.get('/', requireRole('partner', 'manager'), async (req, res, next) => {
  try {
    const result = await pool.query(`
      SELECT u.id, u.email, u.full_name, u.role, u.phone, u.is_active, u.last_login_at, u.created_at,
             COUNT(ct.id) AS assigned_tasks, COUNT(ct.id) FILTER (WHERE ct.status='overdue') AS overdue_tasks
      FROM users u LEFT JOIN compliance_tasks ct ON ct.assigned_to=u.id AND ct.status NOT IN ('done','cancelled')
      WHERE u.tenant_id=$1 AND u.deleted_at IS NULL
      GROUP BY u.id ORDER BY u.role, u.full_name
    `, [req.tenantId]);
    res.json({ users: result.rows });
  } catch (err) { next(err); }
});

usersRouter.post('/', requireRole('partner'), async (req, res, next) => {
  try {
    const { email, fullName, phone, role, password } = req.body;
    if (!email || !fullName || !password || !role) return res.status(400).json({ error: 'email, fullName, password, role required' });
    if (['partner','super_admin'].includes(role)) return res.status(403).json({ error: 'Cannot create partner role' });

    const [countR, tenantR, existsR] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM users WHERE tenant_id=$1 AND deleted_at IS NULL', [req.tenantId]),
      pool.query('SELECT max_users FROM tenants WHERE id=$1', [req.tenantId]),
      pool.query('SELECT id FROM users WHERE email=$1 AND tenant_id=$2 AND deleted_at IS NULL', [email, req.tenantId]),
    ]);

    if (existsR.rows.length) return res.status(409).json({ error: 'Email already in use' });
    if (parseInt(countR.rows[0].count) >= tenantR.rows[0].max_users) {
      return res.status(403).json({ error: `User limit reached (${tenantR.rows[0].max_users}). Please upgrade.` });
    }

    const hash = await bcrypt.hash(password, 12);
    const result = await pool.query(
      'INSERT INTO users (tenant_id,email,password_hash,full_name,phone,role) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id,email,full_name,role,created_at',
      [req.tenantId, email, hash, fullName, phone, role]
    );
    res.status(201).json({ user: result.rows[0] });
  } catch (err) { next(err); }
});

usersRouter.patch('/me', async (req, res, next) => {
  try {
    const { theme } = req.body;
    if (!['dark', 'light'].includes(theme)) {
      return res.status(400).json({ error: 'Invalid theme' });
    }
    const result = await pool.query(
      `UPDATE users
       SET preferences = preferences || $1::jsonb, updated_at = NOW()
       WHERE id = $2 AND deleted_at IS NULL
       RETURNING preferences`,
      [JSON.stringify({ theme }), req.user.id]
    );
    res.json({ preferences: result.rows[0].preferences });
  } catch (err) { next(err); }
});

usersRouter.patch('/:id', requireRole('partner'), async (req, res, next) => {
  try {
    const { fullName, phone, role, isActive } = req.body;
    if (role && ['partner','super_admin'].includes(role)) return res.status(403).json({ error: 'Cannot assign partner role' });
    const result = await pool.query(
      'UPDATE users SET full_name=COALESCE($1,full_name),phone=COALESCE($2,phone),role=COALESCE($3,role),is_active=COALESCE($4,is_active),updated_at=NOW() WHERE id=$5 AND tenant_id=$6 AND deleted_at IS NULL RETURNING id,email,full_name,role,is_active',
      [fullName, phone, role, isActive, req.params.id, req.tenantId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'User not found' });
    res.json({ user: result.rows[0] });
  } catch (err) { next(err); }
});

usersRouter.delete('/:id', requireRole('partner'), async (req, res, next) => {
  try {
    if (req.params.id === req.user.id) return res.status(400).json({ error: 'Cannot delete your own account' });
    await pool.query('UPDATE users SET deleted_at=NOW(),is_active=false WHERE id=$1 AND tenant_id=$2', [req.params.id, req.tenantId]);
    res.json({ message: 'User removed' });
  } catch (err) { next(err); }
});

usersRouter.get('/workload', requireRole('partner', 'manager'), async (req, res, next) => {
  try {
    const result = await pool.query(`
      SELECT u.id, u.full_name, u.role,
             COUNT(ct.id) AS total_tasks,
             COUNT(ct.id) FILTER (WHERE ct.status='overdue') AS overdue_tasks,
             COUNT(ct.id) FILTER (WHERE ct.status='in_progress') AS in_progress,
             COUNT(ct.id) FILTER (WHERE ct.due_date<=CURRENT_DATE+7 AND ct.status NOT IN ('done','cancelled')) AS due_this_week
      FROM users u LEFT JOIN compliance_tasks ct ON ct.assigned_to=u.id AND ct.status NOT IN ('done','cancelled','unassigned')
      WHERE u.tenant_id=$1 AND u.role IN ('manager','staff') AND u.deleted_at IS NULL AND u.is_active=true
      GROUP BY u.id, u.full_name, u.role ORDER BY total_tasks DESC
    `, [req.tenantId]);
    res.json({ workload: result.rows });
  } catch (err) { next(err); }
});

module.exports.usersRouter = usersRouter;

// ── DOCUMENTS
const documentsRouter = require('express').Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');

const uploadDir = path.join(__dirname, '../../uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const storage = multer.diskStorage({
  destination: uploadDir,
  filename: (req, file, cb) => cb(null, `${uuidv4()}-${file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_')}`),
});
const upload = multer({ storage, limits: { fileSize: 50 * 1024 * 1024 } });

documentsRouter.use(authenticate);

documentsRouter.get('/', async (req, res, next) => {
  try {
    const { clientId } = req.query;
    const params = [req.tenantId];
    let cond = ['tenant_id=$1', 'deleted_at IS NULL'];
    if (clientId) { cond.push(`client_id=$2`); params.push(clientId); }
    const result = await pool.query(
      `SELECT d.*, u.full_name AS uploaded_by_name FROM documents d LEFT JOIN users u ON u.id=d.uploaded_by WHERE ${cond.join(' AND ')} ORDER BY created_at DESC`,
      params
    );
    res.json({ documents: result.rows });
  } catch (err) { next(err); }
});

documentsRouter.post('/upload', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
    const { clientId, documentType = 'other', financialYear, notes } = req.body;
    if (!clientId) return res.status(400).json({ error: 'clientId required' });

    const result = await pool.query(
      'INSERT INTO documents (tenant_id, client_id, file_name, original_name, file_size, mime_type, document_type, financial_year, storage_path, uploaded_by, notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *',
      [req.tenantId, clientId, req.file.filename, req.file.originalname, req.file.size, req.file.mimetype, documentType, financialYear, `/uploads/${req.file.filename}`, req.user.id, notes]
    );
    res.status(201).json({ document: result.rows[0] });
  } catch (err) { next(err); }
});

documentsRouter.delete('/:id', async (req, res, next) => {
  try {
    await pool.query('UPDATE documents SET deleted_at=NOW() WHERE id=$1 AND tenant_id=$2', [req.params.id, req.tenantId]);
    res.json({ message: 'Document removed' });
  } catch (err) { next(err); }
});

module.exports.documentsRouter = documentsRouter;

// ── NOTIFICATIONS
const notifRouter = require('express').Router();
notifRouter.use(authenticate);

notifRouter.get('/', async (req, res, next) => {
  try {
    const result = await pool.query(
      'SELECT * FROM notifications WHERE recipient_user_id=$1 ORDER BY created_at DESC LIMIT 50',
      [req.user.id]
    );
    const unread = result.rows.filter(n => !n.is_read).length;
    res.json({ notifications: result.rows, unread });
  } catch (err) { next(err); }
});

notifRouter.patch('/read-all', async (req, res, next) => {
  try {
    await pool.query('UPDATE notifications SET is_read=true WHERE recipient_user_id=$1', [req.user.id]);
    res.json({ message: 'All marked as read' });
  } catch (err) { next(err); }
});

notifRouter.patch('/:id/read', async (req, res, next) => {
  try {
    await pool.query('UPDATE notifications SET is_read=true WHERE id=$1 AND recipient_user_id=$2', [req.params.id, req.user.id]);
    res.json({ message: 'Marked as read' });
  } catch (err) { next(err); }
});

module.exports.notifRouter = notifRouter;

// ── ANALYTICS
const analyticsRouter = require('express').Router();
analyticsRouter.use(authenticate);

analyticsRouter.get('/overview', async (req, res, next) => {
  try {
    const [tasks, clients, features, errors] = await Promise.all([
      pool.query(`SELECT COUNT(*) FILTER (WHERE status='overdue') AS overdue, COUNT(*) FILTER (WHERE status='done') AS completed, COUNT(*) AS total, ROUND(COUNT(*) FILTER (WHERE status='done')*100.0/NULLIF(COUNT(*),0),1) AS completion_rate FROM compliance_tasks WHERE tenant_id=$1`, [req.tenantId]),
      pool.query(`SELECT COUNT(*) AS total FROM clients WHERE tenant_id=$1 AND deleted_at IS NULL`, [req.tenantId]),
      pool.query(`SELECT feature, COUNT(*) AS uses, COUNT(DISTINCT user_id) AS users FROM feature_usage WHERE tenant_id=$1 AND created_at>NOW()-INTERVAL '30 days' GROUP BY feature ORDER BY uses DESC`, [req.tenantId]),
      pool.query(`SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE resolved=false) AS unresolved FROM error_logs WHERE tenant_id=$1 AND created_at>NOW()-INTERVAL '30 days'`, [req.tenantId]),
    ]);
    res.json({ compliance: tasks.rows[0], clients: clients.rows[0], featureUsage: features.rows, errors: errors.rows[0] });
  } catch (err) { next(err); }
});

analyticsRouter.get('/feature-usage', async (req, res, next) => {
  try {
    const result = await pool.query(`
      SELECT feature, action, COUNT(*) AS uses, COUNT(DISTINCT user_id) AS unique_users, AVG(duration_ms) AS avg_ms
      FROM feature_usage WHERE tenant_id=$1 AND created_at>NOW()-INTERVAL '30 days'
      GROUP BY feature, action ORDER BY uses DESC
    `, [req.tenantId]);
    res.json({ usage: result.rows });
  } catch (err) { next(err); }
});

analyticsRouter.get('/errors', requireRole('partner', 'manager'), async (req, res, next) => {
  try {
    const result = await pool.query(
      'SELECT id, level, message, endpoint, method, status_code, error_code, metadata, resolved, created_at FROM error_logs WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 100',
      [req.tenantId]
    );
    res.json({ errors: result.rows });
  } catch (err) { next(err); }
});

analyticsRouter.patch('/errors/:id/resolve', requireRole('partner', 'manager'), async (req, res, next) => {
  try {
    await pool.query('UPDATE error_logs SET resolved=true, resolved_at=NOW() WHERE id=$1 AND tenant_id=$2', [req.params.id, req.tenantId]);
    res.json({ message: 'Resolved' });
  } catch (err) { next(err); }
});

analyticsRouter.get('/activity', requireRole('partner', 'manager'), async (req, res, next) => {
  try {
    const result = await pool.query(`
      SELECT al.*, u.full_name AS user_name, u.role AS user_role
      FROM activity_logs al LEFT JOIN users u ON u.id=al.user_id
      WHERE al.tenant_id=$1 ORDER BY al.created_at DESC LIMIT 200
    `, [req.tenantId]);
    res.json({ activities: result.rows });
  } catch (err) { next(err); }
});

module.exports.analyticsRouter = analyticsRouter;

// ── HEALTH
const healthRouter = require('express').Router();
healthRouter.get('/', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));
healthRouter.get('/ready', async (req, res) => {
  try {
    const start = Date.now();
    await pool.query('SELECT 1');
    res.json({ status: 'ok', db: `${Date.now() - start}ms`, uptime: `${Math.round(process.uptime())}s` });
  } catch (e) {
    res.status(503).json({ status: 'error', db: 'unreachable' });
  }
});

module.exports.healthRouter = healthRouter;

// ── TENANTS
const tenantsRouter = require('express').Router();
tenantsRouter.use(authenticate);

tenantsRouter.get('/me', async (req, res, next) => {
  try {
    const result = await pool.query('SELECT * FROM tenants WHERE id=$1', [req.tenantId]);
    if (!result.rows.length) return res.status(404).json({ error: 'Not found' });
    res.json({ tenant: result.rows[0] });
  } catch (err) { next(err); }
});

tenantsRouter.patch('/me', requireRole('partner'), async (req, res, next) => {
  try {
    const { name, firmCity, icaiMembership, primaryColor } = req.body;
    const result = await pool.query(
      'UPDATE tenants SET name=COALESCE($1,name),firm_city=COALESCE($2,firm_city),icai_membership=COALESCE($3,icai_membership),primary_color=COALESCE($4,primary_color),updated_at=NOW() WHERE id=$5 RETURNING *',
      [name, firmCity, icaiMembership, primaryColor, req.tenantId]
    );
    res.json({ tenant: result.rows[0] });
  } catch (err) { next(err); }
});

module.exports.tenantsRouter = tenantsRouter;
