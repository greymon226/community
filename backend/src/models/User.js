'use strict';

module.exports = (sequelize, DataTypes) =>
  sequelize.define(
    'User',
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      // 工号（来自 CAS）
      empNo: { type: DataTypes.STRING(64), unique: true, allowNull: false },
      name: { type: DataTypes.STRING(64), allowNull: false },
      nickname: { type: DataTypes.STRING(64) },
      email: { type: DataTypes.STRING(128) },
      department: { type: DataTypes.STRING(128) },
      avatar: { type: DataTypes.STRING(255) },
      bio: { type: DataTypes.STRING(500), defaultValue: '' },
      // 技术标签，逗号分隔
      techTags: { type: DataTypes.STRING(500), defaultValue: '' },
      // user / moderator / admin
      role: { type: DataTypes.STRING(20), defaultValue: 'user' },
      // 版主管理的板块 ID 列表，JSON 字符串
      moderatorCategoryIds: { type: DataTypes.STRING(500), defaultValue: '[]' },
      // 邮件通知开关
      emailNotify: { type: DataTypes.BOOLEAN, defaultValue: false },
      // 仅本地 mock 登录使用
      passwordHash: { type: DataTypes.STRING(255) },
      lastLoginAt: { type: DataTypes.DATE },
      status: { type: DataTypes.STRING(20), defaultValue: 'active' }, // active / disabled
    },
    { tableName: 'users', timestamps: true }
  );
