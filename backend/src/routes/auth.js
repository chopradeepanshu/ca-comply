const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { pool } = require('../db/pool');
const { authenticate } = require('../middleware/auth');

const JWT_SECRET = process.env.JWT_SECRET || 'ca-comply-secret-key-2024';
const JWT_REFRESH = process.env.JWT_REFRESH_SECRET || 'ca-comply-refresh-key-2024';

function generateTokens(userId, tenantId) {
  return {
    accessToken: jwt.sign({ userId, tenantId }, JWT_SECRET, { expiresIn: '8h' }),
    refreshToken: jwt.sign({ userId, tenantId }, JWT_REFRESH, { expiresIn: '7d' }),
    expiresIn: 28800
  };
}

// POST /api/auth/login
router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required' });

    const result = await pool.query(`
      SELECT u.id, u.email, u.password_hash, u.full_name, u.role, u.tenant_id, u.is_active,
             t.name AS tenant_name, t.tier, t.status AS tenant_status, t.slug, t.primary_color
      FROM users u JOIN tenants t ON t.id = u.tenant_id
      WHERE u.email = $1 AND u.deleted_at IS NULL LIMIT 1
    `, [email.toLowerCase().trim()]);

    if (!result.rows.length) return res.status(401).json({ error: 'Invalid email or password' });
    const user = result.rows[0];

    if (!user.is_active) return res.status(403).json({ error: 'Account deactivated' });

    const valid = await bcrypt.compare(password, user.password_hash);
    if (!valid) return res.status(401).json({ error: 'Invalid email or password' });

    await pool.query('UPDATE users SET last_login_at = NOW() WHERE id = $1', [user.id]);
    await pool.query(`
      INSERT INTO activity_logs (tenant_id, user_id, action, metadata) VALUES ($1,$2,'user.login',$3)
    `, [user.tenant_id, user.id, JSON.stringify({ ip: req.ip })]);

    delete user.password_hash;
    const tokens = generateTokens(user.id, user.tenant_id);
    res.json({ user, ...tokens });
  } catch (err) { next(err); }
});

// POST /api/auth/register-firm
router.post('/register-firm', async (req, res, next) => {
  try {
    const { firmName, firmCity, icaiMembership, adminName, adminEmail, adminPhone, password, tier = 'silver' } = req.body;
    if (!firmName || !adminEmail || !password || !adminName) {
      return res.status(400).json({ error: 'firmName, adminName, adminEmail, password are required' });
    }

    const slug = firmName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 40)
      + '-' + Date.now().toString(36);

    const tierLimits = { silver: [10, 50], gold: [9999, 200], platinum: [9999, 9999] };
    const [maxU, maxC] = tierLimits[tier] || [10, 50];

    // Check email
    const exists = await pool.query('SELECT id FROM users WHERE email = $1', [adminEmail]);
    if (exists.rows.length) return res.status(409).json({ error: 'Email already registered' });

    const hash = await bcrypt.hash(password, 12);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const t = await client.query(`
        INSERT INTO tenants (name, slug, tier, status, firm_city, icai_membership, billing_email, max_users, max_clients)
        VALUES ($1,$2,$3,'trial',$4,$5,$6,$7,$8) RETURNING *
      `, [firmName, slug, tier, firmCity, icaiMembership, adminEmail, maxU, maxC]);

      const u = await client.query(`
        INSERT INTO users (tenant_id, email, password_hash, full_name, phone, role)
        VALUES ($1,$2,$3,$4,$5,'partner') RETURNING id, email, full_name, role
      `, [t.rows[0].id, adminEmail, hash, adminName, adminPhone]);

      await client.query('COMMIT');
      const tokens = generateTokens(u.rows[0].id, t.rows[0].id);
      res.status(201).json({ tenant: t.rows[0], user: u.rows[0], ...tokens });
    } catch (e) { await client.query('ROLLBACK'); throw e; }
    finally { client.release(); }
  } catch (err) { next(err); }
});

// POST /api/auth/refresh
router.post('/refresh', async (req, res, next) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) return res.status(401).json({ error: 'Refresh token required' });
    const decoded = jwt.verify(refreshToken, JWT_REFRESH);
    const r = await pool.query('SELECT id, tenant_id, is_active FROM users WHERE id = $1', [decoded.userId]);
    if (!r.rows.length || !r.rows[0].is_active) return res.status(401).json({ error: 'Invalid token' });
    res.json(generateTokens(decoded.userId, r.rows[0].tenant_id));
  } catch (e) { res.status(401).json({ error: 'Invalid or expired refresh token' }); }
});

// GET /api/auth/me
router.get('/me', authenticate, (req, res) => res.json({ user: req.user }));

module.exports = router;
