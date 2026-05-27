'use strict';

module.exports = (sequelize, DataTypes) =>
  sequelize.define(
    'Category',
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      name: { type: DataTypes.STRING(64), allowNull: false },
      description: { type: DataTypes.STRING(255), defaultValue: '' },
      icon: { type: DataTypes.STRING(255), defaultValue: '' },
      parentId: { type: DataTypes.INTEGER, allowNull: true },
      sort: { type: DataTypes.INTEGER, defaultValue: 0 },
      // 可见权限：JSON 字符串 { departments: [], roles: [] }
      visibility: { type: DataTypes.STRING(500), defaultValue: '{}' },
      enabled: { type: DataTypes.BOOLEAN, defaultValue: true },
    },
    { tableName: 'categories', timestamps: true }
  );
