'use strict';

module.exports = (sequelize, DataTypes) =>
  sequelize.define(
    'AuditLog',
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      operatorId: { type: DataTypes.INTEGER, allowNull: true },
      action: { type: DataTypes.STRING(64), allowNull: false },
      targetType: { type: DataTypes.STRING(32) },
      targetId: { type: DataTypes.INTEGER },
      detail: { type: DataTypes.TEXT, defaultValue: '' },
      ip: { type: DataTypes.STRING(64), defaultValue: '' },
    },
    { tableName: 'audit_logs', timestamps: true }
  );
