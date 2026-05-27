'use strict';

module.exports = (sequelize, DataTypes) =>
  sequelize.define(
    'Favorite',
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      userId: { type: DataTypes.INTEGER, allowNull: false },
      postId: { type: DataTypes.INTEGER, allowNull: false },
    },
    {
      tableName: 'favorites',
      timestamps: true,
      indexes: [{ unique: true, fields: ['userId', 'postId'] }, { fields: ['postId'] }],
    }
  );
