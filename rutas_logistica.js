const express  = require('express');
const router   = express.Router();
const { Op }   = require('sequelize');
const ExcelJS  = require('exceljs');
const { Producto, Ubicacion, Stock, Movimiento, Herramienta } = require('./database_logistica');
const { Empleado } = require('./database');

const proteger = (req, res, next) => {
    if (req.session.user) return next();
    res.status(401).send("No autorizado");
};

// ─── HELPERS ─────────────────────────────────────────────────────────────────

async function sincronizarUbicaciones() {
    const empleados = await Empleado.findAll({ attributes: ['obra'], group: ['obra'] });
    for (const emp of empleados) {
        if (emp.obra) {
            const nombreNormalizado = emp.obra.trim().toUpperCase();
            await Ubicacion.findOrCreate({
                where: { nombre: nombreNormalizado },
                defaults: { tipo_ubicacion: 'OBRA' }
            });
        }
    }
}

// Mueve stock entre ubicaciones, lanza error si no alcanza
async function moverStock(productoId, origenId, destinoId, cantidad) {
    const origen = await Stock.findOne({ where: { productoId, ubicacionId: origenId } });
    if (!origen || parseFloat(origen.cantidad) < parseFloat(cantidad)) {
        throw new Error('Stock insuficiente en la ubicación de origen');
    }
    origen.cantidad = parseFloat(origen.cantidad) - parseFloat(cantidad);
    await origen.save();

    const [destino] = await Stock.findOrCreate({
        where: { productoId, ubicacionId: destinoId },
        defaults: { cantidad: 0, stock_inicial: 0 }
    });
    destino.cantidad = parseFloat(destino.cantidad) + parseFloat(cantidad);
    await destino.save();
}

// ─── UBICACIONES ─────────────────────────────────────────────────────────────

router.get('/ubicaciones', proteger, async (req, res) => {
    try {
        await sincronizarUbicaciones();
        const lista = await Ubicacion.findAll({ order: [['tipo_ubicacion','ASC'],['nombre','ASC']] });
        res.json(lista);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Stock disponible en una ubicación específica (para filtrar productos al retirar)
router.get('/stock-en/:ubicacionId', proteger, async (req, res) => {
    try {
        const items = await Stock.findAll({
            where: { ubicacionId: req.params.ubicacionId, cantidad: { [Op.gt]: 0 } },
            include: [{ model: Producto, where: { activo: true } }],
            order: [[Producto, 'nombre', 'ASC']]
        });
        res.json(items);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── PRODUCTOS ───────────────────────────────────────────────────────────────

router.get('/productos', proteger, async (req, res) => {
    try {
        const lista = await Producto.findAll({ where: { activo: true }, order: [['nombre','ASC']] });
        res.json(lista);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

router.post('/productos/baja', proteger, async (req, res) => {
    try {
        await Producto.update({ activo: false }, { where: { id: req.body.productoId } });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ─── INGRESO ─────────────────────────────────────────────────────────────────

router.post('/ingreso', proteger, async (req, res) => {
    try {
        const { nombre, cantidad, ubicacionId, stock_minimo, tipo } = req.body;
        const usuario     = req.session.user.username;
        const tipoProducto = tipo || 'CONSUMIBLE';
        const cant        = parseFloat(cantidad);

        // Buscar sin filtro de activo para poder reactivar productos dados de baja
        let producto = await Producto.findOne({ where: { nombre: nombre.toUpperCase() } });
        if (producto) {
            // Reactivar si estaba de baja y actualizar datos
            producto.activo      = true;
            producto.tipo        = tipoProducto;
            if (stock_minimo) producto.stock_minimo = stock_minimo;
            await producto.save();
        } else {
            producto = await Producto.create({
                nombre: nombre.toUpperCase(),
                stock_minimo: stock_minimo || 0,
                tipo: tipoProducto,
                activo: true
            });
        }

        if (tipoProducto !== 'NO_STOCKEABLE') {
            const [reg] = await Stock.findOrCreate({
                where: { productoId: producto.id, ubicacionId },
                defaults: { cantidad: 0, stock_inicial: 0 }
            });
            reg.cantidad      = parseFloat(reg.cantidad) + cant;
            reg.stock_inicial = parseFloat(reg.stock_inicial) + cant;
            await reg.save();
        }

        await Movimiento.create({
            tipo: 'INGRESO', cantidad: cant, productoId: producto.id,
            ubicacion_destino_id: ubicacionId, usuario, fecha: new Date()
        });

        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ─── TRASLADO ─────────────────────────────────────────────────────────────────
// Mueve stock (consumible o retornable) de una ubicación a otra.
// No genera consumo — el stock sigue existiendo en el destino.

router.post('/traslado', proteger, async (req, res) => {
    try {
        const { productoId, cantidad, ubicacionOrigenId, ubicacionDestinoId } = req.body;
        const usuario = req.session.user.username;

        await moverStock(productoId, ubicacionOrigenId, ubicacionDestinoId, cantidad);

        await Movimiento.create({
            tipo: 'TRASLADO', cantidad, productoId,
            ubicacion_origen_id:  ubicacionOrigenId,
            ubicacion_destino_id: ubicacionDestinoId,
            usuario, fecha: new Date()
        });

        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ─── CONSUMO ──────────────────────────────────────────────────────────────────
// El producto sale del stock definitivamente y se registra en el historial de la obra.

router.post('/consumo', proteger, async (req, res) => {
    try {
        const { productoId, cantidad, ubicacionOrigenId, ubicacionDestinoId } = req.body;
        const usuario = req.session.user.username;

        const reg = await Stock.findOne({ where: { productoId, ubicacionId: ubicacionOrigenId } });
        if (!reg || parseFloat(reg.cantidad) < parseFloat(cantidad)) {
            return res.status(400).json({ success: false, message: 'Stock insuficiente' });
        }
        reg.cantidad = parseFloat(reg.cantidad) - parseFloat(cantidad);
        await reg.save();
        // Si llega a 0, el registro queda en 0 pero no aparece en las vistas (filtro > 0)

        await Movimiento.create({
            tipo: 'CONSUMO', cantidad, productoId,
            ubicacion_origen_id:  ubicacionOrigenId,
            ubicacion_destino_id: ubicacionDestinoId, // obra que consumió
            usuario, fecha: new Date()
        });

        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ─── COMPRA DIRECTA ───────────────────────────────────────────────────────────

router.post('/consumo-directo', proteger, async (req, res) => {
    try {
        const { nombre, cantidad, ubicacionDestinoId } = req.body;
        const usuario = req.session.user.username;

        const [producto] = await Producto.findOrCreate({
            where: { nombre: nombre.toUpperCase() },
            defaults: { tipo: 'CONSUMIBLE', activo: true }
        });

        await Movimiento.create({
            tipo: 'CONSUMO_DIRECTO', cantidad, productoId: producto.id,
            ubicacion_destino_id: ubicacionDestinoId,
            usuario, fecha: new Date()
        });

        res.json({ success: true });
    } catch (e) { res.status(500).json({ success: false, error: e.message }); }
});

// ─── ESTADO GENERAL ───────────────────────────────────────────────────────────

router.get('/estado', proteger, async (req, res) => {
    try {
        await sincronizarUbicaciones();
        const inventario = await Stock.findAll({
            where: { cantidad: { [Op.gt]: 0 } },
            include: [{ model: Producto, where: { activo: true } }, Ubicacion],
            order: [[Ubicacion,'nombre','ASC'],[Producto,'nombre','ASC']]
        });

        const alertas = inventario.filter(item => {
            if (item.Producto.tipo === 'RETORNABLE') return false;
            const inicial = parseFloat(item.stock_inicial) || 0;
            const actual  = parseFloat(item.cantidad);
            return inicial > 0 && actual <= (inicial * 0.30);
        });

        res.json({ inventario, alertas });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── VISTA POR OBRA ───────────────────────────────────────────────────────────

router.get('/vista-obra/:ubicacionId', proteger, async (req, res) => {
    try {
        const { ubicacionId } = req.params;

        const stockObra = await Stock.findAll({
            where: { ubicacionId, cantidad: { [Op.gt]: 0 } },
            include: [{ model: Producto, where: { activo: true } }]
        });

        const movimientos = await Movimiento.findAll({
            where: {
                [Op.or]: [
                    { ubicacion_origen_id: ubicacionId },
                    { ubicacion_destino_id: ubicacionId }
                ]
            },
            include: [Producto],
            order: [['fecha','DESC']],
            limit: 200
        });

        res.json({ stockObra, movimientos });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── REPORTE GLOBAL POR OBRA ──────────────────────────────────────────────────

router.get('/reporte-obras', proteger, async (req, res) => {
    try {
        const movimientos = await Movimiento.findAll({
            include: [Producto],
            order: [['fecha','DESC']]
        });

        // Cargar todas las ubicaciones para resolver nombres
        const todasUbic = await Ubicacion.findAll();
        const mapaUbic = Object.fromEntries(todasUbic.map(u => [u.id, u.nombre]));

        const lista = movimientos.map(mov => ({
            producto:        mov.Producto ? mov.Producto.nombre : '(eliminado)',
            tipo_producto:   mov.Producto ? mov.Producto.tipo : '-',
            tipo_movimiento: mov.tipo,
            cantidad:        mov.cantidad,
            origen:          mapaUbic[mov.ubicacion_origen_id]  || '-',
            destino:         mapaUbic[mov.ubicacion_destino_id] || '-',
            fecha:           mov.fecha,
            usuario:         mov.usuario
        }));

        res.json(lista);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── EXCEL: UBICACIÓN ESPECÍFICA ─────────────────────────────────────────────

router.get('/excel/ubicacion/:ubicacionId', proteger, async (req, res) => {
    try {
        const ubicacion = await Ubicacion.findByPk(req.params.ubicacionId);
        if (!ubicacion) return res.status(404).send('Ubicación no encontrada');

        const stock = await Stock.findAll({
            where: { ubicacionId: ubicacion.id, cantidad: { [Op.gt]: 0 } },
            include: [{ model: Producto, where: { activo: true } }],
            order: [[Producto,'tipo','ASC'],[Producto,'nombre','ASC']]
        });

        const movimientos = await Movimiento.findAll({
            where: {
                [Op.or]: [
                    { ubicacion_origen_id: ubicacion.id },
                    { ubicacion_destino_id: ubicacion.id }
                ]
            },
            include: [Producto],
            order: [['fecha','DESC']]
        });

        // Resolver nombres de ubicaciones
        const todasUbic = await Ubicacion.findAll();
        const mapaUbic = Object.fromEntries(todasUbic.map(u => [u.id, u.nombre]));

        const wb = new ExcelJS.Workbook();
        agregarHojaStock(wb, `Stock - ${ubicacion.nombre}`, stock);
        agregarHojaMovimientos(wb, `Movimientos - ${ubicacion.nombre}`, movimientos, mapaUbic);

        res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition',`attachment; filename=Stock_${ubicacion.nombre.replace(/\s/g,'_')}.xlsx`);
        await wb.xlsx.write(res);
        res.end();
    } catch (e) { res.status(500).send(e.message); }
});

// ─── EXCEL: GENERAL (todas las ubicaciones) ───────────────────────────────────

router.get('/excel/general', proteger, async (req, res) => {
    try {
        const stock = await Stock.findAll({
            where: { cantidad: { [Op.gt]: 0 } },
            include: [{ model: Producto, where: { activo: true } }, Ubicacion],
        });

        // Ordenar: OFICINA primero, luego depósitos, luego obras, todo alfabético dentro de cada grupo
        stock.sort((a, b) => {
            const aNombre = a.Ubicacion.nombre.toUpperCase();
            const bNombre = b.Ubicacion.nombre.toUpperCase();
            const aEsOficina = aNombre === 'OFICINA';
            const bEsOficina = bNombre === 'OFICINA';
            if (aEsOficina && !bEsOficina) return -1;
            if (!aEsOficina && bEsOficina) return 1;
            // Luego depósitos antes que obras
            const aDeposito = a.Ubicacion.tipo_ubicacion === 'DEPOSITO';
            const bDeposito = b.Ubicacion.tipo_ubicacion === 'DEPOSITO';
            if (aDeposito && !bDeposito) return -1;
            if (!aDeposito && bDeposito) return 1;
            // Dentro del mismo grupo, alfabético por ubicación, luego tipo producto, luego nombre
            if (aNombre !== bNombre) return aNombre.localeCompare(bNombre);
            const aTipo = a.Producto.tipo;
            const bTipo = b.Producto.tipo;
            if (aTipo !== bTipo) return aTipo.localeCompare(bTipo);
            return a.Producto.nombre.localeCompare(b.Producto.nombre);
        });

        const movimientos = await Movimiento.findAll({
            include: [Producto],
            order: [['fecha','DESC']]
        });

        // Resolver nombres de ubicaciones
        const todasUbic = await Ubicacion.findAll();
        const mapaUbic = Object.fromEntries(todasUbic.map(u => [u.id, u.nombre]));

        const wb = new ExcelJS.Workbook();
        agregarHojaStockGeneral(wb, stock);
        agregarHojaMovimientos(wb, 'Historial completo', movimientos, mapaUbic);

        res.setHeader('Content-Type','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition','attachment; filename=Logistica_General.xlsx');
        await wb.xlsx.write(res);
        res.end();
    } catch (e) { res.status(500).send(e.message); }
});

// ─── HELPERS EXCEL ────────────────────────────────────────────────────────────

function estiloHeader(cell, color) {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: color } };
    cell.alignment = { horizontal: 'center', vertical: 'middle' };
}

function agregarHojaStock(wb, nombre, stock) {
    const ws = wb.addWorksheet(nombre.substring(0,31));
    ws.columns = [
        { header: 'TIPO',     key: 'tipo',     width: 15 },
        { header: 'PRODUCTO', key: 'producto',  width: 35 },
        { header: 'CANTIDAD', key: 'cantidad',  width: 14 },
        { header: 'UNIDAD',   key: 'unidad',    width: 12 },
    ];
    ws.getRow(1).height = 24;
    ws.getRow(1).eachCell(cell => estiloHeader(cell, 'FF1E3A8A'));

    // Separar consumibles de retornables
    const consumibles  = stock.filter(s => s.Producto.tipo !== 'RETORNABLE');
    const retornables  = stock.filter(s => s.Producto.tipo === 'RETORNABLE');

    if (consumibles.length) {
        const sep = ws.addRow(['── CONSUMIBLES ──','','','']);
        sep.getCell(1).font = { bold: true, italic: true, color: { argb: 'FF6B7280' } };
        sep.getCell(1).fill = { type:'pattern', pattern:'solid', fgColor:{ argb:'FFF1F5F9' } };
        ws.mergeCells(`A${sep.number}:D${sep.number}`);
        consumibles.forEach(s => {
            const r = ws.addRow({ tipo: s.Producto.tipo, producto: s.Producto.nombre, cantidad: parseFloat(s.cantidad), unidad: s.Producto.unidad });
            r.eachCell(c => { c.border = { top:{style:'thin'}, left:{style:'thin'}, bottom:{style:'thin'}, right:{style:'thin'} }; c.alignment = { horizontal:'center' }; });
            r.getCell(2).alignment = { horizontal:'left' };
        });
    }
    if (retornables.length) {
        const sep = ws.addRow(['── RETORNABLES / HERRAMIENTAS ──','','','']);
        sep.getCell(1).font = { bold: true, italic: true, color: { argb: 'FF6B7280' } };
        sep.getCell(1).fill = { type:'pattern', pattern:'solid', fgColor:{ argb:'FFF5F3FF' } };
        ws.mergeCells(`A${sep.number}:D${sep.number}`);
        retornables.forEach(s => {
            const r = ws.addRow({ tipo: s.Producto.tipo, producto: s.Producto.nombre, cantidad: parseFloat(s.cantidad), unidad: s.Producto.unidad });
            r.eachCell(c => { c.border = { top:{style:'thin'}, left:{style:'thin'}, bottom:{style:'thin'}, right:{style:'thin'} }; c.alignment = { horizontal:'center' }; });
            r.getCell(2).alignment = { horizontal:'left' };
        });
    }
}

function agregarHojaStockGeneral(wb, stock) {
    const ws = wb.addWorksheet('Stock General');
    ws.columns = [
        { header: 'UBICACIÓN',       key: 'ubicacion', width: 20 },
        { header: 'TIPO UBICACIÓN',  key: 'tipoUbic',  width: 12 },
        { header: 'TIPO PRODUCTO',   key: 'tipo',      width: 15 },
        { header: 'PRODUCTO',        key: 'producto',  width: 35 },
        { header: 'CANTIDAD',        key: 'cantidad',  width: 14 },
        { header: 'UNIDAD',          key: 'unidad',    width: 12 },
    ];
    ws.getRow(1).height = 24;
    ws.getRow(1).eachCell(cell => estiloHeader(cell, 'FF1E3A8A'));

    const consumibles = stock.filter(s => s.Producto.tipo !== 'RETORNABLE');
    const retornables = stock.filter(s => s.Producto.tipo === 'RETORNABLE');

    const agregarGrupo = (lista, label, color) => {
        if (!lista.length) return;
        const sep = ws.addRow([label,'','','','','']);
        sep.getCell(1).font = { bold: true, italic: true, color: { argb: 'FF6B7280' } };
        sep.getCell(1).fill = { type:'pattern', pattern:'solid', fgColor:{ argb: color } };
        ws.mergeCells(`A${sep.number}:F${sep.number}`);
        lista.forEach(s => {
            const r = ws.addRow({
                ubicacion: s.Ubicacion.nombre,
                tipoUbic:  s.Ubicacion.tipo_ubicacion,
                tipo:      s.Producto.tipo,
                producto:  s.Producto.nombre,
                cantidad:  parseFloat(s.cantidad),
                unidad:    s.Producto.unidad
            });
            r.eachCell(c => { c.border = { top:{style:'thin'}, left:{style:'thin'}, bottom:{style:'thin'}, right:{style:'thin'} }; c.alignment = { horizontal:'center' }; });
            r.getCell(4).alignment = { horizontal:'left' };
        });
    };

    agregarGrupo(consumibles, '── CONSUMIBLES ──', 'FFF1F5F9');
    agregarGrupo(retornables, '── RETORNABLES / HERRAMIENTAS ──', 'FFF5F3FF');
}

function agregarHojaMovimientos(wb, nombre, movimientos, mapaUbic) {
    const ws = wb.addWorksheet(nombre.substring(0,31));
    ws.columns = [
        { header: 'FECHA',      key: 'fecha',    width: 20 },
        { header: 'TIPO',       key: 'tipo',     width: 18 },
        { header: 'PRODUCTO',   key: 'producto', width: 30 },
        { header: 'CANTIDAD',   key: 'cantidad', width: 12 },
        { header: 'ORIGEN',     key: 'origen',   width: 22 },
        { header: 'DESTINO',    key: 'destino',  width: 22 },
        { header: 'USUARIO',    key: 'usuario',  width: 15 },
    ];
    ws.getRow(1).height = 24;
    ws.getRow(1).eachCell(cell => estiloHeader(cell, 'FF4B5563'));

    const colorTipo = {
        INGRESO:         'FF059669',
        CONSUMO:         'FFDC2626',
        CONSUMO_DIRECTO: 'FFEA580C',
        TRASLADO:        'FF2563EB'
    };

    movimientos.forEach(m => {
        const fecha = new Date(m.fecha);
        const fechaStr = `${fecha.toLocaleDateString('es-AR')} ${fecha.toLocaleTimeString('es-AR',{hour:'2-digit',minute:'2-digit'})}`;
        const r = ws.addRow({
            fecha:    fechaStr,
            tipo:     m.tipo,
            producto: m.Producto ? m.Producto.nombre : '(eliminado)',
            cantidad: parseFloat(m.cantidad),
            origen:   (mapaUbic && mapaUbic[m.ubicacion_origen_id])  || '-',
            destino:  (mapaUbic && mapaUbic[m.ubicacion_destino_id]) || '-',
            usuario:  m.usuario
        });
        r.eachCell(c => {
            c.border = { top:{style:'thin'}, left:{style:'thin'}, bottom:{style:'thin'}, right:{style:'thin'} };
            c.alignment = { horizontal:'center' };
        });
        r.getCell(3).alignment = { horizontal:'left' };
        // Color suave de fondo según tipo
        const color = colorTipo[m.tipo];
        if (color) {
            r.getCell(2).font = { bold: true, color: { argb: 'FF' + color.slice(2) } };
        }
    });
}

// ─── HERRAMIENTAS ────────────────────────────────────────────────────────────

// Renombrar o fusionar producto
router.post('/productos/renombrar', proteger, async (req, res) => {
    try {
        const { productoId, nuevoNombre } = req.body;
        if (!nuevoNombre || !nuevoNombre.trim()) return res.status(400).json({ error: 'Nombre vacío' });
        const nombreFinal = nuevoNombre.trim().toUpperCase();

        // Ver si ya existe otro producto con ese nombre
        const existente = await Producto.findOne({ where: { nombre: nombreFinal } });

        if (existente && existente.id !== parseInt(productoId)) {
            // FUSIONAR: mover todo del productoId al existente
            const { Op: OpLocal } = require('sequelize');

            // 1. Stocks: sumar cantidades si ya hay stock del existente en la misma ubicación
            const stocksOrigen = await Stock.findAll({ where: { productoId } });
            for (const so of stocksOrigen) {
                const stockDest = await Stock.findOne({ where: { productoId: existente.id, ubicacionId: so.ubicacionId } });
                if (stockDest) {
                    stockDest.cantidad      = parseFloat(stockDest.cantidad)      + parseFloat(so.cantidad);
                    stockDest.stock_inicial = parseFloat(stockDest.stock_inicial) + parseFloat(so.stock_inicial);
                    await stockDest.save();
                    await so.destroy();
                } else {
                    await so.update({ productoId: existente.id });
                }
            }

            // 2. Movimientos
            await Movimiento.update({ productoId: existente.id }, { where: { productoId } });

            // 3. Herramientas
            await Herramienta.update({ productoId: existente.id }, { where: { productoId } });

            // 4. Eliminar el producto duplicado
            await Producto.destroy({ where: { id: productoId } });

            return res.json({ success: true, fusionado: true, nombre: nombreFinal });
        }

        // Si no existe o es el mismo, solo renombrar
        await Producto.update({ nombre: nombreFinal }, { where: { id: productoId } });
        res.json({ success: true, fusionado: false, nombre: nombreFinal });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Resumen de herramientas agrupado por producto (para stock general)
router.get('/herramientas/resumen', proteger, async (req, res) => {
    try {
        const lista = await Herramienta.findAll({
            where: { estado: { [Op.ne]: 'BAJA' } },
            include: [
                { model: Producto, attributes: ['id','nombre'] },
                { model: Ubicacion, attributes: ['id','nombre'], required: false }
            ]
        });
        // Agrupar por producto
        const grupos = {};
        lista.forEach(h => {
            const pid = h.productoId;
            if (!grupos[pid]) grupos[pid] = {
                productoId: pid,
                producto: h.Producto.nombre,
                categoria: h.categoria,
                total: 0, disponibles: 0, en_obra: 0, reparacion: 0,
                detalle: []
            };
            grupos[pid].total++;
            if (h.estado === 'DISPONIBLE') grupos[pid].disponibles++;
            if (h.estado === 'EN_OBRA')    grupos[pid].en_obra++;
            if (h.estado === 'REPARACION') grupos[pid].reparacion++;
            grupos[pid].detalle.push({
                nro_serie: h.nro_serie,
                estado: h.estado,
                ubicacion: h.Ubicacion ? h.Ubicacion.nombre : '-'
            });
        });

        res.json(Object.values(grupos));
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Listar todas las herramientas con producto y ubicación actual
router.get('/herramientas', proteger, async (req, res) => {
    try {
        const lista = await Herramienta.findAll({
            where: { estado: { [Op.ne]: 'BAJA' } },
            include: [
                { model: Producto, attributes: ['id','nombre'] },
                { model: Ubicacion, attributes: ['id','nombre'], required: false }
            ],
            order: [[Producto,'nombre','ASC'],['nro_serie','ASC']]
        });
        res.json(lista);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Productos que ya tienen herramientas registradas (para selector en formulario)
router.get('/herramientas/productos', proteger, async (req, res) => {
    try {
        const productos = await Producto.findAll({
            where: { tipo: 'RETORNABLE', activo: true },
            attributes: ['id','nombre'],
            order: [['nombre','ASC']]
        });
        res.json(productos);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Registrar nueva herramienta (ingreso con nro de serie)
router.post('/herramientas/ingresar', proteger, async (req, res) => {
    try {
        const { productoNombre, nro_serie, ubicacionId, observaciones, categoria, usuario } = req.body;
        if (!productoNombre || !nro_serie || !ubicacionId) return res.status(400).json({ error: 'Faltan datos' });

        let producto = await Producto.findOne({ where: { nombre: productoNombre.toUpperCase() } });
        if (producto) {
            producto.activo = true;
            producto.tipo = 'RETORNABLE';
            await producto.save();
        } else {
            producto = await Producto.create({ nombre: productoNombre.toUpperCase(), tipo: 'RETORNABLE', activo: true });
        }

        const existe = await Herramienta.findOne({ where: { nro_serie } });
        if (existe) return res.status(400).json({ error: `El número de serie ${nro_serie} ya existe` });

        const herramienta = await Herramienta.create({
            nro_serie,
            categoria: categoria || 'ELECTRICA',
            estado: 'DISPONIBLE',
            observaciones: observaciones || null,
            productoId: producto.id,
            ubicacionId
        });

        await Movimiento.create({
            tipo: 'INGRESO', cantidad: 1,
            ubicacion_destino_id: ubicacionId,
            usuario, herramienta_id: herramienta.id,
            nro_serie, productoId: producto.id, fecha: new Date()
        });

        res.json({ success: true, herramienta });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Herramientas por ubicación (para stock por obra)
router.get('/herramientas/ubicacion/:ubicacionId', proteger, async (req, res) => {
    try {
        const lista = await Herramienta.findAll({
            where: { ubicacionId: req.params.ubicacionId, estado: { [Op.ne]: 'BAJA' } },
            include: [{ model: Producto, attributes: ['nombre'] }],
            order: [['categoria','ASC'],['nro_serie','ASC']]
        });        res.json(lista);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Mover herramienta a otra ubicación
router.post('/herramientas/mover', proteger, async (req, res) => {
    try {
        const { herramientaId, ubicacionDestinoId, usuario } = req.body;
        const herramienta = await Herramienta.findByPk(herramientaId, { include: [Ubicacion] });
        if (!herramienta) return res.status(404).json({ error: 'Herramienta no encontrada' });

        const destino = await Ubicacion.findByPk(ubicacionDestinoId);
        const nuevoEstado = destino.tipo_ubicacion === 'OBRA' ? 'EN_OBRA' : 'DISPONIBLE';

        await Movimiento.create({
            tipo: 'TRASLADO',
            cantidad: 1,
            ubicacion_origen_id: herramienta.ubicacionId,
            ubicacion_destino_id: ubicacionDestinoId,
            usuario,
            herramienta_id: herramienta.id,
            nro_serie: herramienta.nro_serie,
            productoId: herramienta.productoId,
            fecha: new Date()
        });

        herramienta.ubicacionId = ubicacionDestinoId;
        herramienta.estado = nuevoEstado;
        await herramienta.save();

        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Cambiar estado de herramienta (REPARACION, BAJA, DISPONIBLE)
router.post('/herramientas/estado', proteger, async (req, res) => {
    try {
        const { herramientaId, estado, observaciones, usuario } = req.body;
        const herramienta = await Herramienta.findByPk(herramientaId);
        if (!herramienta) return res.status(404).json({ error: 'No encontrada' });

        herramienta.estado = estado;
        if (observaciones !== undefined) herramienta.observaciones = observaciones;
        await herramienta.save();

        await Movimiento.create({
            tipo: estado === 'BAJA' ? 'BAJA' : 'CAMBIO_ESTADO',
            cantidad: 1,
            ubicacion_origen_id: herramienta.ubicacionId,
            usuario,
            herramienta_id: herramienta.id,
            nro_serie: herramienta.nro_serie,
            productoId: herramienta.productoId,
            fecha: new Date()
        });

        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

module.exports = router;
