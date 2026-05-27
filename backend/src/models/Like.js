'use strict';

module.exports = (sequelize, DataTypes) =>
  sequelize.define(
    'Like',
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      userId: { type: DataTypes.INTEGER, allowNull: false },
      // 'post' 或 'comment'
      targetType: { type: DataTypes.STRING(20), allowNull: false },
      targetId: { type: DataTypes.INTEGER, allowNull: false },
    },
    {
      tableName: 'likes',
      timestamps: true,
      indexes: [
        { unique: true, fields: ['userId', 'targetType', 'targetId'] },
        { fields: ['targetType', 'targetId'] },
      ],
    }
  );
