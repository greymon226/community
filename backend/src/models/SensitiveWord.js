'use strict';

module.exports = (sequelize, DataTypes) =>
  sequelize.define(
    'SensitiveWord',
    {
      id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
      word: { type: DataTypes.STRING(64), unique: true, allowNull: false },
      // mask=替换为 *  block=拒绝发布  review=进入人工审核
      strategy: { type: DataTypes.STRING(20), defaultValue: 'mask' },
    },
    { tableName: 'sensitive_words', timestamps: true }
  );
