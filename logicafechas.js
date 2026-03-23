const { addDays, isFriday } = require('date-fns');

function obtenerCorteQuincena(mes, anio) {
    // Mes en JS va de 0 a 11, por eso restamos 1
    let fecha15 = new Date(anio, mes - 1, 15);
    let viernesCercano = null;

    for (let i = 0; i <= 4; i++) {
        let adelante = addDays(fecha15, i);
        let atras = addDays(fecha15, -i);
        if (isFriday(adelante)) { viernesCercano = adelante; break; }
        if (isFriday(atras)) { viernesCercano = atras; break; }
    }
    return viernesCercano || fecha15;
}

module.exports = { obtenerCorteQuincena };