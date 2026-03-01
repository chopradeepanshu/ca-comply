require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const path = require('path');

const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const clientRoutes = require('./routes/clients');
const complianceRoutes = require('./routes/compliance');
const documentRoutes = require('./routes/documents');
const dashboardRoutes = require('./routes/dashboard');
const analyticsRoutes = require('./routes/analytics');
const notificationRoutes = require('./routes/notifications');
const healthRoutes = require('./routes/health');
const tenantRoutes = require('./routes/tenants');
const bankAnalysisRoutes = require('./routes/bank-analysis');

const { errorHandler } = require('./middleware/errorHandler');
const { requestLogger } = require('./middleware/metrics');

const app = express();
const PORT = process.env.PORT || 4000;

app.set('trust proxy', 1);

app.use(helmet({ contentSecurityPolicy: false }));
app.use(cors({
  origin: true,
  credentials: true,
}));
app.use(compression());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(requestLogger);

// Rate limiting
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 1000 });
app.use(limiter);

// Static uploads
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

// API Routes
app.use('/api/health', healthRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/users', userRoutes);
app.use('/api/clients', clientRoutes);
app.use('/api/compliance', complianceRoutes);
app.use('/api/documents', documentRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/tenants', tenantRoutes);
app.use('/api/bank-analysis', bankAnalysisRoutes);

// 404
app.use('/api/*', (req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

app.use(errorHandler);

// Start
async function start() {
  // Wait for DB
  const { pool } = require('./db/pool');
  let retries = 10;
  while (retries > 0) {
    try {
      await pool.query('SELECT 1');
      console.log('✅ Database connected');
      await pool.query('ALTER TABLE clients ADD COLUMN IF NOT EXISTS avatar_url TEXT');
      console.log('✅ Schema migrations applied');
      break;
    } catch (e) {
      retries--;
      console.log(`⏳ Waiting for database... (${retries} retries left)`);
      await new Promise(r => setTimeout(r, 3000));
    }
  }
  if (retries === 0) {
    console.error('❌ Could not connect to database. Exiting.');
    process.exit(1);
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 CA Comply API running on port ${PORT}`);
    console.log(`   Environment: ${process.env.NODE_ENV || 'development'}`);
  });
}

start();
