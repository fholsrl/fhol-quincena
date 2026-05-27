const { Sequelize, DataTypes } = require('sequelize');

const sequelize = new Sequelize(process.env.DATABASE_URL || 'postgresql://postgres:FholMarzo2026@db.qqzmbnpwmmxvjxmixteb.supabase.co:5432/postgres', {
    dialect: 'postgres',
    logging: false,
    dialectOptions: {
        ssl: { require: true, rejectUnauthorized: false }
    }
});

const Producto = sequelize.define('Producto', {
    nombre:       { type: DataTypes.STRING,  allowNull: false },
    unidad:       { type: DataTypes.STRING,  defaultValue: 'unidades' },
    stock_minimo: { type: DataTypes.DECIMAL, defaultValue: 0 },
    tipo:         { type: DataTypes.STRING,  defaultValue: 'CONSUMIBLE' }, // CONSUMIBLE | RETORNABLE | NO_STOCKEABLE
    activo:       { type: DataTypes.BOOLEAN, defaultValue: true }
}, { tableName: 'Productos' });

const Ubicacion = sequelize.define('Ubicacion', {
    nombre:         { type: DataTypes.STRING, allowNull: false },
    tipo_ubicacion: { type: DataTypes.STRING, defaultValue: 'DEPOSITO' } // DEPOSITO | OBRA
}, { tableName: 'Ubicaciones' });

// Stock: cantidad de cada producto en cada ubicación
// Solo existe mientras haya cantidad > 0 (consumibles se eliminan al consumirse)
const Stock = sequelize.define('Stock', {
    cantidad:      { type: DataTypes.DECIMAL, defaultValue: 0 },
    stock_inicial: { type: DataTypes.DECIMAL, defaultValue: 0 }
}, { tableName: 'Stocks' });

// Movimiento: historial completo de todo lo que pasó
const Movimiento = sequelize.define('Movimiento', {
    tipo:                 { type: DataTypes.STRING }, // INGRESO | CONSUMO | CONSUMO_DIRECTO | TRASLADO
    cantidad:             { type: DataTypes.DECIMAL },
    ubicacion_origen_id:  { type: DataTypes.INTEGER, allowNull: true },
    ubicacion_destino_id: { type: DataTypes.INTEGER, allowNull: true },
    usuario:              { type: DataTypes.STRING },
    fecha:                { type: DataTypes.DATE, defaultValue: DataTypes.NOW }
}, { tableName: 'Movimientos' });

Producto.hasMany(Stock,      { foreignKey: 'productoId' });
Stock.belongsTo(Producto,    { foreignKey: 'productoId' });
Ubicacion.hasMany(Stock,     { foreignKey: 'ubicacionId' });
Stock.belongsTo(Ubicacion,   { foreignKey: 'ubicacionId' });
Producto.hasMany(Movimiento, { foreignKey: 'productoId' });
Movimiento.belongsTo(Producto, { foreignKey: 'productoId' });

module.exports = { sequelize, Producto, Ubicacion, Stock, Movimiento };
