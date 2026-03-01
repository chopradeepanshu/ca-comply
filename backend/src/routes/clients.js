const router = require('express').Router();
const multer = require('multer');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { pool } = require('../db/pool');
const { authenticate, requireRole } = require('../middleware/auth');

const avatarStorage = multer.diskStorage({
  destination: path.join(__dirname, '../../uploads'),
  filename: (req, file, cb) => cb(null, `avatar-${uuidv4()}${path.extname(file.originalname)}`),
});
const avatarUpload = multer({ storage: avatarStorage, limits: { fileSize: 5 * 1024 * 1024 }, fileFilter: (req, file, cb) => cb(null, file.mimetype.startsWith('image/')) });

router.use(authenticate);

// GET /api/clients
router.get('/', async (req, res, next) => {
  try {
    const { search, page = 1, limit = 50, clientType } = req.query;
    const params = [req.tenantId];
    let conditions = ['c.tenant_id = $1', 'c.deleted_at IS NULL'];
    let idx = 2;

    if (search) {
      conditions.push(`(c.full_name ILIKE $${idx} OR c.client_code ILIKE $${idx} OR c.pan_number ILIKE $${idx})`);
      params.push(`%${search}%`); idx++;
    }
    if (clientType) { conditions.push(`c.client_type = $${idx++}`); params.push(clientType); }

    const offset = (parseInt(page) - 1) * parseInt(limit);
    const where = conditions.join(' AND ');

    const [rows, count] = await Promise.all([
      pool.query(`
        SELECT c.*, u.full_name AS manager_name,
               COUNT(ct.id) AS total_tasks,
               COUNT(ct.id) FILTER (WHERE ct.status='overdue') AS overdue_tasks,
               COUNT(ct.id) FILTER (WHERE ct.status NOT IN ('done','cancelled')) AS active_tasks
        FROM clients c
        LEFT JOIN users u ON u.id = c.assigned_manager_id
        LEFT JOIN compliance_tasks ct ON ct.client_id = c.id
        WHERE ${where}
        GROUP BY c.id, u.full_name
        ORDER BY c.full_name ASC
        LIMIT $${idx} OFFSET $${idx+1}
      `, [...params, parseInt(limit), offset]),
      pool.query(`SELECT COUNT(*) FROM clients c WHERE ${where}`, params),
    ]);

    res.json({
      clients: rows.rows,
      pagination: { page: parseInt(page), limit: parseInt(limit), total: parseInt(count.rows[0].count) }
    });
  } catch (err) { next(err); }
});

// GET /api/clients/:id
router.get('/:id', async (req, res, next) => {
  try {
    const [client, tasks, docs] = await Promise.all([
      pool.query(`
        SELECT c.*, u.full_name AS manager_name
        FROM clients c LEFT JOIN users u ON u.id = c.assigned_manager_id
        WHERE c.id = $1 AND c.tenant_id = $2 AND c.deleted_at IS NULL
      `, [req.params.id, req.tenantId]),
      pool.query(`
        SELECT ct.*, u.full_name AS assigned_to_name
        FROM compliance_tasks ct LEFT JOIN users u ON u.id = ct.assigned_to
        WHERE ct.client_id = $1 ORDER BY ct.due_date ASC
      `, [req.params.id]),
      pool.query(`SELECT * FROM documents WHERE client_id=$1 AND deleted_at IS NULL ORDER BY created_at DESC`, [req.params.id]),
    ]);

    if (!client.rows.length) return res.status(404).json({ error: 'Client not found' });
    res.json({ client: client.rows[0], tasks: tasks.rows, documents: docs.rows });
  } catch (err) { next(err); }
});

// POST /api/clients
router.post('/', requireRole('partner', 'manager'), async (req, res, next) => {
  try {
    const { fullName, clientType = 'individual', email, phone, panNumber, gstNumber, city, state, assignedManagerId, itrApplicable = true, gstApplicable = false, tdsApplicable = false, advanceTaxApplicable = false, notes } = req.body;
    if (!fullName) return res.status(400).json({ error: 'fullName is required' });

    // Check max clients limit
    const count = await pool.query('SELECT COUNT(*) FROM clients WHERE tenant_id=$1 AND deleted_at IS NULL', [req.tenantId]);
    const tenant = await pool.query('SELECT max_clients FROM tenants WHERE id=$1', [req.tenantId]);
    if (parseInt(count.rows[0].count) >= tenant.rows[0].max_clients) {
      return res.status(403).json({ error: `Client limit reached (${tenant.rows[0].max_clients}). Please upgrade your plan.` });
    }

    const result = await pool.query(`
      INSERT INTO clients (tenant_id, client_code, full_name, client_type, email, phone, pan_number, gst_number, city, state, assigned_manager_id, itr_applicable, gst_applicable, tds_applicable, advance_tax_applicable, notes, created_by)
      VALUES ($1,'TEMP',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
      RETURNING *
    `, [req.tenantId, fullName, clientType, email, phone, panNumber, gstNumber, city, state, assignedManagerId || req.user.id, itrApplicable, gstApplicable, tdsApplicable, advanceTaxApplicable, notes, req.user.id]);

    await pool.query(`INSERT INTO activity_logs (tenant_id, user_id, action, entity_type, entity_id) VALUES ($1,$2,'client.created','client',$3)`, [req.tenantId, req.user.id, result.rows[0].id]);
    res.status(201).json({ client: result.rows[0] });
  } catch (err) { next(err); }
});

// PATCH /api/clients/:id
router.patch('/:id', requireRole('partner', 'manager'), async (req, res, next) => {
  try {
    const { fullName, email, phone, panNumber, gstNumber, city, state, assignedManagerId, isActive, notes, itrApplicable, gstApplicable, tdsApplicable, advanceTaxApplicable } = req.body;
    const result = await pool.query(`
      UPDATE clients SET
        full_name = COALESCE($1, full_name), email = COALESCE($2, email), phone = COALESCE($3, phone),
        pan_number = COALESCE($4, pan_number), gst_number = COALESCE($5, gst_number),
        city = COALESCE($6, city), state = COALESCE($7, state),
        assigned_manager_id = COALESCE($8, assigned_manager_id),
        is_active = COALESCE($9, is_active), notes = COALESCE($10, notes),
        itr_applicable = COALESCE($11, itr_applicable), gst_applicable = COALESCE($12, gst_applicable),
        tds_applicable = COALESCE($13, tds_applicable), advance_tax_applicable = COALESCE($14, advance_tax_applicable),
        updated_at = NOW()
      WHERE id = $15 AND tenant_id = $16 AND deleted_at IS NULL RETURNING *
    `, [fullName, email, phone, panNumber, gstNumber, city, state, assignedManagerId, isActive, notes, itrApplicable, gstApplicable, tdsApplicable, advanceTaxApplicable, req.params.id, req.tenantId]);

    if (!result.rows.length) return res.status(404).json({ error: 'Client not found' });
    res.json({ client: result.rows[0] });
  } catch (err) { next(err); }
});

// POST /api/clients/:id/avatar
router.post('/:id/avatar', avatarUpload.single('avatar'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'No image uploaded' });
    const url = `/uploads/${req.file.filename}`;
    await pool.query('UPDATE clients SET avatar_url=$1, updated_at=NOW() WHERE id=$2 AND tenant_id=$3', [url, req.params.id, req.tenantId]);
    res.json({ avatar_url: url });
  } catch (err) { next(err); }
});

// DELETE /api/clients/:id
router.delete('/:id', requireRole('partner'), async (req, res, next) => {
  try {
    await pool.query('UPDATE clients SET deleted_at=NOW() WHERE id=$1 AND tenant_id=$2', [req.params.id, req.tenantId]);
    res.json({ message: 'Client removed' });
  } catch (err) { next(err); }
});

module.exports = router;
