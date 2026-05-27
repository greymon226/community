'use strict';

module.exports = (sequelize, DataTypes) =>
  sequelize.define(
    'PostTag',
    {
      postId: { type: DataTypes.INTEGER, primaryKey: true },
      tagId: { type: DataTypes.INTEGER, primaryKey: true },
    },
    { tableName: 'post_tags', timestamps: false }
  );
