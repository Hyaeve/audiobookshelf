const { DataTypes, Model } = require('sequelize')

class ChineseSearchIndex extends Model {
  static init(sequelize) {
    super.init(
      {
        libraryItemId: { type: DataTypes.UUID, primaryKey: true },
        libraryId: { type: DataTypes.UUID, allowNull: false },
        fingerprint: { type: DataTypes.STRING, allowNull: false },
        payload: { type: DataTypes.JSON, allowNull: false }
      },
      {
        sequelize,
        modelName: 'chineseSearchIndex',
        tableName: 'chineseSearchIndices',
        timestamps: true,
        indexes: [{ fields: ['libraryId', 'libraryItemId'] }]
      }
    )
  }
}

module.exports = ChineseSearchIndex
