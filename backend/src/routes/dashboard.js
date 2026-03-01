const router = require('express').Router();
const { pool } = require('../db/pool');
const { authenticate } = require('../middleware/auth');

router.use(authenticate);

// GET /api/dashboard/stats
router.get('/stats', async (req, res, next) => {
  try {
    const tid = req.tenantId;
    const [tasks, clients, activity, upcoming] = await Promise.all([
      pool.query(`
        SELECT
          COUNT(*) FILTER (WHERE status = 'overdue') AS overdue,
          COUNT(*) FILTER (WHERE status IN ('pending','in_progress') AND due_date BETWEEN CURRENT_DATE AND CURRENT_DATE + 7) AS due_this_week,
          COUNT(*) FILTER (WHERE status = 'done' AND completed_at > NOW() - INTERVAL '30 days') AS completed_mtd,
          COUNT(*) FILTER (WHERE status = 'unassigned') AS unassigned,
          COUNT(*) FILTER (WHERE status NOT IN ('done','cancelled')) AS total_active,
          ROUND(COUNT(*) FILTER (WHERE status='done')*100.0/NULLIF(COUNT(*),0),1) AS completion_rate
        FROM compliance_tasks WHERE tenant_id = $1
      `, [tid]),
      pool.query(`SELECT COUNT(*) AS total FROM clients WHERE tenant_id=$1 AND deleted_at IS NULL AND is_active=true`, [tid]),
      pool.query(`
        SELECT al.action, al.metadata, al.created_at, u.full_name, u.role
        FROM activity_logs al LEFT JOIN users u ON u.id = al.user_id
        WHERE al.tenant_id = $1 ORDER BY al.created_at DESC LIMIT 10
      `, [tid]),
      pool.query(`
        SELECT ct.compliance_type, ct.due_date, ct.status, ct.priority, ct.title,
               c.full_name AS client_name, c.client_code,
               u.full_name AS assigned_to_name,
               ct.due_date - CURRENT_DATE AS days_until_due
        FROM compliance_tasks ct
        JOIN clients c ON c.id = ct.client_id
        LEFT JOIN users u ON u.id = ct.assigned_to
        WHERE ct.tenant_id = $1 AND ct.status NOT IN ('done','cancelled')
          AND ct.due_date <= CURRENT_DATE + 30
        ORDER BY ct.due_date ASC LIMIT 20
      `, [tid]),
    ]);

    res.json({
      stats: { ...tasks.rows[0], total_clients: clients.rows[0].total },
      recentActivity: activity.rows,
      upcomingDeadlines: upcoming.rows,
    });
  } catch (err) { next(err); }
});

// GET /api/dashboard/compliance-health
router.get('/compliance-health', async (req, res, next) => {
  try {
    const result = await pool.query(`
      SELECT
        c.id, c.full_name, c.client_code, c.client_type,
        COUNT(ct.id) AS total_tasks,
        COUNT(ct.id) FILTER (WHERE ct.status='done') AS completed,
        COUNT(ct.id) FILTER (WHERE ct.status='overdue') AS overdue,
        COUNT(ct.id) FILTER (WHERE ct.status NOT IN ('done','cancelled')) AS pending,
        CASE
          WHEN COUNT(ct.id) = 0 THEN 100
          ELSE ROUND(COUNT(ct.id) FILTER (WHERE ct.status='done')*100.0/NULLIF(COUNT(ct.id),0),0)
        END AS health_score
      FROM clients c
      LEFT JOIN compliance_tasks ct ON ct.client_id = c.id AND ct.financial_year = '2025-26'
      WHERE c.tenant_id = $1 AND c.deleted_at IS NULL AND c.is_active = true
      GROUP BY c.id, c.full_name, c.client_code, c.client_type
      ORDER BY overdue DESC, pending DESC
    `, [req.tenantId]);

    res.json({ clients: result.rows });
  } catch (err) { next(err); }
});

module.exports = router;
