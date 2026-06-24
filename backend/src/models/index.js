'use strict';

const fs = require('fs');
const path = require('path');
const { Sequelize, DataTypes } = require('sequelize');
const config = require('../config');

let sequelize;
if (config.db.dialect === 'sqlite') {
  // 单机模式：使用 sqlite。需要先安装 sqlite3 (npm i sqlite3)
  try {
    require.resolve('sqlite3');
  } catch (e) {
    throw new Error(
      '使用 sqlite 时需要先安装 sqlite3：npm i sqlite3。或将 DB_DIALECT 改为 mysql 后通过 docker compose up -d 启动 MySQL。'
    );
  }
  const storage = config.db.storage;
  fs.mkdirSync(path.dirname(storage), { recursive: true });
  sequelize = new Sequelize({
    dialect: 'sqlite',
    storage,
    logging: false,
    pool: { max: 1, min: 0, idle: 10000 },
  });
} else {
  // 默认 mysql：mysql2 驱动是纯 JS，无需本地编译
  sequelize = new Sequelize(config.db.name, config.db.user, config.db.pass, {
    host: config.db.host,
    port: config.db.port,
    dialect: 'mysql',
    dialectOptions: { charset: 'utf8mb4' },
    logging: false,
    pool: { max: 20, min: 0, idle: 10000 },
  });
}

const db = { sequelize, Sequelize, DataTypes };

// 注册模型
const modelFiles = [
  'User',
  'Category',
  'Post',
  'Comment',
  'Like',
  'Favorite',
  'Tag',
  'PostTag',
  'Notification',
  'Report',
  'AuditLog',
  'SensitiveWord',
  'SystemSetting',
];

for (const file of modelFiles) {
  const define = require(`./${file}`);
  const model = define(sequelize, DataTypes);
  db[model.name] = model;
}

// 关联关系
const {
  User,
  Category,
  Post,
  Comment,
  Like,
  Favorite,
  Tag,
  PostTag,
  Notification,
  Report,
  AuditLog,
} = db;

Category.hasMany(Category, { as: 'children', foreignKey: 'parentId' });
Category.belongsTo(Category, { as: 'parent', foreignKey: 'parentId' });

User.hasMany(Post, { foreignKey: 'authorId', as: 'posts' });
Post.belongsTo(User, { foreignKey: 'authorId', as: 'author' });

Category.hasMany(Post, { foreignKey: 'categoryId', as: 'posts' });
Post.belongsTo(Category, { foreignKey: 'categoryId', as: 'category' });

Post.hasMany(Comment, { foreignKey: 'postId', as: 'comments' });
Comment.belongsTo(Post, { foreignKey: 'postId', as: 'post' });

User.hasMany(Comment, { foreignKey: 'authorId', as: 'comments' });
Comment.belongsTo(User, { foreignKey: 'authorId', as: 'author' });

// 评论引用回复
Comment.belongsTo(Comment, { foreignKey: 'replyToId', as: 'replyTo' });

// 点赞 (多态: postId 或 commentId)
User.hasMany(Like, { foreignKey: 'userId' });
Like.belongsTo(User, { foreignKey: 'userId', as: 'user' });

// 收藏
User.hasMany(Favorite, { foreignKey: 'userId' });
Favorite.belongsTo(User, { foreignKey: 'userId', as: 'user' });
Post.hasMany(Favorite, { foreignKey: 'postId' });
Favorite.belongsTo(Post, { foreignKey: 'postId', as: 'post' });

// 标签
Post.belongsToMany(Tag, { through: PostTag, foreignKey: 'postId', as: 'tags' });
Tag.belongsToMany(Post, { through: PostTag, foreignKey: 'tagId', as: 'posts' });

// 通知
User.hasMany(Notification, { foreignKey: 'userId', as: 'notifications' });
Notification.belongsTo(User, { foreignKey: 'userId', as: 'recipient' });
Notification.belongsTo(User, { foreignKey: 'fromUserId', as: 'fromUser' });

// 举报
Report.belongsTo(User, { foreignKey: 'reporterId', as: 'reporter' });

// 审计日志
AuditLog.belongsTo(User, { foreignKey: 'operatorId', as: 'operator' });

module.exports = db;
