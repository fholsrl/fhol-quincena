// rutas_herreria.js — Módulo de Herrería FHOL — Teoría de Restricciones
const express  = require('express');
const router   = express.Router();
const ExcelJS  = require('exceljs');
const { Op }   = require('sequelize');
const { Proyecto, Tarea, KitItem, Historial } = require('./database_herreria');

const proteger = (req, res, next) => {
    if (req.session && req.session.user) return next();
    res.status(401).json({ error: 'No autorizado' });
};

// ── Utilidades ────────────────────────────────────────────────────────────────

// Avanza N días hábiles desde una fecha, saltando sab/dom
function sumarDiasHabiles(fecha, dias) {
    let d = new Date(fecha);
    let restantes = dias;
    while (restantes > 0) {
        d.setDate(d.getDate() + 1);
        if (d.getDay() !== 0 && d.getDay() !== 6) restantes--;
    }
    return d;
}

// Días hábiles transcurridos desde una fecha hasta hoy
function diasHabilesDesde(fecha) {
    if (!fecha) return 0;
    let d = new Date(fecha);
    const hoy = new Date();
    let count = 0;
    while (d < hoy) {
        d.setDate(d.getDate() + 1);
        if (d.getDay() !== 0 && d.getDay() !== 6) count++;
    }
    return count;
}

// Calcula el buffer correcto: ceil(dias * 0.30) — solo aplica a fase EJECUCION
function calcBuf(dias, fase = 'EJECUCION') {
    if (fase === 'PRELIMINAR') return 0;
    return Math.ceil(dias * 0.30);
}

// Registra un cambio en el historial del proyecto
async function log(proyectoId, accion, usuario, datos = null) {
    await Historial.create({ proyectoId, accion, usuario, datos });
}

// ── PROYECTOS ─────────────────────────────────────────────────────────────────

// GET /herreria/proyectos — lista todos con estado de buffer
router.get('/proyectos', proteger, async (req, res) => {
    try {
        // Por defecto, los proyectos CANCELADOS no aparecen en ninguna vista activa.
        // Solo se ven si se pide explícitamente ?incluirCancelados=true (informe anual).
        const where = req.query.incluirCancelados === 'true' ? {} : { estado: { [Op.ne]: 'CANCELADO' } };
        const proyectos = await Proyecto.findAll({
            where,
            include: [{ model: Tarea, as: 'Tareas', include: [{ model: KitItem, as: 'KitItems' }] }],
            order: [['createdAt', 'DESC'], [{ model: Tarea, as: 'Tareas' }, 'orden', 'ASC']]
        });

        const resultado = proyectos.map(p => enriquecerProyecto(p));
        res.json(resultado);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /herreria/proyectos/:id — detalle completo
router.get('/proyectos/:id', proteger, async (req, res) => {
    try {
        const p = await Proyecto.findByPk(req.params.id, {
            include: [
                { model: Tarea, as: 'Tareas', include: [{ model: KitItem, as: 'KitItems' }] },
                { model: Historial, as: 'Historials', limit: 50, order: [['createdAt', 'DESC']] }
            ]
        });
        if (!p) return res.status(404).json({ error: 'No encontrado' });
        res.json(enriquecerProyecto(p));
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /herreria/proyectos — crear
router.post('/proyectos', proteger, async (req, res) => {
    try {
        const { nombre, cliente, responsable, notas, tareas } = req.body;
        if (!nombre) return res.status(400).json({ error: 'Nombre obligatorio' });

        const p = await Proyecto.create({
            nombre, cliente, responsable, notas,
            estado: 'BORRADOR',
            creadoPor: req.session.user.username
        });

        // Crear tareas si vienen en el body
        if (tareas && tareas.length) {
            for (let i = 0; i < tareas.length; i++) {
                const t = tareas[i];
                const fase = t.fase === 'PRELIMINAR' ? 'PRELIMINAR' : 'EJECUCION';
                const buf  = calcBuf(t.diasHabiles || 1, fase);
                const tarea = await Tarea.create({
                    proyectoId: p.id,
                    nombre: t.nombre,
                    fase,
                    tipo:   fase === 'PRELIMINAR' ? 'NORMAL' : (t.tipo || 'NORMAL'),
                    estado: t.tipo === 'ESPERA' ? 'ESPERA' : 'PENDIENTE',
                    diasHabiles: t.diasHabiles || 1,
                    bufferDias:  buf,
                    orden: i
                });
                if (t.kit && t.kit.length) {
                    for (const item of t.kit) {
                        await KitItem.create({
                            tareaId: tarea.id,
                            descripcion: item.descripcion,
                            esSugerida:  item.esSugerida || false
                        });
                    }
                }
            }
        }

        // Recalcular totales del proyecto
        await recalcularTotales(p.id);
        await log(p.id, 'Proyecto creado', req.session.user.username, { nombre, cliente });
        res.json(await Proyecto.findByPk(p.id, { include: [{ model: Tarea, as: 'Tareas', include: [{ model: KitItem, as: 'KitItems' }] }] }));
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /herreria/proyectos/:id — editar (solo jefe)
router.put('/proyectos/:id', proteger, async (req, res) => {
    try {
        const rol = req.session.user.rol;
        if (rol !== 'admin') return res.status(403).json({ error: 'Solo el jefe puede editar el proyecto' });
        const p = await Proyecto.findByPk(req.params.id);
        if (!p) return res.status(404).json({ error: 'No encontrado' });
        const anterior = { nombre: p.nombre, cliente: p.cliente, responsable: p.responsable };
        const { nombre, cliente, responsable, notas } = req.body;
        if (nombre)      p.nombre      = nombre;
        if (cliente)     p.cliente     = cliente;
        if (responsable) p.responsable = responsable;
        if (notas !== undefined) p.notas = notas;
        await p.save();
        await log(p.id, 'Proyecto editado', req.session.user.username, { anterior, nuevo: req.body });
        res.json(p);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Calcula la duración real de una tarea a partir de los días de cada ítem de su
// kit, respetando paralelismo: si dos ítems van el mismo día (desfasaje 0), no se
// suman ambos al total — la duración de la tarea es el punto más lejano en el
// tiempo que alcanza cualquier ítem (igual que un Gantt: el camino más largo).
function calcularDiasDesdeKit(items) {
    if (!items || !items.length) return null; // sin kit, no se puede calcular — usar el valor manual
    const fechaBase = new Date(2000, 0, 1); // fecha arbitraria fija, solo para medir distancias relativas
    const fechas = calendarizarPorDependencias(items, fechaBase);
    let maxFin = fechaBase;
    items.forEach(it => {
        const inicio = fechas[it.id] || fechaBase;
        const fin = sumarDiasHabiles(inicio, Math.max(0, (it.diasHabiles || 1) - 1));
        if (fin > maxFin) maxFin = fin;
    });
    // Diferencia en días hábiles entre fechaBase y maxFin, +1 para incluir el día de inicio
    let dias = 0, cursor = new Date(fechaBase);
    while (cursor < maxFin) {
        cursor.setDate(cursor.getDate() + 1);
        if (cursor.getDay() !== 0 && cursor.getDay() !== 6) dias++;
    }
    return dias + 1;
}

// POST /herreria/proyectos/:id/activar
function calendarizarPorDependencias(tareas, fechaBase) {
    const porId = {};
    tareas.forEach(t => { porId[t.id] = t; });
    const fechaInicio = {}; // id -> Date ya calculada

    let pendientes = [...tareas];
    let avanzo = true;
    while (pendientes.length && avanzo) {
        avanzo = false;
        pendientes = pendientes.filter(t => {
            if (!t.predecesoraId) {
                fechaInicio[t.id] = new Date(fechaBase);
                avanzo = true;
                return false;
            }
            const fechaPred = fechaInicio[t.predecesoraId];
            if (fechaPred) {
                fechaInicio[t.id] = sumarDiasHabiles(fechaPred, t.desfasajeDias || 0);
                avanzo = true;
                return false;
            }
            return true; // sigue esperando a su predecesora
        });
    }
    // Si quedó alguna sin resolver (predecesora inválida/circular), arranca en fechaBase
    pendientes.forEach(t => { fechaInicio[t.id] = new Date(fechaBase); });

    return fechaInicio;
}

// POST /herreria/proyectos/:id/activar
// Decide el ESTADO REAL en que debe quedar una tarea al momento de liberarla:
// si tiene dependeDuroId (de TAREA) o dependeDuroItemId (de ÍTEM DE KIT) y esa
// dependencia no está completa, queda bloqueada de verdad (ESPERANDO_DEPENDENCIA)
// sin importar la fecha calculada — esta es la compuerta real de Goldratt.
async function estadoSegunDependenciaDura(tarea) {
    if (tarea.dependeDuroId) {
        const dep = await Tarea.findByPk(tarea.dependeDuroId);
        if (dep && dep.estado !== 'COMPLETADA') return 'ESPERANDO_DEPENDENCIA';
    }
    if (tarea.dependeDuroItemId) {
        const item = await KitItem.findByPk(tarea.dependeDuroItemId);
        if (item && !item.completado) return 'ESPERANDO_DEPENDENCIA';
    }
    return 'EN_PROCESO';
}

// Revisa todas las tareas en ESPERANDO_DEPENDENCIA de un proyecto: si su
// dependencia dura (tarea completa o ítem puntual del kit) ya se cumplió,
// las libera a EN_PROCESO. Se llama cada vez que una tarea se marca como
// COMPLETADA o un ítem de kit se marca como completado, para destrabar en cadena.
async function liberarDependenciasDuras(proyectoId, usuario) {
    const tareas = await Tarea.findAll({ where: { proyectoId, estado: 'ESPERANDO_DEPENDENCIA' } });
    for (const t of tareas) {
        const nuevoEstado = await estadoSegunDependenciaDura(t);
        if (nuevoEstado === 'EN_PROCESO') {
            t.estado = 'EN_PROCESO';
            if (!t.activadaEn) t.activadaEn = new Date();
            await t.save();
            await log(proyectoId, `Tarea "${t.nombre}" liberada — su dependencia dura ya se cumplió`, usuario);
        }
    }
}

router.post('/proyectos/:id/activar', proteger, async (req, res) => {
    try {
        const p = await Proyecto.findByPk(req.params.id, { include: [{ model: Tarea, as: 'Tareas' }] });
        if (!p) return res.status(404).json({ error: 'No encontrado' });
        if (p.estado === 'ACTIVO') return res.json({ ok: true, message: 'Ya activo' });

        p.estado = 'ACTIVO';
        p.activadoEn = new Date();
        await p.save();

        // COMPUERTA PRELIMINAR → EJECUCIÓN:
        // Al activar, solo arrancan las tareas PRELIMINAR. Las de EJECUCION quedan
        // en estado ESPERANDO_PRELIMINAR hasta que TODAS las preliminares estén
        // completadas — recién ahí se activan automáticamente (ver marcarHecha).
        const preliminares = p.Tareas.filter(t => t.fase === 'PRELIMINAR' && t.estado === 'PENDIENTE');
        const ejecucion    = p.Tareas.filter(t => t.fase !== 'PRELIMINAR');

        const fechasPrelim = calendarizarPorDependencias(preliminares, new Date());
        for (const t of preliminares) {
            t.activadaEn = fechasPrelim[t.id];
            t.estado     = await estadoSegunDependenciaDura(t);
            await t.save();
        }

        // Tareas de ejecución: si no hay preliminares (proyecto sin esa fase),
        // se activan directo con su propia calendarización. Si hay preliminares,
        // quedan bloqueadas por la compuerta hasta que se liberen todas.
        if (preliminares.length === 0) {
            const elegibles = ejecucion.filter(t => t.tipo !== 'ESPERA' && t.estado === 'PENDIENTE');
            const fechasEjec = calendarizarPorDependencias(elegibles, new Date());
            for (const t of elegibles) {
                t.activadaEn = fechasEjec[t.id];
                t.estado     = await estadoSegunDependenciaDura(t);
                await t.save();
            }
        } else {
            for (const t of ejecucion) {
                if (t.tipo === 'ESPERA' || t.estado !== 'PENDIENTE') continue;
                t.estado = 'ESPERANDO_PRELIMINAR';
                await t.save();
            }
        }

        await log(p.id, 'Proyecto activado', req.session.user.username);
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Helper: revisa si todas las preliminares de un proyecto están completadas,
// y si es así, libera (activa) las tareas de ejecución que estaban esperando,
// calendarizándolas según sus dependencias (paralelismo/desfasaje), respetando
// además la compuerta dura si la tienen.
async function verificarCompuertaPreliminar(proyectoId, usuario) {
    const tareas = await Tarea.findAll({ where: { proyectoId } });
    const preliminares = tareas.filter(t => t.fase === 'PRELIMINAR');
    if (!preliminares.length) return; // no hay preliminares, no aplica compuerta

    const todasHechas = preliminares.every(t => t.estado === 'COMPLETADA');
    if (!todasHechas) return;

    const enEspera = tareas.filter(t => t.fase !== 'PRELIMINAR' && t.estado === 'ESPERANDO_PRELIMINAR');
    if (!enEspera.length) return;

    const fechas = calendarizarPorDependencias(enEspera, new Date());
    for (const t of enEspera) {
        if (t.tipo === 'ESPERA') { t.estado = 'ESPERA'; await t.save(); continue; }
        t.activadaEn = fechas[t.id];
        t.estado     = await estadoSegunDependenciaDura(t);
        await t.save();
    }
    await log(proyectoId, 'Compuerta preliminar → ejecución abierta: todas las preliminares completadas', usuario);
}

// POST /herreria/proyectos/:id/pausar
router.post('/proyectos/:id/pausar', proteger, async (req, res) => {
    try {
        const p = await Proyecto.findByPk(req.params.id);
        if (!p) return res.status(404).json({ error: 'No encontrado' });
        p.estado    = 'PAUSADO';
        p.pausadoEn = new Date();
        await p.save();
        await log(p.id, 'Proyecto pausado', req.session.user.username, { motivo: req.body.motivo });
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /herreria/proyectos/:id/terminar
router.post('/proyectos/:id/terminar', proteger, async (req, res) => {
    try {
        const p = await Proyecto.findByPk(req.params.id);
        if (!p) return res.status(404).json({ error: 'No encontrado' });
        p.estado      = 'TERMINADO';
        p.terminadoEn = new Date();
        await p.save();
        await log(p.id, 'Proyecto terminado', req.session.user.username);
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /herreria/proyectos/:id/cancelar
// Marca el proyecto como CANCELADO — desaparece de toda vista activa (tablero,
// calendario, listado por defecto) pero queda en la base para el informe anual.
router.post('/proyectos/:id/cancelar', proteger, async (req, res) => {
    try {
        if (req.session.user.rol !== 'admin')
            return res.status(403).json({ error: 'Solo el jefe puede cancelar un proyecto' });
        const p = await Proyecto.findByPk(req.params.id);
        if (!p) return res.status(404).json({ error: 'No encontrado' });
        p.estado            = 'CANCELADO';
        p.canceladoEn        = new Date();
        p.canceladoPor       = req.session.user.username;
        p.motivoCancelacion  = req.body.motivo || null;
        await p.save();
        await log(p.id, `Proyecto cancelado${req.body.motivo ? ': ' + req.body.motivo : ''}`, req.session.user.username);
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── TAREAS ────────────────────────────────────────────────────────────────────

// POST /herreria/tareas — agregar tarea a proyecto existente
router.post('/tareas', proteger, async (req, res) => {
    try {
        if (req.session.user.rol !== 'admin')
            return res.status(403).json({ error: 'Solo el jefe puede agregar tareas' });
        const { proyectoId, nombre, tipo, diasHabiles, kit, fase, predecesoraId, desfasajeDias, dependeDuroId } = req.body;
        const faseFinal = fase === 'PRELIMINAR' ? 'PRELIMINAR' : 'EJECUCION';
        const buf = calcBuf(diasHabiles || 1, faseFinal);
        const maxOrden = await Tarea.max('orden', { where: { proyectoId } }) || 0;
        const t = await Tarea.create({
            proyectoId, nombre, fase: faseFinal,
            tipo: faseFinal === 'PRELIMINAR' ? 'NORMAL' : (tipo || 'NORMAL'),
            estado: tipo === 'ESPERA' ? 'ESPERA' : 'PENDIENTE',
            diasHabiles: diasHabiles || 1, bufferDias: buf,
            orden: maxOrden + 1,
            predecesoraId: predecesoraId || null,
            desfasajeDias: parseInt(desfasajeDias) || 0,
            dependeDuroId: dependeDuroId || null,
        });
        if (kit && kit.length) {
            for (const item of kit) {
                await KitItem.create({ tareaId: t.id, descripcion: item.descripcion });
            }
        }
        await recalcularTotales(proyectoId);

        // Si el proyecto ya está ACTIVO (se agrega una tarea durante la marcha,
        // no solo mientras es BORRADOR), activarla ya mismo respetando la
        // compuerta dura si tiene una asignada.
        const proyecto = await Proyecto.findByPk(proyectoId);
        if (proyecto && proyecto.estado === 'ACTIVO' && t.tipo !== 'ESPERA') {
            t.activadaEn = new Date();
            t.estado     = await estadoSegunDependenciaDura(t);
            await t.save();
        }

        await log(proyectoId, `Tarea agregada: ${nombre}`, req.session.user.username);
        res.json(await Tarea.findByPk(t.id, { include: [{ model: KitItem, as: 'KitItems' }] }));
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /herreria/proyectos/:id/sincronizar-tareas
// Reemplaza TODAS las tareas de un proyecto de una sola vez — pensado para el
// flujo de "Editar" un proyecto en BORRADOR, donde se vuelve al mismo formulario
// de carga completo y se guarda todo de nuevo. Solo permitido en BORRADOR: una
// vez activado, las tareas tienen avance/fechas reales que no se pueden pisar así.
router.put('/proyectos/:id/sincronizar-tareas', proteger, async (req, res) => {
    try {
        if (req.session.user.rol !== 'admin')
            return res.status(403).json({ error: 'Solo el jefe puede editar el proyecto' });
        const proyectoId = req.params.id;
        const proyecto = await Proyecto.findByPk(proyectoId);
        if (!proyecto) return res.status(404).json({ error: 'No encontrado' });
        if (!['BORRADOR', 'ACTIVO', 'PAUSADO'].includes(proyecto.estado))
            return res.status(400).json({ error: 'Solo se puede editar un proyecto en BORRADOR, ACTIVO o PAUSADO' });

        const { nombre, cliente, responsable, notas, tareas } = req.body;
        if (nombre)      proyecto.nombre      = nombre;
        proyecto.cliente     = cliente     ?? proyecto.cliente;
        proyecto.responsable = responsable ?? proyecto.responsable;
        proyecto.notas       = notas       ?? proyecto.notas;
        await proyecto.save();

        if (proyecto.estado === 'BORRADOR') {
            // BORRADOR: nada tiene avance real todavía — reemplazo total, simple y seguro.
            await Tarea.destroy({ where: { proyectoId } });
            if (tareas && tareas.length) {
                for (let i = 0; i < tareas.length; i++) {
                    const t = tareas[i];
                    const fase = t.fase === 'PRELIMINAR' ? 'PRELIMINAR' : 'EJECUCION';
                    const buf  = calcBuf(t.diasHabiles || 1, fase);
                    const tarea = await Tarea.create({
                        proyectoId, nombre: t.nombre, fase,
                        tipo: fase === 'PRELIMINAR' ? 'NORMAL' : (t.tipo || 'NORMAL'),
                        estado: t.tipo === 'ESPERA' ? 'ESPERA' : 'PENDIENTE',
                        diasHabiles: t.diasHabiles || 1, bufferDias: buf,
                        orden: i,
                        diasManual: !!t.diasManual,
                    });
                    if (t.kit && t.kit.length) {
                        for (const item of t.kit) {
                            await KitItem.create({
                                tareaId: tarea.id,
                                descripcion: item.descripcion,
                                diasHabiles: item.diasHabiles || 1,
                                esRestriccion: !!item.esRestriccion,
                                esSugerida: item.esSugerida || false,
                            });
                        }
                    }
                }
            }
        } else {
            // ACTIVO/PAUSADO: hay tareas con avance real — no se puede reemplazar
            // todo a ciegas. Se EMPAREJA por id: las que ya existían (vienen con
            // su id real desde el formulario) se ACTUALIZAN respetando su fecha
            // de inicio si ya arrancaron; las nuevas (sin id) se CREAN; las que
            // existían pero ya no vienen en la lista se eliminan SOLO si nunca
            // arrancaron (sin activadaEn) — una tarea iniciada nunca se borra.
            const existentes = await Tarea.findAll({ where: { proyectoId } });
            const idsRecibidos = (tareas || []).filter(t => t.id).map(t => t.id);

            // Eliminar las que ya no están en la lista y nunca arrancaron
            for (const ex of existentes) {
                if (!idsRecibidos.includes(ex.id) && !ex.activadaEn) {
                    await KitItem.destroy({ where: { tareaId: ex.id } });
                    await ex.destroy();
                }
            }

            if (tareas && tareas.length) {
                for (let i = 0; i < tareas.length; i++) {
                    const t = tareas[i];
                    const fase = t.fase === 'PRELIMINAR' ? 'PRELIMINAR' : 'EJECUCION';

                    if (t.id) {
                        // Tarea existente: actualizar sin tocar su progreso real
                        const tarea = await Tarea.findByPk(t.id);
                        if (!tarea) continue;
                        const yaArranco = !!tarea.activadaEn;
                        tarea.nombre = t.nombre;
                        // Si ya arrancó, el mínimo de días es lo ya consumido —
                        // se puede AUMENTAR la duración (y su buffer) pero no
                        // reducirla por debajo de lo que ya se trabajó.
                        const minDias = yaArranco ? Math.max(tarea.diasHabilesConsumidos || 0, 1) : 1;
                        tarea.diasHabiles = Math.max(t.diasHabiles || 1, minDias);
                        tarea.bufferDias  = calcBuf(tarea.diasHabiles, fase);
                        tarea.tipo        = fase === 'PRELIMINAR' ? 'NORMAL' : (t.tipo || tarea.tipo);
                        tarea.diasManual  = !!t.diasManual;
                        tarea.orden       = i;
                        await tarea.save();

                        // Kit: igual lógica — emparejar por id, conservar completados.
                        const kitExistente = await KitItem.findAll({ where: { tareaId: tarea.id } });
                        const kitIdsRecibidos = (t.kit || []).filter(k => k.id).map(k => k.id);
                        for (const ke of kitExistente) {
                            if (!kitIdsRecibidos.includes(ke.id) && !ke.completado) await ke.destroy();
                        }
                        for (const k of (t.kit || [])) {
                            if (k.id) {
                                const item = await KitItem.findByPk(k.id);
                                if (item && !item.completado) {
                                    item.descripcion   = k.descripcion;
                                    item.diasHabiles   = k.diasHabiles || 1;
                                    item.esRestriccion = !!k.esRestriccion;
                                    await item.save();
                                }
                            } else {
                                await KitItem.create({
                                    tareaId: tarea.id, descripcion: k.descripcion,
                                    diasHabiles: k.diasHabiles || 1,
                                    esRestriccion: !!k.esRestriccion,
                                    esSugerida: k.esSugerida || false,
                                });
                            }
                        }
                    } else {
                        // Tarea nueva: se crea y, si el proyecto ya no tiene
                        // preliminares pendientes, se activa de inmediato.
                        const buf = calcBuf(t.diasHabiles || 1, fase);
                        const nueva = await Tarea.create({
                            proyectoId, nombre: t.nombre, fase,
                            tipo: fase === 'PRELIMINAR' ? 'NORMAL' : (t.tipo || 'NORMAL'),
                            estado: t.tipo === 'ESPERA' ? 'ESPERA' : 'PENDIENTE',
                            diasHabiles: t.diasHabiles || 1, bufferDias: buf,
                            orden: i, diasManual: !!t.diasManual,
                        });
                        if (t.kit && t.kit.length) {
                            for (const k of t.kit) {
                                await KitItem.create({
                                    tareaId: nueva.id, descripcion: k.descripcion,
                                    diasHabiles: k.diasHabiles || 1,
                                    esRestriccion: !!k.esRestriccion,
                                    esSugerida: k.esSugerida || false,
                                });
                            }
                        }
                        if (proyecto.estado === 'ACTIVO' && nueva.tipo !== 'ESPERA') {
                            const hayPreliminaresPendientes = await Tarea.findOne({
                                where: { proyectoId, fase: 'PRELIMINAR', estado: { [Op.ne]: 'COMPLETADA' } }
                            });
                            if (!hayPreliminaresPendientes) {
                                nueva.activadaEn = new Date();
                                nueva.estado     = await estadoSegunDependenciaDura(nueva);
                                await nueva.save();
                            } else if (fase !== 'PRELIMINAR') {
                                nueva.estado = 'ESPERANDO_PRELIMINAR';
                                await nueva.save();
                            }
                        }
                    }
                }
            }
        }

        await recalcularTotales(proyectoId);
        await log(proyectoId, 'Proyecto editado — tareas actualizadas', req.session.user.username);
        res.json({ ok: true, proyectoId });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /herreria/tareas/:id — editar tarea (jefe) o actualizar avance (supervisor)
router.put('/tareas/:id', proteger, async (req, res) => {
    try {
        const t = await Tarea.findByPk(req.params.id);
        if (!t) return res.status(404).json({ error: 'No encontrada' });
        const esJefe = req.session.user.rol === 'admin';
        const anterior = { avancePct: t.avancePct, estado: t.estado };

        if (esJefe) {
            // El jefe puede cambiar todo
            const { nombre, tipo, diasHabiles, estado, notas, predecesoraId, desfasajeDias,
                    dependeDuroId, dependeDuroItemId, diasManual } = req.body;
            if (nombre)      t.nombre      = nombre;
            if (tipo && t.fase !== 'PRELIMINAR') t.tipo = tipo;
            if (diasManual !== undefined) t.diasManual = !!diasManual;
            // Si se manda diasHabiles, se respeta SIEMPRE que el body lo incluya
            // (el frontend solo lo manda cuando el campo no está bloqueado, o
            // cuando el jefe activó explícitamente "fijar días a mano").
            if (diasHabiles) { t.diasHabiles = diasHabiles; t.bufferDias = calcBuf(diasHabiles, t.fase); }
            if (estado)      t.estado      = estado;
            if (predecesoraId !== undefined) t.predecesoraId = predecesoraId || null;
            if (desfasajeDias !== undefined) t.desfasajeDias = parseInt(desfasajeDias) || 0;
            if (dependeDuroId !== undefined) { t.dependeDuroId = dependeDuroId || null; if (dependeDuroId) t.dependeDuroItemId = null; }
            if (dependeDuroItemId !== undefined) { t.dependeDuroItemId = dependeDuroItemId || null; if (dependeDuroItemId) t.dependeDuroId = null; }

            // Si la tarea ya estaba activada y se cambió la relación de dependencia,
            // recalcular su fecha de inicio según la nueva predecesora/desfasaje.
            if ((predecesoraId !== undefined || desfasajeDias !== undefined) && t.activadaEn) {
                if (t.predecesoraId) {
                    const pred = await Tarea.findByPk(t.predecesoraId);
                    if (pred && pred.activadaEn) {
                        t.activadaEn = sumarDiasHabiles(new Date(pred.activadaEn), t.desfasajeDias || 0);
                    }
                }
            }

            // Si se acaba de asignar una dependencia dura (de tarea o de ítem) a
            // una tarea que ya estaba EN_PROCESO, y esa dependencia todavía no se
            // cumple, hay que bloquearla retroactivamente — la compuerta aplica
            // desde el momento en que se define, no solo al activar el proyecto.
            if (t.estado === 'EN_PROCESO') {
                const nuevoEstado = await estadoSegunDependenciaDura(t);
                if (nuevoEstado === 'ESPERANDO_DEPENDENCIA') t.estado = nuevoEstado;
            }
        }

        // Marcar tarea PRELIMINAR como hecha — fija fecha de cierre real, sin buffer/fever
        if (req.body.marcarHecha === true && t.fase === 'PRELIMINAR') {
            t.estado      = 'COMPLETADA';
            t.avancePct   = 100;
            t.cerradaEn   = new Date();
            t.cerradaPor  = req.session.user.username;
        }
        if (req.body.marcarHecha === false && t.fase === 'PRELIMINAR') {
            t.estado      = 'PENDIENTE';
            t.avancePct   = 0;
            t.cerradaEn   = null;
            t.cerradaPor  = null;
        }

        // Avance lo puede cambiar el jefe o supervisor — solo aplica a EJECUCION
        if (req.body.avancePct !== undefined && t.fase !== 'PRELIMINAR') {
            t.avancePct = parseInt(req.body.avancePct);
            if (t.avancePct >= 100) {
                t.avancePct   = 100;
                t.estado      = 'COMPLETADA';
                t.completadaEn = new Date();
            }
        }

        // Días hábiles consumidos — actualizar (solo EJECUCION usa fever chart)
        if (t.activadaEn && t.fase !== 'PRELIMINAR') {
            t.diasHabilesConsumidos = diasHabilesDesde(t.activadaEn);
        }

        await t.save();
        await recalcularTotales(t.proyectoId);

        // Si se marcó una preliminar como hecha, revisar si ya están todas
        // completadas — si es así, la compuerta se abre y libera ejecución.
        if (req.body.marcarHecha === true && t.fase === 'PRELIMINAR') {
            await verificarCompuertaPreliminar(t.proyectoId, req.session.user.username);
        }

        // Si esta tarea (cualquier fase) quedó COMPLETADA, revisar si destraba
        // a otras tareas que la tenían como dependencia dura (compuerta real).
        if (t.estado === 'COMPLETADA') {
            await liberarDependenciasDuras(t.proyectoId, req.session.user.username);
        }

        const accionTxt = req.body.marcarHecha !== undefined
            ? `Preliminar "${t.nombre}" marcada como ${req.body.marcarHecha ? 'HECHA' : 'pendiente'}`
            : `Tarea "${t.nombre}" actualizada`;
        await log(t.proyectoId, accionTxt, req.session.user.username,
            { anterior, nuevo: { avancePct: t.avancePct, estado: t.estado, cerradaEn: t.cerradaEn } });
        res.json(t);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /herreria/tareas/:id/activar — activar tarea en espera
router.post('/tareas/:id/activar', proteger, async (req, res) => {
    try {
        const t = await Tarea.findByPk(req.params.id);
        if (!t) return res.status(404).json({ error: 'No encontrada' });
        t.estado     = 'EN_PROCESO';
        t.activadaEn = new Date();
        await t.save();
        await log(t.proyectoId, `Tarea "${t.nombre}" activada desde espera`, req.session.user.username);
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── KIT ───────────────────────────────────────────────────────────────────────

// PUT /herreria/kit/:id — marcar o desmarcar ítem
// Recalcula los días totales de una tarea a partir de su kit (si tiene ítems
// con días propios cargados) y actualiza buffer en consecuencia.
async function recalcularDiasTarea(tareaId) {
    const t = await Tarea.findByPk(tareaId, { include: [{ model: KitItem, as: 'KitItems' }] });
    if (!t || !t.KitItems || !t.KitItems.length) return;
    if (t.diasManual) return; // el jefe fijó los días a mano — no pisar con el cálculo del kit
    const dias = calcularDiasDesdeKit(t.KitItems);
    if (dias === null) return;
    t.diasHabiles = dias;
    t.bufferDias  = calcBuf(dias, t.fase);
    await t.save();
    await recalcularTotales(t.proyectoId);
}

// PUT /herreria/kit/:id — marcar o desmarcar ítem como completado
router.put('/kit/:id', proteger, async (req, res) => {
    try {
        const item = await KitItem.findByPk(req.params.id, { include: [{ model: Tarea, as: 'Tarea' }] });
        if (!item) return res.status(404).json({ error: 'No encontrado' });
        item.completado = req.body.completado;
        if (item.completado) {
            item.completadoPor = req.session.user.username;
            item.completadoEn  = new Date();
        } else {
            item.completadoPor = null;
            item.completadoEn  = null;
        }
        await item.save();
        await log(item.Tarea.proyectoId,
            `Kit "${item.descripcion}" ${item.completado ? 'completado' : 'desmarcado'}`,
            req.session.user.username);

        // Si este ítem se marcó como completado, puede destrabar otras tareas
        // que lo tenían como compuerta dura (dependeDuroItemId).
        if (item.completado) {
            await liberarDependenciasDuras(item.Tarea.proyectoId, req.session.user.username);
        }

        res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUT /herreria/kit/:id/detalle — editar días, si es restricción, predecesora y desfasaje
// del ítem (solo jefe). Recalcula automáticamente los días totales de la tarea padre.
router.put('/kit/:id/detalle', proteger, async (req, res) => {
    try {
        if (req.session.user.rol !== 'admin')
            return res.status(403).json({ error: 'Solo el jefe puede editar el detalle del kit' });
        const item = await KitItem.findByPk(req.params.id, { include: [{ model: Tarea, as: 'Tarea' }] });
        if (!item) return res.status(404).json({ error: 'No encontrado' });

        const { diasHabiles, esRestriccion, predecesoraId, desfasajeDias, descripcion } = req.body;
        if (descripcion)        item.descripcion   = descripcion;
        if (diasHabiles)        item.diasHabiles   = parseInt(diasHabiles);
        if (esRestriccion !== undefined) item.esRestriccion = !!esRestriccion;
        if (predecesoraId !== undefined) item.predecesoraId = predecesoraId || null;
        if (desfasajeDias !== undefined) item.desfasajeDias = parseInt(desfasajeDias) || 0;
        await item.save();

        await recalcularDiasTarea(item.tareaId);
        await log(item.Tarea.proyectoId,
            `Kit "${item.descripcion}" actualizado${esRestriccion ? ' — marcado como RESTRICCIÓN' : ''}`,
            req.session.user.username);

        const t = await Tarea.findByPk(item.tareaId);
        res.json({ ok: true, item, diasHabilesTarea: t.diasHabiles, bufferDiasTarea: t.bufferDias });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// POST /herreria/kit — agregar ítem al kit de una tarea
router.post('/kit', proteger, async (req, res) => {
    try {
        const { tareaId, descripcion, diasHabiles, esRestriccion, predecesoraId, desfasajeDias } = req.body;
        const item = await KitItem.create({
            tareaId, descripcion,
            diasHabiles:   diasHabiles ? parseInt(diasHabiles) : 1,
            esRestriccion: !!esRestriccion,
            predecesoraId: predecesoraId || null,
            desfasajeDias: parseInt(desfasajeDias) || 0,
        });
        const t = await Tarea.findByPk(tareaId);
        await recalcularDiasTarea(tareaId);
        await log(t.proyectoId, `Kit agregado: "${descripcion}"`, req.session.user.username);
        res.json(item);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /herreria/kit/sugeridas — ítems que se repiten en 2+ proyectos
router.get('/kit/sugeridas', proteger, async (req, res) => {
    try {
        const items = await KitItem.findAll({ attributes: ['descripcion'] });
        const freq = {};
        items.forEach(i => { freq[i.descripcion] = (freq[i.descripcion] || 0) + 1; });
        const sugeridas = Object.entries(freq)
            .filter(([, n]) => n >= 2)
            .sort((a, b) => b[1] - a[1])
            .map(([descripcion, count]) => ({ descripcion, count }));
        res.json(sugeridas);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── HISTORIAL ─────────────────────────────────────────────────────────────────

// POST /herreria/proyectos/:id/nota — agregar nota manual al historial
router.post('/proyectos/:id/nota', proteger, async (req, res) => {
    try {
        await log(req.params.id, req.body.nota, req.session.user.username);
        res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── RESTRICCIÓN CRUZADA ───────────────────────────────────────────────────────
// GET /herreria/restriccion — detecta el recurso con mayor carga entre proyectos activos
router.get('/restriccion', proteger, async (req, res) => {
    try {
        const activos = await Proyecto.findAll({
            where: { estado: 'ACTIVO' },
            include: [{ model: Tarea, as: 'Tareas', where: { tipo: 'RESTRICCION', estado: { [Op.ne]: 'COMPLETADA' } }, required: false }]
        });
        const carga = {};
        activos.forEach(p => {
            (p.Tareas || []).forEach(t => {
                if (!carga[t.nombre]) carga[t.nombre] = { tareas: [], totalDias: 0, proyectos: new Set() };
                carga[t.nombre].tareas.push({ proyecto: p.nombre, dias: t.diasHabiles, avance: t.avancePct });
                carga[t.nombre].totalDias += t.diasHabiles;
                carga[t.nombre].proyectos.add(p.nombre);
            });
        });
        const ranking = Object.entries(carga)
            .map(([nombre, data]) => ({ nombre, ...data, nProyectos: data.proyectos.size, proyectos: undefined }))
            .sort((a, b) => b.totalDias - a.totalDias);

        // Solo se considera "restricción saturada" (banner de alerta) cuando 2 o más
        // proyectos compiten por el mismo recurso al mismo tiempo. Un solo proyecto
        // con una tarea de tipo RESTRICCION es normal, no es una alerta de sobrecarga.
        const saturada = ranking.find(r => r.nProyectos >= 2) || null;

        res.json({ restriccion: ranking[0] || null, saturada, ranking });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── INFORME DE CIERRE (Excel + PDF) ──────────────────────────────────────────
router.get('/proyectos/:id/informe', proteger, async (req, res) => {
    try {
        const p = await Proyecto.findByPk(req.params.id, {
            include: [
                { model: Tarea, as: 'Tareas', include: [{ model: KitItem, as: 'KitItems' }] },
                { model: Historial, as: 'Historials', order: [['createdAt', 'ASC']] }
            ]
        });
        if (!p) return res.status(404).json({ error: 'No encontrado' });

        const wb = new ExcelJS.Workbook();
        wb.creator = 'FHOL'; wb.created = new Date();

        const C = {
            az:'1E3A8A', vt:'7C3AED', vd:'059669', na:'EA580C', rj:'DC2626',
            gh:'334155', gc:'F1F5F9', bl:'FFFFFF', vc:'D1FAE5', rc:'FEE2E2',
            xc:'EDE9FE', am:'FFFBEB'
        };
        const F = c => ({ type:'pattern', pattern:'solid', fgColor:{ argb: c } });
        const fn = (bold=false,color='1E293B',size=10) =>
            ({ name:'Arial', bold, color:{ argb: color }, size });
        const th = () => { const s={style:'thin',color:{argb:'CBD5E1'}};
            return {left:s,right:s,top:s,bottom:s}; };
        const al = (h='left',v='center',wrap=false) =>
            ({ horizontal:h, vertical:v, wrapText:wrap });

        // ── Hoja 1: Resumen ──────────────────────────────────────────────────
        const ws1 = wb.addWorksheet('Resumen del proyecto');
        ws1.sheet_view_showGridLines = false;
        ws1.showGridLines = false;
        ws1.columns = [
            {width:22},{width:38},{width:18},{width:18},{width:18},{width:18}
        ];

        ws1.mergeCells('A1:F1');
        const t1 = ws1.getCell('A1');
        t1.value = `INFORME DE CIERRE — ${p.nombre.toUpperCase()}`;
        t1.font = { name:'Arial Black', size:13, bold:true, color:{argb:C.bl} };
        t1.fill = F(C.az); t1.alignment = al('left','center');
        ws1.getRow(1).height = 30;

        ws1.mergeCells('A2:F2');
        const t2 = ws1.getCell('A2');
        t2.value = `FHOL Herrería · Uso exclusivo interno · ${new Date().toLocaleDateString('es-AR')}`;
        t2.font = fn(false,'94A3B8',9); t2.fill = F(C.gc);
        t2.alignment = al('right','center');
        ws1.getRow(2).height = 16;

        const datos = [
            ['Cliente / obra', p.cliente || '—'],
            ['Responsable',    p.responsable || '—'],
            ['Estado',         p.estado],
            ['Creado por',     p.creadoPor || '—'],
            ['Activado el',    p.activadoEn ? new Date(p.activadoEn).toLocaleDateString('es-AR') : '—'],
            ['Terminado el',   p.terminadoEn ? new Date(p.terminadoEn).toLocaleDateString('es-AR') : '—'],
            ['Días de plan',   p.diasHabilesTotales + ' días hábiles'],
            ['Buffer total',   p.bufferDias + ' días hábiles (30%)'],
            ['Horizonte total',(p.diasHabilesTotales + p.bufferDias) + ' días hábiles'],
        ];
        datos.forEach((d, i) => {
            const r = i + 4;
            ws1.getRow(r).height = 18;
            const ca = ws1.getCell(`A${r}`);
            ca.value = d[0]; ca.font = fn(true,C.gh,9);
            ca.fill = F(C.gc); ca.alignment = al('right','center'); ca.border = th();
            const cb = ws1.getCell(`B${r}`);
            cb.value = d[1]; cb.font = fn(false,'1E293B',10);
            cb.fill = F(C.bl); cb.alignment = al('left','center'); cb.border = th();
        });

        // Notas
        if (p.notas) {
            ws1.mergeCells('A14:F14');
            ws1.getCell('A14').value = 'Notas del proyecto';
            ws1.getCell('A14').font = fn(true,C.bl,9);
            ws1.getCell('A14').fill = F(C.gh);
            ws1.getRow(14).height = 18;
            ws1.mergeCells('A15:F16');
            ws1.getCell('A15').value = p.notas;
            ws1.getCell('A15').font = fn(false,'1E293B',9);
            ws1.getCell('A15').fill = F(C.am);
            ws1.getCell('A15').alignment = al('left','top',true);
            ws1.getRow(15).height = 32;
        }

        // ── Hoja 2: Tareas y buffer ──────────────────────────────────────────
        const ws2 = wb.addWorksheet('Tareas y buffer');
        ws2.showGridLines = false;
        ws2.columns = [{width:8},{width:30},{width:14},{width:14},{width:12},
                       {width:10},{width:12},{width:16},{width:28}];

        ws2.mergeCells('A1:I1');
        const th2 = ws2.getCell('A1');
        th2.value = 'TAREAS Y CONSUMO DE BUFFER — ' + p.nombre.toUpperCase();
        th2.font = { name:'Arial Black', size:11, bold:true, color:{argb:C.bl} };
        th2.fill = F(C.az); th2.alignment = al('left','center');
        ws2.getRow(1).height = 26;

        const hdrs2 = ['#','Tarea','Tipo','Estado','Días plan',
                       'Buffer','Avance %','Días consumidos','Observación'];
        const hc2 = ['az','az','vt','az','vd','vt','vd','az','gh'];
        hdrs2.forEach((h,i) => {
            const c = ws2.getRow(2).getCell(i+1);
            c.value = h; c.font = fn(true,C.bl,9);
            c.fill = F(C[hc2[i]]); c.alignment = al('center','center'); c.border = th();
        });
        ws2.getRow(2).height = 22;

        const tareasOrdenadas = (p.Tareas || []).sort((a,b) => a.orden - b.orden);
        tareasOrdenadas.forEach((t,i) => {
            const row = i + 3;
            ws2.getRow(row).height = 17;
            const esHito = t.tipo === 'RESTRICCION';
            const vals = [
                i+1, t.nombre, t.tipo, t.estado,
                t.diasHabiles, t.bufferDias,
                t.avancePct + '%',
                t.diasHabilesConsumidos || 0,
                ''
            ];
            vals.forEach((v,j) => {
                const c = ws2.getRow(row).getCell(j+1);
                c.value = v; c.border = th();
                c.alignment = al(j===1?'left':'center','center');
                if (j === 0) { c.fill=F(C.gc); c.font=fn(true,C.az,8); }
                else if (j === 1) {
                    c.fill = F(esHito ? C.rc : C.bl);
                    c.font = fn(esHito, esHito ? C.rj : '1E293B', 9);
                }
                else if (j === 2) { c.fill=F(C.xc); c.font=fn(false,'4C1D95',9); }
                else if (j === 5) { c.fill=F(C.xc); c.font=fn(true,'534AB7',9); }
                else if (j === 6) {
                    const pct = parseInt(t.avancePct);
                    const bg = pct >= 100 ? C.vc : pct >= 50 ? C.am : C.rc;
                    c.fill=F(bg);
                    c.font=fn(true, pct>=100?C.vd:'1E293B', 9);
                }
                else { c.fill=F(C.bl); c.font=fn(false,'1E293B',9); }
            });
        });

        // Totales
        const totRow = tareasOrdenadas.length + 3;
        ws2.mergeCells(`A${totRow}:D${totRow}`);
        ws2.getCell(`A${totRow}`).value = 'TOTALES';
        ws2.getCell(`A${totRow}`).font = fn(true,C.bl,9);
        ws2.getCell(`A${totRow}`).fill = F(C.gh);
        ws2.getCell(`A${totRow}`).alignment = al('right','center');
        ws2.getRow(totRow).height = 18;
        const sumDias = tareasOrdenadas.reduce((s,t)=>s+t.diasHabiles,0);
        const sumBuf  = tareasOrdenadas.reduce((s,t)=>s+t.bufferDias,0);
        ws2.getCell(`E${totRow}`).value = sumDias;
        ws2.getCell(`F${totRow}`).value = sumBuf;
        [ws2.getCell(`E${totRow}`), ws2.getCell(`F${totRow}`)].forEach(c=>{
            c.font=fn(true,C.bl,10); c.fill=F(C.gh);
            c.alignment=al('center','center'); c.border=th();
        });

        // ── Hoja 3: Kit de compuertas ────────────────────────────────────────
        const ws3 = wb.addWorksheet('Kit de compuertas');
        ws3.showGridLines = false;
        ws3.columns = [{width:8},{width:28},{width:38},{width:14},{width:18},{width:22}];

        ws3.mergeCells('A1:F1');
        ws3.getCell('A1').value = 'KIT DE COMPUERTAS — ' + p.nombre.toUpperCase();
        ws3.getCell('A1').font = {name:'Arial Black',size:11,bold:true,color:{argb:C.bl}};
        ws3.getCell('A1').fill = F(C.vt); ws3.getCell('A1').alignment = al('left','center');
        ws3.getRow(1).height = 26;

        const hdrs3=['#','Tarea','Ítem del kit','Completado','Por quién','Cuándo'];
        hdrs3.forEach((h,i)=>{
            const c = ws3.getRow(2).getCell(i+1);
            c.value=h; c.font=fn(true,C.bl,9); c.fill=F(C.vt);
            c.alignment=al('center','center'); c.border=th();
        });
        ws3.getRow(2).height=20;

        let kitRow=3;
        tareasOrdenadas.forEach((t,ti) => {
            if (!t.KitItems || !t.KitItems.length) return;
            t.KitItems.forEach((item,ki) => {
                ws3.getRow(kitRow).height=17;
                const vals=[
                    ki===0 ? ti+1 : '',
                    ki===0 ? t.nombre : '',
                    item.descripcion,
                    item.completado ? 'SI' : 'NO',
                    item.completadoPor || '—',
                    item.completadoEn ? new Date(item.completadoEn).toLocaleDateString('es-AR') : '—'
                ];
                vals.forEach((v,j)=>{
                    const c = ws3.getRow(kitRow).getCell(j+1);
                    c.value=v; c.border=th();
                    c.alignment=al(j<2?'left':'center','center');
                    if (j===3) {
                        c.fill=F(item.completado?C.vc:C.rc);
                        c.font=fn(true,item.completado?C.vd:C.rj,9);
                    } else {
                        c.fill=F(ki===0&&j<2?C.xc:C.bl);
                        c.font=fn(ki===0&&j<2,C.gh,9);
                    }
                });
                kitRow++;
            });
        });

        // ── Hoja 4: Historial completo ───────────────────────────────────────
        const ws4 = wb.addWorksheet('Historial de cambios');
        ws4.showGridLines = false;
        ws4.columns=[{width:20},{width:20},{width:60}];

        ws4.mergeCells('A1:C1');
        ws4.getCell('A1').value = 'HISTORIAL DE CAMBIOS — ' + p.nombre.toUpperCase();
        ws4.getCell('A1').font={name:'Arial Black',size:11,bold:true,color:{argb:C.bl}};
        ws4.getCell('A1').fill=F(C.gh); ws4.getCell('A1').alignment=al('left','center');
        ws4.getRow(1).height=26;

        ['Fecha y hora','Usuario','Acción'].forEach((h,i)=>{
            const c=ws4.getRow(2).getCell(i+1);
            c.value=h; c.font=fn(true,C.bl,9); c.fill=F(C.gh);
            c.alignment=al('center','center'); c.border=th();
        });
        ws4.getRow(2).height=20;

        (p.Historials || []).forEach((h,i)=>{
            const row=i+3;
            ws4.getRow(row).height=16;
            const vals=[
                new Date(h.createdAt).toLocaleString('es-AR'),
                h.usuario || '—',
                h.accion
            ];
            vals.forEach((v,j)=>{
                const c=ws4.getRow(row).getCell(j+1);
                c.value=v; c.border=th();
                c.alignment=al(j===2?'left':'center','center',j===2);
                c.fill=F(i%2===0?C.gc:C.bl);
                c.font=fn(false,'1E293B',9);
            });
        });

        res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition',
            `attachment; filename=Informe_${p.nombre.replace(/[^a-zA-Z0-9]/g,'_')}.xlsx`);
        await wb.xlsx.write(res);
        res.end();
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── Helpers ───────────────────────────────────────────────────────────────────
async function recalcularTotales(proyectoId) {
    const tareas = await Tarea.findAll({ where: { proyectoId } });
    // Días totales: suma de TODAS las fases (preliminar + ejecución)
    const dias = tareas.reduce((s, t) => s + (t.diasHabiles || 0), 0);
    // Buffer: SOLO de tareas de ejecución — preliminares no tiene buffer
    const buf  = tareas
        .filter(t => t.fase !== 'PRELIMINAR')
        .reduce((s, t) => s + (t.bufferDias || 0), 0);
    await Proyecto.update(
        { diasHabilesTotales: dias, bufferDias: buf },
        { where: { id: proyectoId } }
    );
}

function enriquecerProyecto(p) {
    const obj = p.toJSON();
    const tareas = obj.Tareas || [];

    // Calcular fever chart SOLO para tareas de EJECUCION — preliminares no usa TOC
    tareas.forEach(t => {
        if (t.fase === 'PRELIMINAR' || !t.activadaEn || t.estado === 'ESPERA' ||
            t.estado === 'PENDIENTE' || t.estado === 'ESPERANDO_PRELIMINAR' ||
            t.estado === 'ESPERANDO_DEPENDENCIA') {
            t.feverChart = null; return;
        }
        const horizonte  = t.diasHabiles + t.bufferDias;
        const consumidos = t.diasHabilesConsumidos || diasHabilesDesde(t.activadaEn);
        const tiempoPct  = Math.min(100, Math.round((consumidos / horizonte) * 100));
        const avancePct  = t.avancePct || 0;
        const diff       = tiempoPct - avancePct;
        const bufZonaPct = Math.round((t.bufferDias / horizonte) * 100);
        const planZonaPct= 100 - bufZonaPct;
        let bufferEstado = 'OK';
        if (diff > 20) bufferEstado = 'CRITICO';
        else if (diff > 0) bufferEstado = 'ALERTA';
        t.feverChart = { tiempoPct, avancePct, diff, planZonaPct, bufZonaPct, bufferEstado };
    });

    // Estado general del buffer del proyecto — solo considera EJECUCION
    const tareasActivas = tareas.filter(t => t.feverChart);
    let estadoProyecto = 'OK';
    if (tareasActivas.some(t => t.feverChart.bufferEstado === 'CRITICO')) estadoProyecto = 'CRITICO';
    else if (tareasActivas.some(t => t.feverChart.bufferEstado === 'ALERTA')) estadoProyecto = 'ALERTA';
    obj.bufferEstado = estadoProyecto;

    // Kit completo por tarea (preliminares no tiene kit, queda true por defecto)
    tareas.forEach(t => {
        if (!t.KitItems) { t.kitCompleto = true; return; }
        t.kitCompleto = t.KitItems.every(k => k.completado);
        t.kitTotal    = t.KitItems.length;
        t.kitListos   = t.KitItems.filter(k => k.completado).length;
    });

    // Separar tareas por fase para que el frontend las agrupe fácil
    obj.tareasPreliminares = tareas.filter(t => t.fase === 'PRELIMINAR').sort((a,b)=>a.orden-b.orden);
    obj.tareasEjecucion    = tareas.filter(t => t.fase !== 'PRELIMINAR').sort((a,b)=>a.orden-b.orden);

    return obj;
}

// ── CALENDARIO (solo fase EJECUCION) ─────────────────────────────────────────
// GET /herreria/calendario?desde=YYYY-MM-DD&hasta=YYYY-MM-DD
// Devuelve cada tarea de ejecución con su rango de fechas real (calculado desde
// activadaEn + días) para poder pintarla en el calendario mensual/semanal.
router.get('/calendario', proteger, async (req, res) => {
    try {
        const proyectos = await Proyecto.findAll({
            where: { estado: { [Op.in]: ['ACTIVO', 'PAUSADO', 'TERMINADO'] } },
            include: [{ model: Tarea, as: 'Tareas', required: false }]
        });

        const eventos = [];
        proyectos.forEach((p, idx) => {
            (p.Tareas || []).forEach(t => {
                if (t.fase === 'PRELIMINAR') {
                    // Las preliminares son puntuales: aparecen el día de su
                    // activación (en curso) o el día en que se cerraron (hecha).
                    if (t.cerradaEn) {
                        const f = new Date(t.cerradaEn).toISOString().split('T')[0];
                        eventos.push({
                            proyectoId: p.id, proyectoNombre: p.nombre,
                            tareaId: t.id, tareaNombre: t.nombre,
                            inicio: f, fin: f,
                            estado: 'COMPLETADA', avancePct: 100,
                            esPreliminar: true,
                            colorIdx: idx % 8
                        });
                    } else if (t.activadaEn) {
                        const f = new Date(t.activadaEn).toISOString().split('T')[0];
                        eventos.push({
                            proyectoId: p.id, proyectoNombre: p.nombre,
                            tareaId: t.id, tareaNombre: t.nombre,
                            inicio: f, fin: f,
                            estado: t.estado, avancePct: 0,
                            esPreliminar: true,
                            colorIdx: idx % 8
                        });
                    }
                    return;
                }
                if (!t.activadaEn) return; // sin fecha de inicio real, no se puede ubicar en calendario
                const inicio = new Date(t.activadaEn);
                // Fin = inicio + días de plan (sin contar el buffer, que es margen no trabajo)
                const fin = sumarDiasHabiles(inicio, Math.max(0, t.diasHabiles - 1));
                eventos.push({
                    proyectoId: p.id,
                    proyectoNombre: p.nombre,
                    tareaId: t.id,
                    tareaNombre: t.nombre,
                    inicio: inicio.toISOString().split('T')[0],
                    fin: fin.toISOString().split('T')[0],
                    estado: t.estado,
                    avancePct: t.avancePct,
                    esPreliminar: false,
                    colorIdx: idx % 8 // para asignar color consistente por proyecto en el frontend
                });
            });
        });

        res.json(eventos);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /herreria/calendario/proyectos
// Vista general por PROYECTO (no por tarea): una línea por proyecto desde su
// fecha real de inicio hasta hoy o hasta que terminó, más los HITOS — tareas
// tipo RESTRICCION (ejecución) ya completadas, y las PRELIMINARES (cerradas o
// en curso) como marcas puntuales, para que el avance se vea desde el día 1,
// no recién cuando arranca la fase de ejecución.
router.get('/calendario/proyectos', proteger, async (req, res) => {
    try {
        const proyectos = await Proyecto.findAll({
            where: { estado: { [Op.in]: ['ACTIVO', 'PAUSADO', 'TERMINADO'] } },
            include: [{ model: Tarea, as: 'Tareas', required: false }]
        });

        const hoy = new Date().toISOString().split('T')[0];
        const resultado = [];

        proyectos.forEach((p, idx) => {
            const todasActivadas = (p.Tareas || []).filter(t => t.activadaEn);
            // El inicio del proyecto es la primera tarea activada de CUALQUIER
            // fase — normalmente una preliminar, ya que arrancan primero.
            // Si no hay ninguna tarea activada todavía, se usa activadoEn del
            // proyecto como respaldo (por si se activó pero aún no corrió nada).
            let fechaInicio = null;
            if (todasActivadas.length) {
                fechaInicio = todasActivadas
                    .map(t => t.activadaEn)
                    .sort((a, b) => new Date(a) - new Date(b))[0];
            } else if (p.activadoEn) {
                fechaInicio = p.activadoEn;
            } else {
                return; // ni tareas activadas ni proyecto activado — nada que dibujar
            }

            const fechaFin = p.estado === 'TERMINADO' && p.terminadoEn
                ? new Date(p.terminadoEn).toISOString().split('T')[0]
                : hoy;

            // Hitos de EJECUCIÓN: tareas tipo RESTRICCION ya completadas.
            const hitosEjecucion = todasActivadas
                .filter(t => t.fase !== 'PRELIMINAR' && t.tipo === 'RESTRICCION' && t.estado === 'COMPLETADA' && t.completadaEn)
                .map(t => ({
                    tareaId: t.id, nombre: t.nombre,
                    fecha: new Date(t.completadaEn).toISOString().split('T')[0],
                    tipo: 'hito',
                }));

            // Hitos de PRELIMINAR: cada preliminar cerrada marca su propio punto,
            // así se ve el avance administrativo día por día, no solo al final.
            const hitosPreliminar = (p.Tareas || [])
                .filter(t => t.fase === 'PRELIMINAR' && t.cerradaEn)
                .map(t => ({
                    tareaId: t.id, nombre: t.nombre,
                    fecha: new Date(t.cerradaEn).toISOString().split('T')[0],
                    tipo: 'preliminar',
                }));

            resultado.push({
                proyectoId: p.id,
                proyectoNombre: p.nombre,
                estado: p.estado,
                inicio: new Date(fechaInicio).toISOString().split('T')[0],
                fin: fechaFin,
                hitos: [...hitosPreliminar, ...hitosEjecucion],
                colorIdx: idx % 8
            });
        });

        res.json(resultado);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// GET /herreria/calendario/excel?desde=YYYY-MM-DD&hasta=YYYY-MM-DD
// Exporta el calendario del rango pedido como planilla Excel
router.get('/calendario/excel', proteger, async (req, res) => {
    try {
        const proyectos = await Proyecto.findAll({
            where: { estado: { [Op.in]: ['ACTIVO', 'PAUSADO', 'TERMINADO'] } },
            include: [{ model: Tarea, as: 'Tareas', where: { fase: { [Op.ne]: 'PRELIMINAR' } }, required: false }]
        });

        const eventos = [];
        proyectos.forEach(p => {
            (p.Tareas || []).forEach(t => {
                if (!t.activadaEn) return;
                const inicio = new Date(t.activadaEn);
                const fin = sumarDiasHabiles(inicio, Math.max(0, t.diasHabiles - 1));
                eventos.push({
                    proyecto: p.nombre, tarea: t.nombre, inicio, fin,
                    estado: t.estado, avance: t.avancePct
                });
            });
        });
        eventos.sort((a, b) => a.inicio - b.inicio);

        const wb = new ExcelJS.Workbook();
        const ws = wb.addWorksheet('Calendario Herrería');
        ws.columns = [
            { width: 30 }, { width: 30 }, { width: 14 }, { width: 14 }, { width: 16 }, { width: 10 }
        ];

        ws.mergeCells('A1:F1');
        const titulo = ws.getCell('A1');
        titulo.value = 'CALENDARIO DE EJECUCIÓN — TALLER DE HERRERÍA';
        titulo.font = { name: 'Arial Black', size: 13, bold: true, color: { argb: 'FFFFFF' } };
        titulo.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '7C3AED' } };
        titulo.alignment = { horizontal: 'left', vertical: 'center' };
        ws.getRow(1).height = 28;

        const hdrs = ['Proyecto', 'Tarea', 'Inicio', 'Fin', 'Estado', 'Avance %'];
        hdrs.forEach((h, i) => {
            const c = ws.getRow(2).getCell(i + 1);
            c.value = h;
            c.font = { bold: true, color: { argb: 'FFFFFF' } };
            c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '334155' } };
            c.alignment = { horizontal: 'center', vertical: 'center' };
        });
        ws.getRow(2).height = 20;

        eventos.forEach((ev, i) => {
            const row = i + 3;
            const vals = [ev.proyecto, ev.tarea, ev.inicio, ev.fin, ev.estado, ev.avance + '%'];
            vals.forEach((v, j) => {
                const c = ws.getRow(row).getCell(j + 1);
                c.value = v;
                if (j === 2 || j === 3) c.numFmt = 'dd/mm/yyyy';
                c.alignment = { horizontal: j < 2 ? 'left' : 'center', vertical: 'center' };
                const s = { style: 'thin', color: { argb: 'CBD5E1' } };
                c.border = { left: s, right: s, top: s, bottom: s };
            });
        });

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename=Calendario_Herreria.xlsx');
        await wb.xlsx.write(res);
        res.end();
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── INFORME ANUAL (incluye proyectos cancelados) ─────────────────────────────
// GET /herreria/informe-anual?anio=2026
// Descarga un Excel con TODOS los proyectos del año, incluidos los CANCELADOS,
// que en cualquier otra vista del sistema están ocultos.
router.get('/informe-anual', proteger, async (req, res) => {
    try {
        const anio = parseInt(req.query.anio) || new Date().getFullYear();
        const desde = new Date(anio, 0, 1);
        const hasta = new Date(anio, 11, 31, 23, 59, 59);

        const proyectos = await Proyecto.findAll({
            where: { createdAt: { [Op.between]: [desde, hasta] } },
            include: [{ model: Tarea, as: 'Tareas' }],
            order: [['createdAt', 'ASC']]
        });

        const wb = new ExcelJS.Workbook();
        const ws = wb.addWorksheet(`Memoria ${anio}`);
        ws.columns = [
            { width: 30 }, { width: 22 }, { width: 16 }, { width: 14 },
            { width: 14 }, { width: 10 }, { width: 30 }
        ];

        ws.mergeCells('A1:G1');
        const titulo = ws.getCell('A1');
        titulo.value = `MEMORIA ANUAL ${anio} — TALLER DE HERRERÍA — TODOS LOS PROYECTOS`;
        titulo.font = { name: 'Arial Black', size: 13, bold: true, color: { argb: 'FFFFFF' } };
        titulo.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '334155' } };
        titulo.alignment = { horizontal: 'left', vertical: 'center' };
        ws.getRow(1).height = 28;

        const hdrs = ['Proyecto', 'Cliente', 'Cargado el', 'Estado', 'Plan (días)', 'Tareas', 'Motivo cancelación'];
        hdrs.forEach((h, i) => {
            const c = ws.getRow(2).getCell(i + 1);
            c.value = h;
            c.font = { bold: true, color: { argb: 'FFFFFF' } };
            c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: '475569' } };
            c.alignment = { horizontal: 'center', vertical: 'center' };
        });
        ws.getRow(2).height = 20;

        proyectos.forEach((p, i) => {
            const row = i + 3;
            const esCancelado = p.estado === 'CANCELADO';
            const vals = [
                p.nombre, p.cliente || '—', p.createdAt, p.estado,
                p.diasHabilesTotales, (p.Tareas || []).length,
                esCancelado ? (p.motivoCancelacion || 'Sin motivo registrado') : ''
            ];
            vals.forEach((v, j) => {
                const c = ws.getRow(row).getCell(j + 1);
                c.value = v;
                if (j === 2) c.numFmt = 'dd/mm/yyyy';
                c.alignment = { horizontal: j === 0 || j === 6 ? 'left' : 'center', vertical: 'center' };
                const s = { style: 'thin', color: { argb: 'CBD5E1' } };
                c.border = { left: s, right: s, top: s, bottom: s };
                if (esCancelado) {
                    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FEE2E2' } };
                    c.font = { color: { argb: '991B1B' } };
                }
            });
        });

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename=Memoria_Herreria_${anio}.xlsx`);
        await wb.xlsx.write(res);
        res.end();
    } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
