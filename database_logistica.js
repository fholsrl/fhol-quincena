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
    tipo:         { type: DataTypes.STRING,  defaultValue: 'CONSUMIBLE' },
    activo:       { type: DataTypes.BOOLEAN, defaultValue: true }
}, { tableName: 'Productos', timestamps: false });

const Ubicacion = sequelize.define('Ubicacion', {
    nombre:         { type: DataTypes.STRING, allowNull: false },
    tipo_ubicacion: { type: DataTypes.STRING, defaultValue: 'DEPOSITO' }
}, { tableName: 'Ubicaciones', timestamps: false });

const Stock = sequelize.define('Stock', {
    cantidad:      { type: DataTypes.DECIMAL, defaultValue: 0 },
    stock_inicial: { type: DataTypes.DECIMAL, defaultValue: 0 }
}, { tableName: 'Stocks', timestamps: false });

const Movimiento = sequelize.define('Movimiento', {
    tipo:                 { type: DataTypes.STRING },
    cantidad:             { type: DataTypes.DECIMAL },
    ubicacion_origen_id:  { type: DataTypes.INTEGER, allowNull: true },
    ubicacion_destino_id: { type: DataTypes.INTEGER, allowNull: true },
    usuario:              { type: DataTypes.STRING },
    fecha:                { type: DataTypes.DATE, defaultValue: DataTypes.NOW },
    herramienta_id:       { type: DataTypes.INTEGER, allowNull: true }, // referencia si fue movimiento de herramienta
    nro_serie:            { type: DataTypes.STRING,  allowNull: true }  // copia del nro serie para el historial
}, { tableName: 'Movimientos', timestamps: false });

// Herramienta: instancia individual con número de serie (siempre RETORNABLE)
const Herramienta = sequelize.define('Herramienta', {
    nro_serie:    { type: DataTypes.STRING,  allowNull: false, unique: true },
    estado:       { type: DataTypes.STRING,  defaultValue: 'DISPONIBLE' }, // DISPONIBLE | EN_OBRA | REPARACION | BAJA
    observaciones:{ type: DataTypes.STRING,  allowNull: true }
}, { tableName: 'Herramientas', timestamps: false });

Producto.hasMany(Stock,        { foreignKey: 'productoId' });
Stock.belongsTo(Producto,      { foreignKey: 'productoId' });
Ubicacion.hasMany(Stock,       { foreignKey: 'ubicacionId' });
Stock.belongsTo(Ubicacion,     { foreignKey: 'ubicacionId' });
Producto.hasMany(Movimiento,   { foreignKey: 'productoId' });
Movimiento.belongsTo(Producto, { foreignKey: 'productoId' });
Producto.hasMany(Herramienta,  { foreignKey: 'productoId' });
Herramienta.belongsTo(Producto,{ foreignKey: 'productoId' });
Ubicacion.hasMany(Herramienta, { foreignKey: 'ubicacionId' });
Herramienta.belongsTo(Ubicacion,{ foreignKey: 'ubicacionId' });

module.exports = { sequelize, Producto, Ubicacion, Stock, Movimiento, Herramienta };
