const jwt = require('jsonwebtoken');
const { pool } = require('../db/pool');

const authenticate = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'No token provided' });
    }
    const token = authHeader.split(' ')[1];
    let decoded;
    try {
      decoded = jwt.verify(token, process.env.JWT_SECRET || 'ca-comply-secret-key-2024');
    } catch (e) {
      return res.status(401).json({ error: e.name === 'TokenExpiredError' ? 'Token expired' : 'Invalid token' });
    }

    const result = await pool.query(`
      SELECT u.id, u.email, u.full_name, u.role, u.tenant_id, u.is_active,
             u.preferences,
             t.name AS tenant_name, t.tier, t.status AS tenant_status, t.slug,
             t.primary_color, t.logo_url, t.firm_city, t.max_users, t.max_clients
      FROM users u JOIN tenants t ON t.id = u.tenant_id
      WHERE u.id = $1 AND u.deleted_at IS NULL
    `, [decoded.userId]);

    if (!result.rows.length) return res.status(401).json({ error: 'User not found' });
    const user = result.rows[0];
    if (!user.is_active) return res.status(403).json({ error: 'Account deactivated' });
    if (user.tenant_status === 'suspended') return res.status(403).json({ error: 'Account suspended' });

    req.user = user;
    req.tenantId = user.tenant_id;
    next();
  } catch (err) {
    next(err);
  }
};

const requireRole = (...roles) => (req, res, next) => {
  const hierarchy = { super_admin: 100, partner: 80, manager: 60, staff: 40, client: 20 };
  const userLevel = hierarchy[req.user?.role] || 0;
  const required = Math.min(...roles.map(r => hierarchy[r] || 0));
  if (userLevel < required) {
    return res.status(403).json({ error: 'Insufficient permissions', required: roles });
  }
  next();
};

const requireTier = (...tiers) => (req, res, next) => {
  const order = { silver: 1, gold: 2, platinum: 3 };
  const userTier = order[req.user?.tier] || 0;
  const required = Math.min(...tiers.map(t => order[t] || 0));
  if (userTier < required) {
    return res.status(403).json({
      error: `This feature requires ${tiers[0]} plan or higher`,
      code: 'TIER_UPGRADE_REQUIRED',
      requiredTier: tiers[0],
      currentTier: req.user?.tier
    });
  }
  next();
};

module.exports = { authenticate, requireRole, requireTier };
