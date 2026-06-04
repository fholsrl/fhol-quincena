const { Sequelize, DataTypes } = require('sequelize');

// CONFIGURACIÓN DESGLOSADA (Más segura y estable)
const sequelize = new Sequelize(process.env.DATABASE_URL || 'postgresql://postgres:FholMarzo2026@db.qqzmbnpwmmxvjxmixteb.supabase.co:5432/postgres', {
    dialect: 'postgres',
    logging: false,
    dialectOptions: {
        ssl: { require: true, rejectUnauthorized: false }
    }
});

// --- Modelos ---
const Usuario = sequelize.define('Usuario', {
    username: { type: DataTypes.STRING, unique: true, allowNull: false },
    password: { type: DataTypes.STRING, allowNull: false },
    rol:      { type: DataTypes.STRING, defaultValue: 'usuario' },
    modulos:  { type: DataTypes.STRING, defaultValue: 'PERSONAL,LOGISTICA' } // CSV de módulos habilitados
});

const Empleado = sequelize.define('Empleado', {
    nombre: { type: DataTypes.STRING, allowNull: false },
    apellido: { type: DataTypes.STRING, allowNull: false },
    obra: { type: DataTypes.STRING },
    activo: { type: DataTypes.BOOLEAN, defaultValue: true }
});

const Hora = sequelize.define('Hora', {
    fecha:         { type: DataTypes.DATEONLY, allowNull: false },
    cantidadHoras: { type: DataTypes.DECIMAL(10, 2), defaultValue: 0 },
    cargadoPor:    { type: DataTypes.STRING },
    estado:        { type: DataTypes.STRING, defaultValue: 'NORMAL' } // NORMAL | ENFERMO | LLUVIA
});

Empleado.hasMany(Hora);
Hora.belongsTo(Empleado);

module.exports = { sequelize, Empleado, Hora, Usuario };