const { Sequelize, DataTypes } = require('sequelize');

// REEMPLAZA ESTA URL con la que tenés en tu archivo 'database.js'
const sequelize = new Sequelize('postgres', 'postgres.qqzmbnpwmmxvjxmixteb', 'FholMarzo2026', {
    host: 'aws-0-us-west-2.pooler.supabase.com',
    port: 6543,
    dialect: 'postgres',
    logging: false,
    dialectOptions: {
        ssl: {
            require: true,
            rejectUnauthorized: false 
        }
    }
});
const Producto = sequelize.define('Producto', {
    nombre: { type: DataTypes.STRING, allowNull: false },
    unidad: { type: DataTypes.STRING, defaultValue: 'unidades' },
    stock_minimo: { type: DataTypes.DECIMAL, defaultValue: 0 },
    es_stockeable: { type: DataTypes.BOOLEAN, defaultValue: true }
}, { tableName: 'Productos' });

const Deposito = sequelize.define('Deposito', {
    nombre: { type: DataTypes.STRING, allowNull: false }
}, { tableName: 'Depositos' });

const Stock = sequelize.define('Stock', {
    cantidad: { type: DataTypes.DECIMAL, defaultValue: 0 }
}, { tableName: 'Stocks' });

const Movimiento = sequelize.define('Movimiento', {
    tipo: { type: DataTypes.STRING }, // 'INGRESO' o 'CONSUMO'
    cantidad: { type: DataTypes.DECIMAL },
    destino_obra: { type: DataTypes.STRING },
    usuario: { type: DataTypes.STRING },
    fecha: { type: DataTypes.DATE, defaultValue: DataTypes.NOW }
}, { tableName: 'Movimientos' });

// Relaciones exclusivas de logística
Producto.hasMany(Stock, { foreignKey: 'productoId' });
Stock.belongsTo(Producto, { foreignKey: 'productoId' });
Deposito.hasMany(Stock, { foreignKey: 'depositoId' });
Stock.belongsTo(Deposito, { foreignKey: 'depositoId' });

module.exports = { sequelize, Producto, Deposito, Stock, Movimiento };