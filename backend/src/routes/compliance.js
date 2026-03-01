const router = require('express').Router();
const { pool } = require('../db/pool');
const { authenticate, requireRole } = require('../middleware/auth');

router.use(authenticate);

// GET /api/compliance/tasks
router.get('/tasks', async (req, res, next) => {
  try {
    const { status, assignedTo, clientId, dueFrom, dueTo, complianceType, priority, page = 1, limit = 100, search } = req.query;
    const params = [req.tenantId];
    let cond = ['ct.tenant_id = $1'];
    let idx = 2;

    if (status && status !== 'all') { cond.push(`ct.status = $${idx++}`); params.push(status); }
    if (assignedTo) { cond.push(`ct.assigned_to = $${idx++}`); params.push(assignedTo); }
    if (clientId) { cond.push(`ct.client_id = $${idx++}`); params.push(clientId); }
    if (complianceType) { cond.push(`ct.compliance_type = $${idx++}`); params.push(complianceType); }
    if (priority) { cond.push(`ct.priority = $${idx++}`); params.push(priority); }
    if (dueFrom) { cond.push(`ct.due_date >= $${idx++}`); params.push(dueFrom); }
    if (dueTo) { cond.push(`ct.due_date <= $${idx++}`); params.push(dueTo); }
    if (search) { cond.push(`(c.full_name ILIKE $${idx} OR ct.title ILIKE $${idx})`); params.push(`%${search}%`); idx++; }
    if (req.user.role === 'staff') { cond.push(`ct.assigned_to = $${idx++}`); params.push(req.user.id); }

    const offset = (parseInt(page) - 1) * parseInt(limit);
    const where = cond.join(' AND ');

    const result = await pool.query(`
      SELECT ct.*,
             c.full_name AS client_name, c.client_code, c.client_type,
             u.full_name AS assigned_to_name,
             ab.full_name AS assigned_by_name,
             ct.due_date - CURRENT_DATE AS days_until_due,
             CURRENT_DATE - ct.due_date AS days_overdue
      FROM compliance_tasks ct
      JOIN clients c ON c.id = ct.client_id
      LEFT JOIN users u ON u.id = ct.assigned_to
      LEFT JOIN users ab ON ab.id = ct.assigned_by
      WHERE ${where}
      ORDER BY ct.due_date ASC, ct.priority DESC
      LIMIT $${idx} OFFSET $${idx+1}
    `, [...params, parseInt(limit), offset]);

    const countResult = await pool.query(`SELECT COUNT(*) FROM compliance_tasks ct JOIN clients c ON c.id=ct.client_id WHERE ${where}`, params);

    res.json({
      tasks: result.rows,
      pagination: { page: parseInt(page), total: parseInt(countResult.rows[0].count) }
    });
  } catch (err) { next(err); }
});

// POST /api/compliance/tasks
router.post('/tasks', requireRole('partner', 'manager'), async (req, res, next) => {
  try {
    const { clientId, complianceType, title, dueDate, assignedTo, priority = 'medium', financialYear = '2025-26', quarter, description } = req.body;
    if (!clientId || !complianceType || !title || !dueDate) {
      return res.status(400).json({ error: 'clientId, complianceType, title, dueDate are required' });
    }
    const result = await pool.query(`
      INSERT INTO compliance_tasks (tenant_id, client_id, compliance_type, title, description, due_date, financial_year, quarter, assigned_to, assigned_by, assigned_at, priority, status, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,CASE WHEN $9 IS NOT NULL THEN NOW() END,$11,
              CASE WHEN $9 IS NOT NULL THEN 'pending' ELSE 'unassigned' END,$12)
      RETURNING *
    `, [req.tenantId, clientId, complianceType, title, description, dueDate, financialYear, quarter, assignedTo || null, req.user.id, priority, req.user.id]);

    await pool.query(`INSERT INTO activity_logs (tenant_id, user_id, action, entity_type, entity_id) VALUES ($1,$2,'task.created','task',$3)`, [req.tenantId, req.user.id, result.rows[0].id]);
    res.status(201).json({ task: result.rows[0] });
  } catch (err) { next(err); }
});

// PATCH /api/compliance/tasks/:id/status
router.patch('/tasks/:id/status', async (req, res, next) => {
  try {
    const { status, notes } = req.body;
    const valid = ['pending', 'in_progress', 'review', 'done', 'cancelled'];
    if (!valid.includes(status)) return res.status(400).json({ error: 'Invalid status' });

    const existing = await pool.query('SELECT * FROM compliance_tasks WHERE id=$1 AND tenant_id=$2', [req.params.id, req.tenantId]);
    if (!existing.rows.length) return res.status(404).json({ error: 'Task not found' });
    if (req.user.role === 'staff' && existing.rows[0].assigned_to !== req.user.id) {
      return res.status(403).json({ error: 'Cannot update tasks not assigned to you' });
    }

    const result = await pool.query(`
      UPDATE compliance_tasks SET
        status = $1,
        completion_notes = CASE WHEN $1='done' THEN $2 ELSE completion_notes END,
        completed_at = CASE WHEN $1='done' THEN NOW() ELSE NULL END,
        completed_by = CASE WHEN $1='done' THEN $3 ELSE NULL END,
        updated_at = NOW()
      WHERE id = $4 AND tenant_id = $5 RETURNING *
    `, [status, notes, req.user.id, req.params.id, req.tenantId]);

    await pool.query(`INSERT INTO activity_logs (tenant_id, user_id, action, entity_type, entity_id, metadata) VALUES ($1,$2,$3,'task',$4,$5)`,
      [req.tenantId, req.user.id, `task.${status}`, req.params.id, JSON.stringify({ notes })]);
    res.json({ task: result.rows[0] });
  } catch (err) { next(err); }
});

// PATCH /api/compliance/tasks/:id/assign
router.patch('/tasks/:id/assign', requireRole('partner', 'manager'), async (req, res, next) => {
  try {
    const { assignedTo } = req.body;
    const result = await pool.query(`
      UPDATE compliance_tasks SET assigned_to=$1, assigned_by=$2, assigned_at=NOW(),
        status=CASE WHEN status='unassigned' THEN 'pending' ELSE status END, updated_at=NOW()
      WHERE id=$3 AND tenant_id=$4 RETURNING *
    `, [assignedTo, req.user.id, req.params.id, req.tenantId]);

    if (!result.rows.length) return res.status(404).json({ error: 'Task not found' });

    // Create notification
    await pool.query(`INSERT INTO notifications (tenant_id, recipient_user_id, task_id, title, body) VALUES ($1,$2,$3,$4,$5)`,
      [req.tenantId, assignedTo, req.params.id, 'New task assigned', `You have been assigned: ${result.rows[0].title}`]);

    res.json({ task: result.rows[0] });
  } catch (err) { next(err); }
});

// DELETE /api/compliance/tasks/:id
router.delete('/tasks/:id', requireRole('partner', 'manager'), async (req, res, next) => {
  try {
    await pool.query('UPDATE compliance_tasks SET status=$1,updated_at=NOW() WHERE id=$2 AND tenant_id=$3', ['cancelled', req.params.id, req.tenantId]);
    res.json({ message: 'Task cancelled' });
  } catch (err) { next(err); }
});

// GET /api/compliance/summary
router.get('/summary', async (req, res, next) => {
  try {
    const result = await pool.query(`
      SELECT
        COUNT(*) FILTER (WHERE status='overdue') AS overdue,
        COUNT(*) FILTER (WHERE status IN ('pending','in_progress') AND due_date BETWEEN CURRENT_DATE AND CURRENT_DATE+7) AS due_this_week,
        COUNT(*) FILTER (WHERE status='done' AND completed_at > NOW()-INTERVAL '30 days') AS completed_mtd,
        COUNT(*) FILTER (WHERE status='unassigned') AS unassigned
      FROM compliance_tasks WHERE tenant_id=$1
    `, [req.tenantId]);
    res.json(result.rows[0]);
  } catch (err) { next(err); }
});

module.exports = router;
