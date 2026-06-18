// ══════════════════════════════════════════════════════════════════════════════
// INTEGRACIÓN DEL MÓDULO HERRERÍA — agregar a index.js
// ══════════════════════════════════════════════════════════════════════════════

// 1. Agregar el require junto a los demás (al inicio de index.js):
const rutasHerreria = require('./rutas_herreria');

// 2. Agregar la ruta junto a las demás (después de las rutas de logística):
app.use('/herreria', rutasHerreria);


// ══════════════════════════════════════════════════════════════════════════════
// CAMBIOS EN login.html
// ══════════════════════════════════════════════════════════════════════════════
// En la función mostrarModulos(), agregar el bloque de HERRERÍA:

/*
if (modulos.includes('HERRERIA')) {
    contenedor.innerHTML += `<button class="btn-modulo btn-herreria" onclick="ir('/herreria.html')">🔩 HERRERÍA</button>`;
}
*/

// Y agregar este estilo al <style> de login.html:
/*
.btn-herreria { background: #7c3aed; color: white; }
*/


// ══════════════════════════════════════════════════════════════════════════════
// AGREGAR MÓDULO HERRERÍA A UN USUARIO (ejecutar una sola vez en el servidor)
// ══════════════════════════════════════════════════════════════════════════════
/*
const { Usuario } = require('./database');
await Usuario.update(
    { modulos: 'PERSONAL,LOGISTICA,HERRERIA' },
    { where: { rol: 'admin' } }
);
*/


// ══════════════════════════════════════════════════════════════════════════════
// ESTRUCTURA DE ARCHIVOS A AGREGAR
// ══════════════════════════════════════════════════════════════════════════════
/*
fhol/
├── index.js                ← agregar require y app.use arriba
├── database_herreria.js    ← NUEVO — modelos de DB
├── rutas_herreria.js       ← NUEVO — backend completo
└── public/
    └── herreria.html       ← NUEVO — frontend completo
*/
