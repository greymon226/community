'use strict';

module.exports = (sequelize, DataTypes) =>
  sequelize.define(
    'Tag',
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      name: { type: DataTypes.STRING(64), unique: true, allowNull: false },
      usageCount: { type: DataTypes.INTEGER, defaultValue: 0 },
    },
    { tableName: 'tags', timestamps: true }
  );
