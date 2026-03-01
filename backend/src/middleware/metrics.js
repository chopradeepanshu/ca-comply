const { pool } = require('../db/pool');

const errorHandler = async (err, req, res, next) => {
  const statusCode = err.statusCode || 500;
  console.error(`[ERROR] ${req.method} ${req.path} - ${err.message}`);

  // Save to DB (non-blocking)
  if (statusCode >= 500) {
    pool.query(`
      INSERT INTO error_logs (tenant_id, user_id, level, message, stack_trace, endpoint, method, status_code, error_code)
      VALUES ($1,$2,'error',$3,$4,$5,$6,$7,$8)
    `, [
      req.tenantId || null, req.user?.id || null,
      err.message, err.stack, req.path, req.method, statusCode, err.code || 'INTERNAL_ERROR'
    ]).catch(() => {});
  }

  res.status(statusCode).json({
    error: {
      message: statusCode >= 500 && process.env.NODE_ENV === 'production'
        ? 'An internal error occurred'
        : err.message,
      code: err.code || 'INTERNAL_ERROR',
    }
  });
};

const requestLogger = (req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const dur = Date.now() - start;
    if (req.path !== '/api/health') {
      console.log(`${req.method} ${req.path} ${res.statusCode} ${dur}ms`);
    }

    // Track feature usage (fire & forget)
    if (req.user && res.statusCode < 400) {
      const featureMap = {
        '/api/compliance': 'compliance',
        '/api/clients': 'clients',
        '/api/documents': 'documents',
        '/api/dashboard': 'dashboard',
        '/api/analytics': 'analytics',
        '/api/users': 'settings',
        '/api/notifications': 'dashboard',
      };
      let feature = null;
      for (const [route, feat] of Object.entries(featureMap)) {
        if (req.path.startsWith(route)) { feature = feat; break; }
      }
      if (feature) {
        pool.query(
          'INSERT INTO feature_usage (tenant_id, user_id, feature, action, duration_ms) VALUES ($1,$2,$3,$4,$5)',
          [req.tenantId, req.user.id, feature, req.method.toLowerCase(), dur]
        ).catch(() => {});
      }
    }
  });
  next();
};

module.exports = { errorHandler, requestLogger };
