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
    // BORRADOR | ACTIVO | PAUSADO | TERMINADO | CANCELADO
    // CANCELADO: proyecto suspendido/descartado. No aparece en ninguna vista activa
    // (tablero, calendario, lista por defecto). Queda en la base para el informe anual.
    creadoPor:    { type: DataTypes.STRING,  allowNull: true  },
    activadoEn:   { type: DataTypes.DATE,    allowNull: true  },
    pausadoEn:    { type: DataTypes.DATE,    allowNull: true  },
    terminadoEn:  { type: DataTypes.DATE,    allowNull: true  },
    canceladoEn:  { type: DataTypes.DATE,    allowNull: true  },
    canceladoPor: { type: DataTypes.STRING,  allowNull: true  },
    motivoCancelacion: { type: DataTypes.STRING, allowNull: true },
    diasHabilesTotales: { type: DataTypes.INTEGER, defaultValue: 0 },
    bufferDias:   { type: DataTypes.INTEGER, defaultValue: 0  },
}, { tableName: 'ProyectosHerreria', timestamps: true });

// ── Tarea ─────────────────────────────────────────────────────────────────────
const Tarea = sequelize.define('TareaHerreria', {
    nombre:       { type: DataTypes.STRING,  allowNull: false },
    fase:         { type: DataTypes.STRING,  defaultValue: 'EJECUCION' },
    // PRELIMINAR | EJECUCION — preliminares no usa buffer ni fever chart
    tipo:         { type: DataTypes.STRING,  defaultValue: 'NORMAL' },
    // NORMAL | RESTRICCION | ESPERA  (solo aplica en fase EJECUCION)
    estado:       { type: DataTypes.STRING,  defaultValue: 'PENDIENTE' },
    // PENDIENTE | EN_PROCESO | COMPLETADA | PAUSADA | ESPERA |
    // ESPERANDO_PRELIMINAR | ESPERANDO_DEPENDENCIA
    diasHabiles:  { type: DataTypes.INTEGER, defaultValue: 1  },
    // diasManual: si está en true, diasHabiles es un número que vos fijaste a mano
    // y el sistema NO lo recalcula desde el kit, aunque la tarea tenga ítems con
    // sus propios días. Útil cuando la tarea tiene tiempos (espera, secado, etc.)
    // que no están representados ítem por ítem — la suma del kit puede ser menor
    // a la duración real de la tarea.
    diasManual:   { type: DataTypes.BOOLEAN, defaultValue: false },
    bufferDias:   { type: DataTypes.INTEGER, defaultValue: 0  },
    avancePct:    { type: DataTypes.INTEGER, defaultValue: 0  },
    orden:        { type: DataTypes.INTEGER, defaultValue: 0  },
    activadaEn:   { type: DataTypes.DATE,    allowNull: true  },
    completadaEn: { type: DataTypes.DATE,    allowNull: true  },
    // Fecha de cierre real para tareas PRELIMINAR (queda fija al marcar como hecha)
    cerradaEn:    { type: DataTypes.DATE,    allowNull: true  },
    cerradaPor:   { type: DataTypes.STRING,  allowNull: true  },
    diasHabilesConsumidos: { type: DataTypes.INTEGER, defaultValue: 0 },
    // ── Paralelismo y desfasaje (PLANIFICACIÓN — solo afecta la fecha calculada) ──
    // predecesoraId: ID de la tarea de la que depende el inicio de esta (misma fase).
    //   Si es null, la tarea arranca apenas se libera la compuerta (comportamiento actual).
    // desfasajeDias: cuántos días hábiles después de que ARRANCA la predecesora,
    //   arranca esta tarea. 0 = mismo día (100% paralelas). No se basa en que la
    //   predecesora termine — permite que una tarea larga (ej. 20 días) tenga
    //   varias tareas cortas empezando y terminando en distintos puntos de su rango.
    predecesoraId:  { type: DataTypes.INTEGER, allowNull: true },
    desfasajeDias:  { type: DataTypes.INTEGER, defaultValue: 0 },
    // ── Dependencia dura (COMPUERTA REAL — regla de flujo de Goldratt) ───────────
    // dependeDuroId: ID de la tarea que DEBE estar COMPLETADA para que esta pueda
    //   pasar a EN_PROCESO de verdad, sin importar qué fecha tenga calculada.
    //   Distinto de predecesoraId: ese solo calcula CUÁNDO se planifica el inicio;
    //   este bloquea el AVANCE REAL si la condición no se cumple — es la compuerta.
    dependeDuroId:  { type: DataTypes.INTEGER, allowNull: true },
    // dependeDuroItemId: alternativa más fina — en vez de depender de que OTRA
    // TAREA completa esté terminada, depende de que un ÍTEM PUNTUAL del kit de
    // otra tarea esté marcado como completado. Por ejemplo: la tarea "Pintura"
    // no puede arrancar hasta que el ítem "corte de chapa" del kit de la tarea
    // "Prensamblado" esté listo, sin importar el resto del kit de esa tarea.
    // Solo uno de los dos (dependeDuroId / dependeDuroItemId) debería usarse a la vez.
    dependeDuroItemId: { type: DataTypes.INTEGER, allowNull: true },
}, { tableName: 'TareasHerreria', timestamps: true });

// ── Kit (ítem de compuerta por tarea) ─────────────────────────────────────────
const KitItem = sequelize.define('KitItemHerreria', {
    descripcion:  { type: DataTypes.STRING,  allowNull: false },
    completado:   { type: DataTypes.BOOLEAN, defaultValue: false },
    completadoPor:{ type: DataTypes.STRING,  allowNull: true  },
    completadoEn: { type: DataTypes.DATE,    allowNull: true  },
    esSugerida:   { type: DataTypes.BOOLEAN, defaultValue: false },
    // ── Días, tipo y paralelismo del ítem ────────────────────────────────────
    // La restricción real muchas veces no es la tarea entera, sino un ítem
    // puntual dentro de ella (ej: "ajuste de chapa" depende de un proveedor,
    // mientras "corte" y "armado" son rápidos). Cada ítem tiene su propia
    // duración; la suma de los ítems define el total de días de la tarea.
    diasHabiles:  { type: DataTypes.INTEGER, defaultValue: 1 },
    esRestriccion:{ type: DataTypes.BOOLEAN, defaultValue: false },
    // Mismo mecanismo de paralelismo que las tareas: si predecesoraId es null,
    // el ítem arranca al inicio de la tarea. Si tiene predecesora, arranca
    // desfasajeDias después de que ARRANCÓ ese otro ítem (permite ítems en
    // simultáneo el mismo día, o desfasados parcialmente).
    predecesoraId:{ type: DataTypes.INTEGER, allowNull: true },
    desfasajeDias:{ type: DataTypes.INTEGER, defaultValue: 0 },
}, { tableName: 'KitItemsHerreria', timestamps: false });

// ── Historial de cambios ──────────────────────────────────────────────────────
const Historial = sequelize.define('HistorialHerreria', {
    accion:       { type: DataTypes.TEXT,    allowNull: false },
    usuario:      { type: DataTypes.STRING,  allowNull: true  },
    datos:        { type: DataTypes.JSONB,   allowNull: true  },
    // datos: snapshot del estado anterior para poder reconstruir la línea de tiempo
}, { tableName: 'HistorialHerreria', timestamps: true, updatedAt: false });

// ── Relaciones ────────────────────────────────────────────────────────────────
// IMPORTANTE: el alias "as" debe coincidir con lo que espera el resto del código
// (rutas_herreria.js usa obj.Tareas, t.KitItems, p.Historials). Sin "as" explícito,
// Sequelize usa el nombre del modelo (TareaHerreria) como clave, no "Tareas".
Proyecto.hasMany(Tarea,     { foreignKey: 'proyectoId', onDelete: 'CASCADE', as: 'Tareas' });
Tarea.belongsTo(Proyecto,   { foreignKey: 'proyectoId' });
Tarea.hasMany(KitItem,      { foreignKey: 'tareaId',    onDelete: 'CASCADE', as: 'KitItems' });
KitItem.belongsTo(Tarea,    { foreignKey: 'tareaId', as: 'Tarea' });
Proyecto.hasMany(Historial, { foreignKey: 'proyectoId', onDelete: 'CASCADE', as: 'Historials' });
Historial.belongsTo(Proyecto,{ foreignKey: 'proyectoId' });

sequelize.sync({ alter: true }).catch(e => console.error('DB Herrería:', e));

module.exports = { sequelize, Proyecto, Tarea, KitItem, Historial };
