const { pool } = require('../db/pool');

class AppError extends Error {
  constructor(message, statusCode = 500, code = 'INTERNAL_ERROR') {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.isOperational = true;
  }
}

const errorHandler = async (err, req, res, next) => {
  const statusCode = err.statusCode || 500;

  console.error(`[ERROR] ${req.method} ${req.path} ${statusCode} - ${err.message}`);

  // Save to DB for errors >= 500 (non-blocking)
  if (statusCode >= 500) {
    pool.query(
      `INSERT INTO error_logs (tenant_id, user_id, level, message, stack_trace, endpoint, method, status_code, error_code)
       VALUES ($1,$2,'error',$3,$4,$5,$6,$7,$8)`,
      [req.tenantId || null, req.user?.id || null, err.message, err.stack,
       req.path, req.method, statusCode, err.code || 'INTERNAL_ERROR']
    ).catch(() => {}); // never crash on log failure
  }

  res.status(statusCode).json({
    error: {
      message: err.isOperational ? err.message : 'An internal error occurred',
      code: err.code || 'INTERNAL_ERROR',
    }
  });
};

module.exports = { errorHandler, AppError };
