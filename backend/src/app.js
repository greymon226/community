'use strict';

const path = require('path');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');
const rateLimit = require('express-rate-limit');

const config = require('./config');
const db = require('./models');
const cache = require('./services/cacheService');
const routes = require('./routes');
const { errorHandler, notFound } = require('./middlewares/error');

const app = express();

app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(express.urlencoded({ extended: true }));
app.use(morgan('dev'));

// 通用速率限制
app.use(
  '/api/',
  rateLimit({
    windowMs: 60 * 1000,
    max: 600,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

// 静态资源
app.use('/uploads', express.static(config.upload.dir));

// 健康检查
app.get('/health', (_req, res) => res.json({ ok: true, ts: Date.now() }));

// 业务路由
app.use('/api', routes);

// 错误处理
app.use(notFound);
app.use(errorHandler);

async function bootstrap() {
  try {
    await db.sequelize.authenticate();
    // 默认仅用 sync()（已存在的表不会变更）。如需根据模型变更增量更新表结构，
    // 可设置 DB_SYNC_ALTER=1 重启一次；不要在长期运行的环境长期开启 alter，
    // 否则 Sequelize 会反复追加唯一索引，最终触发 MySQL 'Too many keys' 报错。
    if (process.env.DB_SYNC_ALTER === '1') {
      await db.sequelize.sync({ alter: true });
    } else {
      await db.sequelize.sync();
    }
    await cache.init();

    app.listen(config.port, () => {
      console.log(`[community-backend] listening on http://localhost:${config.port}`);
      console.log(`[community-backend] db dialect: ${config.db.dialect}`);
      console.log(`[community-backend] CAS mode  : ${config.cas.mock ? 'MOCK (本地账号密码)' : 'REAL'}`);
    });
  } catch (err) {
    console.error('Bootstrap failed:', err);
    process.exit(1);
  }
}

if (require.main === module) {
  bootstrap();
}

module.exports = app;
