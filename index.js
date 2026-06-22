const express = require('express');
const session = require('express-session'); // <-- ESTA ES LA LÍNEA QUE FALTA
const { sequelize, Empleado, Hora, Usuario } = require('./database');
const { obtenerCorteQuincena } = require('./logicafechas');
const { Op } = require('sequelize');
const { addDays, startOfMonth, endOfMonth } = require('date-fns');
const ExcelJS = require('exceljs');
const { sequelize: dbLogistica } = require('./database_logistica');
const rutasHerreria = require('./rutas_herreria');

const app = express();
app.use(express.json());
app.use(express.static('public'));

// 1. Configurar la sesión
app.use(session({
    secret: 'fhol-secreto-ultra-seguro',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false } // Ponelo en false para trabajar en localhost
}));
app.use('/herreria', rutasHerreria);

// 2. DEFINIR LA FUNCIÓN PROTEGER (Importante que esté ACÁ)
const proteger = (req, res, next) => {
    if (req.session.user) return next();
    res.status(401).send("No autorizado");
};

// 3. DEFINIR LA FUNCIÓN login
app.post('/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        const user = await Usuario.findOne({ where: { username, password } });

        if (user) {
            req.session.user = { id: user.id, username: user.username, rol: user.rol, modulos: user.modulos };
            res.json({ success: true, rol: user.rol, modulos: user.modulos });
        } else {
            res.status(401).json({ success: false, message: "Usuario o clave incorrectos" });
        }
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.post('/logout', (req, res) => {
    req.session.destroy();
    res.json({ success: true });
});

// Devuelve info del usuario logueado (para que los frontends sepan quién es)
app.get('/me', (req, res) => {
    if (!req.session.user) return res.status(401).json({ logueado: false });
    res.json({ logueado: true, username: req.session.user.username, rol: req.session.user.rol, modulos: req.session.user.modulos });
});

// RUTAS
app.get('/empleados', proteger, async (req, res) => { // <--- AGREGADO AQUÍ
    const lista = await Empleado.findAll({ where: { activo: true } });
    res.json(lista);
});

app.post('/empleados', proteger, async (req, res) => { // Agregué "proteger" por seguridad
    try {
        // Forzamos que al crearse esté activo
        const datos = { ...req.body, activo: true };
        const nuevo = await Empleado.create(datos);
        res.json(nuevo);
    } catch (e) { res.status(500).send(e.message); }
});

// Cambiar obra de un empleado
app.post('/empleados/cambiar-obra', proteger, async (req, res) => {
    try {
        const { id, obra } = req.body;
        await Empleado.update({ obra }, { where: { id } });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.post('/cargar-horas', proteger, async (req, res) => {
    try {
        let { empleadoId, fecha, cantidadHoras, estado } = req.body;

        const estadoFinal = estado || 'NORMAL';
        let valorNumerico = 0;
        if (estadoFinal === 'NORMAL') {
            if (typeof cantidadHoras === 'string') cantidadHoras = cantidadHoras.replace(',', '.');
            valorNumerico = parseFloat(cantidadHoras) || 0;
        }

        const usuarioActual = (req.session.user && req.session.user.username) ? req.session.user.username : 'admin';

        const [registro, creado] = await Hora.findOrCreate({
            where: { EmpleadoId: empleadoId, fecha: fecha },
            defaults: { cantidadHoras: valorNumerico, cargadoPor: usuarioActual, estado: estadoFinal }
        });

        if (!creado) {
            registro.cantidadHoras = valorNumerico;
            registro.cargadoPor    = usuarioActual;
            registro.estado        = estadoFinal;
            await registro.save();
        }

        res.json({ success: true, data: registro });

    } catch (e) { 
        console.error("Error crítico al cargar horas:", e);
        res.status(500).json({ success: false, message: e.message }); 
    }
});

// RUTA PARA DAR DE BAJA (BAJA LÓGICA)
app.post('/empleados/desactivar', proteger, async (req, res) => {
    try {
        const { id } = req.body;
        // Actualizamos a activo: false
        await Empleado.update({ activo: false }, { where: { id } });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// REPORTE PARA LA QUINCENA
app.get('/reporte', async (req, res) => {
    try {
        const { mes, anio, q } = req.query;
        const corte = obtenerCorteQuincena(parseInt(mes), parseInt(anio));
        
        // Definimos el rango según la quincena 1 o 2
        let desde = (q === "1") ? startOfMonth(new Date(anio, mes-1, 1)) : addDays(corte, 1);
        let hasta = (q === "1") ? corte : endOfMonth(new Date(anio, mes-1, 1));

        // Buscamos empleados y sus horas en ese rango
        const empleados = await Empleado.findAll({
           where: {
             [Op.or]: [
              { activo: true }, // Caso A: Sigue trabajando
              { '$Horas.id$': { [Op.ne]: null } } // Caso B: Ya no trabaja pero tiene horas cargadas
             ]
            },
           include: [{
           model: Hora,
             where: { fecha: { [Op.between]: [desde, hasta] } },
             required: false // Importante: para que no oculte a los activos que aún no cargaron horas
           }],
           subQuery: false // Obligatorio cuando usamos filtros en modelos relacionados
        });

        // Formateamos la respuesta para que sea fácil de leer en la tabla
        const resultado = empleados.map(emp => {
            const totalHoras = emp.Horas.reduce((sum, h) => sum + parseFloat(h.cantidadHoras), 0);
            return {
                nombre: `${emp.apellido}, ${emp.nombre}`,
                obra: emp.obra,
                totalHoras: totalHoras
            };
        });

        res.json({
            rango: { 
                desde: desde.toISOString().split('T')[0], 
                hasta: hasta.toISOString().split('T')[0] 
            },
            datos: resultado
        });
    } catch (e) { res.status(500).send(e.message); }
});

// Ruta para consultar si ya hay horas en un día
app.get('/consultar-horas', async (req, res) => {
    try {
        const { empleadoId, fecha } = req.query;
        const registro = await Hora.findOne({
            where: { EmpleadoId: empleadoId, fecha: fecha }
        });
        res.json(registro || { cantidadHoras: 0, estado: 'NORMAL' });
    } catch (e) { res.status(500).send(e.message); }
});

// Ruta para exportas a excel
app.get('/descargar-excel', async (req, res) => {
    try {
        const { mes, anio, q } = req.query;
        const anioInt = parseInt(anio);
        const mesInt = parseInt(mes);
        const corte = obtenerCorteQuincena(mesInt, anioInt);
        
        let desde = (q === "1") ? startOfMonth(new Date(anioInt, mesInt-1, 1)) : addDays(corte, 1);
        let hasta = (q === "1") ? corte : endOfMonth(new Date(anioInt, mesInt-1, 1));

        const empleados = await Empleado.findAll({
          where: {
             [Op.or]: [
               { activo: true },
               { '$Horas.id$': { [Op.ne]: null } }
             ]  
            },
           include: [{
             model: Hora,
             where: { fecha: { [Op.between]: [desde, hasta] } },
              required: false
          }],
          subQuery: false, // Evita errores de SQL con el LIMIT/OFFSET interno de Sequelize
          order: [['apellido', 'ASC']] // De paso, los ordenamos alfabéticamente
        });

        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Asistencia');

        // 1. GENERAR LA LISTA DE DÍAS (esto es la base de todo)
        let diasRango = [];
        let aux = new Date(desde);
        const feriados = ['2026-03-24', '2026-04-02', '2026-04-03']; 

        while (aux <= hasta) {
            const fechaStr = aux.toISOString().split('T')[0];
            const diaNombre = new Intl.DateTimeFormat('es-ES', { weekday: 'short' }).format(aux);
            const nroDia = aux.getDate();
            diasRango.push({
                fechaStr,
                header: `${diaNombre.toUpperCase()} ${nroDia < 10 ? '0'+nroDia : nroDia}`,
                esEspecial: (aux.getDay() === 0 || aux.getDay() === 6 || feriados.includes(fechaStr))
            });
            aux.setDate(aux.getDate() + 1);
        }

        // 2. CONFIGURAR COLUMNAS DEL EXCEL
        let colsConfig = [
            { header: 'APELLIDO Y NOMBRE', key: 'nombre', width: 35 },
            { header: 'OBRA', key: 'obra', width: 15 }
        ];
        // Sumamos los días
        diasRango.forEach(d => {
            colsConfig.push({ header: d.header, key: d.fechaStr, width: 10 });
        });
        // Sumamos el total
        colsConfig.push({ header: 'TOTAL HS', key: 'total', width: 12 });

        worksheet.columns = colsConfig;

        // 3. TÍTULO GIGANTE (Fila 1)
        const mesesNombres = ["ENERO", "FEBRERO", "MARZO", "ABRIL", "MAYO", "JUNIO", "JULIO", "AGOSTO", "SEPTIEMBRE", "OCTUBRE", "NOVIEMBRE", "DICIEMBRE"];
        const textoMes = mesesNombres[mesInt - 1];
        const textoQuincena = q === "1" ? "1RA QUINCENA" : "2DA QUINCENA";

        worksheet.insertRow(1, []); // Insertamos una fila vacía arriba para el título
        worksheet.mergeCells(1, 1, 1, colsConfig.length); 
        const celdaTitulo = worksheet.getCell('A1');
        celdaTitulo.value = `PLANILLA DE ASISTENCIA - ${textoQuincena} - ${textoMes} ${anioInt}`;
        celdaTitulo.font = { name: 'Arial Black', size: 16, color: { argb: 'FF1E3A8A' } };
        celdaTitulo.alignment = { horizontal: 'center', vertical: 'middle' };
        worksheet.getRow(1).height = 45;

        // 4. ESTILO DE ENCABEZADOS DE TABLA (Ahora están en la Fila 2)
        const headerRow = worksheet.getRow(2);
        headerRow.height = 30;
        colsConfig.forEach((col, index) => {
            const cell = headerRow.getCell(index + 1);
            cell.value = col.header; // Forzamos el nombre porque insertRow lo puede mover
            cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
            cell.alignment = { horizontal: 'center', vertical: 'middle' };
            
            let bgColor = 'FF1E3A8A'; // Azul inicial
            if (index > 1 && index < colsConfig.length - 1) {
                const dia = diasRango[index - 2];
                bgColor = dia.esEspecial ? 'FFEF4444' : 'FF4B5563'; // Rojo o Gris
            }
            if (index === colsConfig.length - 1) bgColor = 'FF059669'; // Verde total
            
            cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: bgColor } };
        });

        // 5. CARGAR LOS EMPLEADOS
        empleados.forEach(emp => {
            let rowData = {
                nombre: `${emp.apellido.toUpperCase()}, ${emp.nombre}`,
                obra: emp.obra || '-'
            };
            let sumaHoras = 0;
            diasRango.forEach(dia => {
                const registro = emp.Horas.find(h => h.fecha === dia.fechaStr);
                if (registro) {
                    const est = registro.estado || 'NORMAL';
                    if (est === 'ENFERMO') {
                        rowData[dia.fechaStr] = 'E';
                    } else if (est === 'LLUVIA') {
                        rowData[dia.fechaStr] = 'LL';
                    } else {
                        const hs = parseFloat(registro.cantidadHoras) || 0;
                        rowData[dia.fechaStr] = hs > 0 ? hs : '-';
                        sumaHoras += hs;
                    }
                } else {
                    rowData[dia.fechaStr] = '-';
                }
            });
            rowData['total'] = sumaHoras;

            const row = worksheet.addRow(rowData);
            row.eachCell((cell, colNumber) => {
                cell.border = { top:{style:'thin'}, left:{style:'thin'}, bottom:{style:'thin'}, right:{style:'thin'} };
                cell.alignment = { horizontal: 'center' };
                if (colNumber > 2 && colNumber < colsConfig.length) {
                    const dia = diasRango[colNumber - 3];
                    if (dia.esEspecial) {
                        cell.fill = { type:'pattern', pattern:'solid', fgColor:{ argb:'FFFEE2E2' } };
                    } else if (cell.value === 'E') {
                        cell.fill = { type:'pattern', pattern:'solid', fgColor:{ argb:'FFFEF9C3' } }; // amarillo enfermo
                        cell.font = { bold: true, color: { argb:'FFB45309' } };
                    } else if (cell.value === 'LL') {
                        cell.fill = { type:'pattern', pattern:'solid', fgColor:{ argb:'FFE0F2FE' } }; // celeste lluvia
                        cell.font = { bold: true, color: { argb:'FF0369A1' } };
                    }
                }
            });
        });

        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', `attachment; filename=ASISTENCIA_FHOL.xlsx`);
        await workbook.xlsx.write(res);
        res.end();

    } catch (e) { 
        console.error(e);
        res.status(500).send("Error: " + e.message); 
    }
});

// Middleware solo admin
const soloAdmin = (req, res, next) => {
    if (req.session.user && req.session.user.rol === 'admin') return next();
    res.status(403).json({ success: false, message: "Solo el administrador puede gestionar usuarios" });
};

// 1. Crear o actualizar usuario (solo admin)
app.post('/usuarios/guardar', proteger, soloAdmin, async (req, res) => {
    try {
        const { username, password, rol, modulos } = req.body;
        const [user, creado] = await Usuario.findOrCreate({
            where: { username },
            defaults: { password, rol: rol || 'usuario', modulos: modulos || 'PERSONAL,LOGISTICA' }
        });

        if (!creado) {
            if (password) user.password = password;
            if (rol)      user.rol      = rol;
            if (modulos !== undefined) user.modulos = modulos;
            await user.save();
        }
        res.json({ success: true, message: creado ? "Usuario creado" : "Usuario actualizado" });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// 2. Listar usuarios (solo admin)
app.get('/usuarios', proteger, soloAdmin, async (req, res) => {
    try {
        const users = await Usuario.findAll({ attributes: ['id', 'username', 'rol', 'modulos'] });
        res.json(users);
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

// 3. Eliminar usuario (solo admin)
app.post('/usuarios/eliminar', proteger, soloAdmin, async (req, res) => {
    try {
        const { username } = req.body;
        if (username === req.session.user.username) return res.status(400).json({ success: false, message: "No podés eliminarte a vos mismo" });
        await Usuario.destroy({ where: { username } });
        res.json({ success: true });
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
});

app.use('/logistica', proteger, require('./rutas_logistica'));

// INICIAR

const PORT = process.env.PORT || 3000;

async function iniciarServidor() {
    try {
        // Sincroniza la base de empleados
        await sequelize.sync({ alter: true });
        console.log("✅ Base de datos Empleados sincronizada");

        // AGREGÁ ESTA LÍNEA AQUÍ:
        await dbLogistica.sync({ alter: true });
        console.log("✅ Base de datos Logística sincronizada");

        app.listen(PORT, () => {
            console.log(`🚀 FHOL Online en puerto ${PORT}`);
        });
    } catch (err) {
        console.error("❌ Error al iniciar:", err);
    }
}

iniciarServidor();