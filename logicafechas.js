function obtenerCorteQuincena(mes, anio) {
    // Primera quincena: siempre termina el 15
    // Segunda quincena: siempre termina el último día del mes
    const ultimoDia = new Date(anio, mes, 0).getDate();
    return new Date(anio, mes - 1, 15);
}

module.exports = { obtenerCorteQuincena };