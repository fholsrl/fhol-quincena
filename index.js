const express = require('express');
const session = require('express-session'); // <-- ESTA ES LA LÍNEA QUE FALTA
const { sequelize, Empleado, Hora, Usuario } = require('./database');
const { obtenerCorteQuincena } = require('./logicafechas');
const { Op } = require('sequelize');
const { addDays, startOfMonth, endOfMonth } = require('date-fns');
const ExcelJS = require('exceljs');

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

// 2. DEFINIR LA FUNCIÓN PROTEGER (Importante que esté ACÁ)
const proteger = (req, res, next) => {
    if (req.session.user) return next();
    res.status(401).send("No autorizado");
};

// 3. DEFINIR LA FUNCIÓN login
app.post('/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        // Buscamos en la tabla de Supabase que acabas de actualizar
        const user = await Usuario.findOne({ where: { username, password } });

        if (user) {
            req.session.user = { id: user.id, username: user.username };
            res.json({ success: true });
        } else {
            res.status(401).json({ success: false, message: "Usuario o clave incorrectos" });
        }
    } catch (e) {
        res.status(500).json({ success: false, message: e.message });
    }
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

app.post('/cargar-horas', proteger, async (req, res) => {
    try {
        const { empleadoId, fecha, cantidadHoras } = req.body;
        
        // Salvavidas: si por algún motivo no hay sesión, ponemos "admin"
        const usuarioActual = (req.session.user && req.session.user.username) ? req.session.user.username : 'admin';

        const [registro, creado] = await Hora.findOrCreate({
            where: { EmpleadoId: empleadoId, fecha: fecha },
            defaults: { 
                cantidadHoras: parseFloat(cantidadHoras),
                cargadoPor: usuarioActual 
            }
        });

        if (!creado) {
            registro.cantidadHoras = parseFloat(cantidadHoras);
            registro.cargadoPor = usuarioActual;
            await registro.save();
        }
        res.json(registro);
    } catch (e) { 
        console.error("Error al cargar horas:", e); // Esto te dirá el error real en la terminal
        res.status(500).send(e.message); 
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
        res.json(registro || { cantidadHoras: 0 }); // Si no hay nada, devuelve 0
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
                const hs = registro ? parseFloat(registro.cantidadHoras) : 0;
                rowData[dia.fechaStr] = hs > 0 ? hs : '-';
                sumaHoras += hs;
            });
            rowData['total'] = sumaHoras;
            
            const row = worksheet.addRow(rowData);
            row.eachCell((cell, colNumber) => {
                cell.border = { top: {style:'thin'}, left: {style:'thin'}, bottom: {style:'thin'}, right: {style:'thin'} };
                cell.alignment = { horizontal: 'center' };
                // Colorear el fondo de las celdas de finde en el cuerpo
                if (colNumber > 2 && colNumber < colsConfig.length) {
                    if (diasRango[colNumber - 3].esEspecial) {
                        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFEE2E2' } };
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

// 1. Crear o actualizar usuario
app.post('/usuarios/guardar', proteger, async (req, res) => {
    try {
        const { username, password } = req.body;
        // findOrCreate busca si existe, si no lo crea.
        const [user, creado] = await Usuario.findOrCreate({
            where: { username },
            defaults: { password }
        });

        if (!creado) {
            // Si ya existía, actualizamos la contraseña
            user.password = password;
            await user.save();
        }
        res.json({ success: true, message: creado ? "Usuario creado" : "Contraseña actualizada" });
    } catch (e) { 
        res.status(500).json({ success: false, message: e.message }); 
    }
});

// 2. Listar usuarios (solo nombres, sin contraseñas)
app.get('/usuarios', proteger, async (req, res) => {
    try {
        const users = await Usuario.findAll({ attributes: ['username'] });
        res.json(users);
    } catch (e) { 
        res.status(500).json({ success: false, message: e.message }); 
    }
});

// INICIAR
const PORT = process.env.PORT || 3000;

sequelize.sync({ alter: true }).then(() => {
    app.listen(PORT, () => {
        console.log(`🚀 FHOL Online en puerto ${PORT}`);
    });
}).catch(err => {
    console.error("Error al sincronizar con Supabase:", err);
});