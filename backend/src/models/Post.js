'use strict';

module.exports = (sequelize, DataTypes) =>
  sequelize.define(
    'Post',
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      title: { type: DataTypes.STRING(255), allowNull: false },
      // 富文本（HTML/Markdown），由前端编辑器渲染
      content: { type: DataTypes.TEXT('long'), allowNull: false },
      // 摘要，供列表展示
      summary: { type: DataTypes.STRING(500), defaultValue: '' },
      authorId: { type: DataTypes.INTEGER, allowNull: false },
      categoryId: { type: DataTypes.INTEGER, allowNull: false },
      // draft / published / deleted / blocked
      status: { type: DataTypes.STRING(20), defaultValue: 'published' },
      viewCount: { type: DataTypes.INTEGER, defaultValue: 0 },
      likeCount: { type: DataTypes.INTEGER, defaultValue: 0 },
      commentCount: { type: DataTypes.INTEGER, defaultValue: 0 },
      favoriteCount: { type: DataTypes.INTEGER, defaultValue: 0 },
      // 0=普通 1=板块置顶 2=全站置顶
      pinned: { type: DataTypes.INTEGER, defaultValue: 0 },
      featured: { type: DataTypes.BOOLEAN, defaultValue: false },
      // AI 审核结果：pass / review / blocked
      aiAuditStatus: { type: DataTypes.STRING(20), defaultValue: 'pass' },
      aiAuditReason: { type: DataTypes.STRING(255), defaultValue: '' },
    },
    {
      tableName: 'posts',
      timestamps: true,
      indexes: [
        { fields: ['categoryId'] },
        { fields: ['authorId'] },
        { fields: ['status'] },
        { fields: ['pinned'] },
      ],
    }
  );
