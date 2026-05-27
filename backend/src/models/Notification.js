'use strict';

module.exports = (sequelize, DataTypes) =>
  sequelize.define(
    'Notification',
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      userId: { type: DataTypes.INTEGER, allowNull: false }, // 接收者
      fromUserId: { type: DataTypes.INTEGER, allowNull: true }, // 触发者
      // commented / replied / liked / featured / pinned / system
      type: { type: DataTypes.STRING(32), allowNull: false },
      title: { type: DataTypes.STRING(255), allowNull: false },
      content: { type: DataTypes.STRING(500), defaultValue: '' },
      // 关联资源 { postId, commentId } JSON 字符串
      payload: { type: DataTypes.STRING(500), defaultValue: '{}' },
      read: { type: DataTypes.BOOLEAN, defaultValue: false },
    },
    {
      tableName: 'notifications',
      timestamps: true,
      indexes: [{ fields: ['userId', 'read'] }],
    }
  );
