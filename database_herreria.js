const { Sequelize, DataTypes } = require('sequelize');

const sequelize = new Sequelize(process.env.DATABASE_URL || 'postgresql://postgres:FholMarzo2026@db.qqzmbnpwmmxvjxmixteb.supabase.co:5432/postgres', {
    dialect: 'postgres', logging: false,
    dialectOptions: { ssl: { require: true, rejectUnauthorized: false } }
});

// ── Proyecto ─────────────────────────────────────────────────────────────────
const Proyecto = sequelize.define('ProyectoHerreria', {
    nombre:       { type: DataTypes.STRING,  allowNull: false },
    cliente:      { type: DataTypes.STRING,  allowNull: true  },
    responsable:  { type: DataTypes.STRING,  allowNull: true  },
    notas:        { type: DataTypes.TEXT,    allowNull: true  },
    estado:       { type: DataTypes.STRING,  defaultValue: 'BORRADOR' },
    // BORRADOR | ACTIVO | PAUSADO | TERMINADO
    creadoPor:    { type: DataTypes.STRING,  allowNull: true  },
    activadoEn:   { type: DataTypes.DATE,    allowNull: true  },
    pausadoEn:    { type: DataTypes.DATE,    allowNull: true  },
    terminadoEn:  { type: DataTypes.DATE,    allowNull: true  },
    diasHabilesTotales: { type: DataTypes.INTEGER, defaultValue: 0 },
    bufferDias:   { type: DataTypes.INTEGER, defaultValue: 0  },
}, { tableName: 'ProyectosHerreria', timestamps: true });

// ── Tarea ─────────────────────────────────────────────────────────────────────
const Tarea = sequelize.define('TareaHerreria', {
    nombre:       { type: DataTypes.STRING,  allowNull: false },
    tipo:         { type: DataTypes.STRING,  defaultValue: 'NORMAL' },
    // NORMAL | RESTRICCION | ESPERA
    estado:       { type: DataTypes.STRING,  defaultValue: 'PENDIENTE' },
    // PENDIENTE | EN_PROCESO | COMPLETADA | PAUSADA | ESPERA
    diasHabiles:  { type: DataTypes.INTEGER, defaultValue: 1  },
    bufferDias:   { type: DataTypes.INTEGER, defaultValue: 0  },
    avancePct:    { type: DataTypes.INTEGER, defaultValue: 0  },
    orden:        { type: DataTypes.INTEGER, defaultValue: 0  },
    activadaEn:   { type: DataTypes.DATE,    allowNull: true  },
    completadaEn: { type: DataTypes.DATE,    allowNull: true  },
    diasHabilesConsumidos: { type: DataTypes.INTEGER, defaultValue: 0 },
}, { tableName: 'TareasHerreria', timestamps: true });

// ── Kit (ítem de compuerta por tarea) ─────────────────────────────────────────
const KitItem = sequelize.define('KitItemHerreria', {
    descripcion:  { type: DataTypes.STRING,  allowNull: false },
    completado:   { type: DataTypes.BOOLEAN, defaultValue: false },
    completadoPor:{ type: DataTypes.STRING,  allowNull: true  },
    completadoEn: { type: DataTypes.DATE,    allowNull: true  },
    esSugerida:   { type: DataTypes.BOOLEAN, defaultValue: false },
}, { tableName: 'KitItemsHerreria', timestamps: false });

// ── Historial de cambios ──────────────────────────────────────────────────────
const Historial = sequelize.define('HistorialHerreria', {
    accion:       { type: DataTypes.TEXT,    allowNull: false },
    usuario:      { type: DataTypes.STRING,  allowNull: true  },
    datos:        { type: DataTypes.JSONB,   allowNull: true  },
    // datos: snapshot del estado anterior para poder reconstruir la línea de tiempo
}, { tableName: 'HistorialHerreria', timestamps: true, updatedAt: false });

// ── Relaciones ────────────────────────────────────────────────────────────────
Proyecto.hasMany(Tarea,     { foreignKey: 'proyectoId', onDelete: 'CASCADE' });
Tarea.belongsTo(Proyecto,   { foreignKey: 'proyectoId' });
Tarea.hasMany(KitItem,      { foreignKey: 'tareaId',    onDelete: 'CASCADE' });
KitItem.belongsTo(Tarea,    { foreignKey: 'tareaId' });
Proyecto.hasMany(Historial, { foreignKey: 'proyectoId', onDelete: 'CASCADE' });
Historial.belongsTo(Proyecto,{ foreignKey: 'proyectoId' });

sequelize.sync({ alter: true }).catch(e => console.error('DB Herrería:', e));

module.exports = { sequelize, Proyecto, Tarea, KitItem, Historial };
