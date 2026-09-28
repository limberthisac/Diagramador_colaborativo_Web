const wsPort = 8000;
const portJava = 7000;
export const environment = {
    production: true,
    wsPort,                // 👈 puerto configurable
    wsPath: '/ws/canvas/',        // 👈 path base
    
    // ENLACES LOCALES (Comentados)
    // endpoint_python: `http://127.0.0.1:${wsPort}/`,
    // WebSocket_python: `127.0.0.1:${wsPort}`,
    // endpoint_java: `http://127.0.0.1:${portJava}/`,

    // ENLACES DE PRODUCCIÓN (Railway)
    // endpoint_python: `https://diagramadorumlcolaborativo-production.up.railway.app/`,
    endpoint_python: `https://diagramadorcolaborativouml-production.up.railway.app/`,
    // WebSocket_python: `diagramadorumlcolaborativo-production.up.railway.app`,
    WebSocket_python: `diagramadorcolaborativouml-production.up.railway.app`,
    // endpoint_java: `https://extraordinary-alignment-production.up.railway.app/`
    endpoint_java: `https://generadorbackendspringboot-production.up.railway.app/`
};

