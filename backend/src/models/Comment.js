'use strict';

module.exports = (sequelize, DataTypes) =>
  sequelize.define(
    'Comment',
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      postId: { type: DataTypes.INTEGER, allowNull: false },
      authorId: { type: DataTypes.INTEGER, allowNull: false },
      content: { type: DataTypes.TEXT, allowNull: false },
      // 引用回复的目标评论
      replyToId: { type: DataTypes.INTEGER, allowNull: true },
      likeCount: { type: DataTypes.INTEGER, defaultValue: 0 },
      // active / deleted / blocked
      status: { type: DataTypes.STRING(20), defaultValue: 'active' },
    },
    {
      tableName: 'comments',
      timestamps: true,
      indexes: [{ fields: ['postId'] }, { fields: ['authorId'] }],
    }
  );
