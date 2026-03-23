const { Sequelize, DataTypes } = require('sequelize');

// CONFIGURACIÓN DESGLOSADA (Más segura y estable)
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

// --- Modelos ---
const Usuario = sequelize.define('Usuario', {
    username: { type: DataTypes.STRING, unique: true, allowNull: false },
    password: { type: DataTypes.STRING, allowNull: false },
    rol: { type: DataTypes.STRING, defaultValue: 'admin' }
});

const Empleado = sequelize.define('Empleado', {
    nombre: { type: DataTypes.STRING, allowNull: false },
    apellido: { type: DataTypes.STRING, allowNull: false },
    obra: { type: DataTypes.STRING },
    activo: { type: DataTypes.BOOLEAN, defaultValue: true }
});

const Hora = sequelize.define('Hora', {
    fecha: { type: DataTypes.DATEONLY, allowNull: false },
    cantidadHoras: { type: DataTypes.DECIMAL(10, 2), defaultValue: 0 },
    cargadoPor: { type: DataTypes.STRING }
});

Empleado.hasMany(Hora);
Hora.belongsTo(Empleado);

module.exports = { sequelize, Empleado, Hora, Usuario };