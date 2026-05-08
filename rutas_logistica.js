const express = require('express');
const router = express.Router();
// Importamos desde el nuevo archivo de base de datos independiente
const { Producto, Deposito, Stock, Movimiento } = require('./database_logistica');

// Función para proteger las rutas (usa la sesión del index.js principal)
const proteger = (req, res, next) => {
    if (req.session.user) return next();
    res.status(401).send("No autorizado");
};

// 1. CARGAR INGRESO (Compra o entrada a depósito)
router.post('/ingreso', proteger, async (req, res) => {
    try {
        const { nombre, cantidad, depositoId, stock_minimo, es_stockeable } = req.body;
        const usuarioActual = req.session.user.username;

        // Buscamos o creamos el producto en el catálogo
        const [producto, creado] = await Producto.findOrCreate({
            where: { nombre: nombre.toUpperCase() },
            defaults: { 
                stock_minimo: stock_minimo || 0, 
                es_stockeable: es_stockeable ?? true 
            }
        });

        // Si es un producto que se guarda en depósito, actualizamos la tabla Stocks
        if (producto.es_stockeable) {
            const [regStock, _] = await Stock.findOrCreate({
                where: { productoId: producto.id, depositoId: depositoId },
                defaults: { cantidad: 0 }
            });
            regStock.cantidad = parseFloat(regStock.cantidad) + parseFloat(cantidad);
            await regStock.save();
        }

        // Registramos el movimiento (el historial)
        await Movimiento.create({
            tipo: 'INGRESO',
            cantidad: cantidad,
            productoId: producto.id,
            depositoId: depositoId,
            usuario: usuarioActual
        });

        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// 2. REGISTRAR CONSUMO (Salida a obra o uso directo)
router.post('/consumo', proteger, async (req, res) => {
    try {
        const { productoId, cantidad, depositoId, destino_obra } = req.body;
        const usuarioActual = req.session.user.username;

        // 1. Buscamos el producto para ver si es stockeable
        const producto = await Producto.findByPk(productoId);
        
        if (producto.es_stockeable) {
            const regStock = await Stock.findOne({
                where: { productoId, depositoId }
            });

            if (!regStock || regStock.cantidad < cantidad) {
                return res.status(400).json({ success: false, message: "Stock insuficiente" });
            }

            regStock.cantidad = parseFloat(regStock.cantidad) - parseFloat(cantidad);
            await regStock.save();
        }

        // 2. Registramos el consumo en el historial
        await Movimiento.create({
            tipo: 'CONSUMO',
            cantidad: cantidad,
            productoId: productoId,
            depositoId: depositoId,
            destino_obra: destino_obra,
            usuario: usuarioActual
        });

        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// 3. CONSULTAR ESTADO Y ALERTAS (El 30%)
router.get('/estado', proteger, async (req, res) => {
    try {
        const inventario = await Stock.findAll({
            include: [Producto, Deposito]
        });

        // Calculamos las alertas del 30%
        const alertas = inventario.filter(item => {
            const min = parseFloat(item.Producto.stock_minimo);
            const actual = parseFloat(item.cantidad);
            return min > 0 && actual <= (min * 0.30);
        });

        res.json({ inventario, alertas });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});
// --- RUTA 4: REPORTE DE CONSUMO POR OBRA ---
router.get('/reporte-obras', proteger, async (req, res) => {
    try {
        const consumos = await Movimiento.findAll({
            where: { tipo: 'CONSUMO' },
            include: [Producto],
            order: [['fecha', 'DESC']]
        });
        
        // Agrupamos los datos por obra para que sea fácil de leer
        const reporte = consumos.reduce((acc, mov) => {
            const obra = mov.destino_obra || 'SIN ESPECIFICAR';
            if (!acc[obra]) acc[obra] = [];
            acc[obra].push(mov);
            return acc;
        }, {});

        res.json(reporte);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// --- RUTA 5: ESTADÍSTICAS GENERALES ---
router.get('/estadisticas', proteger, async (req, res) => {
    try {
        const totalMovimientos = await Movimiento.count();
        const productosBajoMinimo = await Stock.count({
            // Aquí podrías sumar lógica más compleja, pero por ahora damos el conteo total
        });
        
        res.json({
            totalMovimientos,
            fechaActual: new Date()
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});
module.exports = router;