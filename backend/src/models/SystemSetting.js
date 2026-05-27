'use strict';

// 通用 key-value 系统设置表，所有值统一使用 JSON 字符串存储
module.exports = (sequelize, DataTypes) =>
  sequelize.define(
    'SystemSetting',
    {
      key: { type: DataTypes.STRING(64), primaryKey: true },
      value: { type: DataTypes.TEXT, allowNull: false, defaultValue: 'null' },
      description: { type: DataTypes.STRING(255), defaultValue: '' },
    },
    { tableName: 'system_settings', timestamps: true }
  );
