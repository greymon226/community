'use strict';

module.exports = (sequelize, DataTypes) =>
  sequelize.define(
    'Report',
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      reporterId: { type: DataTypes.INTEGER, allowNull: false },
      // 'post' 或 'comment'
      targetType: { type: DataTypes.STRING(20), allowNull: false },
      targetId: { type: DataTypes.INTEGER, allowNull: false },
      reason: { type: DataTypes.STRING(255), allowNull: false },
      // pending / resolved / rejected
      status: { type: DataTypes.STRING(20), defaultValue: 'pending' },
      handledBy: { type: DataTypes.INTEGER, allowNull: true },
      handledAt: { type: DataTypes.DATE, allowNull: true },
      remark: { type: DataTypes.STRING(255), defaultValue: '' },
    },
    { tableName: 'reports', timestamps: true }
  );
