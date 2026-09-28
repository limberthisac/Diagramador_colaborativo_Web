import { XmiImportService } from './xmi-import.service';
import { XmiExportService } from '../exports/xmi-export.service';
import { SqlExportService } from '../exports/sql-export.service';
import { EA_SAMPLE_XMI } from './ea-sample.fixture';
import { UmlExportDTO } from '../exports/diagram-export.service';

/**
 * Ida y vuelta entre el importador y el exportador.
 *
 * Importar el archivo de Enterprise Architect, volver a exportarlo y leerlo otra
 * vez tiene que devolver el mismo modelo. Si alguno de los dos sentidos pierde
 * información, se rompe acá.
 *
 * De paso queda cubierto el segundo camino del importador: nuestro exportador no
 * escribe el bloque `<connectors>` propio de EA, así que la reimportación se
 * resuelve leyendo el modelo UML, que es la otra mitad del código.
 */
describe('Importar y exportar', () => {
  let importador: XmiImportService;
  let exportador: XmiExportService;

  /** El XMI que el exportador habría descargado. */
  let xmlExportado: string;

  beforeEach(() => {
    importador = new XmiImportService();
    exportador = new XmiExportService();

    // `downloadFile` dispara una descarga real del navegador; se intercepta para
    // quedarse con el contenido en vez de bajarlo.
    xmlExportado = '';
    spyOn<any>(exportador, 'downloadFile').and.callFake((contenido: string) => {
      xmlExportado = contenido;
    });
  });

  /** Importa el archivo de EA, lo exporta y lo vuelve a importar. */
  const idaYVuelta = (): { original: UmlExportDTO; final: UmlExportDTO } => {
    const original = importador.parse(EA_SAMPLE_XMI).diagram;
    exportador.exportToXmi(original);
    const final = importador.parse(xmlExportado).diagram;
    return { original, final };
  };

  /** Describe las relaciones por nombre de clase, porque los ids se reasignan en
   *  cada importación y no se pueden comparar entre un modelo y otro. */
  const describirRelaciones = (dto: UmlExportDTO) => {
    const nombre = (id: string) => dto.classes.find(c => c.id === id)?.name ?? '?';
    return dto.relationships
      .filter(r => r.type !== 'associationClass')
      .map(r => `${r.type}: ${nombre(r.sourceId)} -> ${nombre(r.targetId)} [${(r.labels ?? []).join(',')}]`)
      .sort();
  };

  it('el exportador produce un XMI que el importador entiende', () => {
    const { final } = idaYVuelta();
    expect(final.classes.length).toBeGreaterThan(0);
  });

  it('la reimportación pasa por el camino del modelo UML, no por el de EA', () => {
    idaYVuelta();

    // Esto es lo que hace valiosa a toda esta batería: el archivo de EA se lee
    // por el bloque `<connectors>`, pero nuestro exportador no lo escribe, así
    // que la segunda lectura se resuelve con `readFromModel`. Si algún día el
    // exportador empezara a emitir conectores, estas pruebas dejarían de cubrir
    // esa mitad del código sin que nadie se entere.
    expect(xmlExportado).withContext('el exportador no debería emitir <connectors>')
      .not.toContain('<connector ');
    expect(EA_SAMPLE_XMI).withContext('el archivo de EA sí los trae')
      .toContain('<connector ');
  });

  it('conserva todas las clases con sus atributos y tipos', () => {
    const { original, final } = idaYVuelta();

    const resumir = (dto: UmlExportDTO) =>
      dto.classes
        .map(c => `${c.name}(${c.attributes.map(a => `${a.name}:${a.type}`).join(',')})`)
        .sort();

    expect(resumir(final)).toEqual(resumir(original));
  });

  it('conserva las relaciones, su tipo y su orientación', () => {
    const { original, final } = idaYVuelta();
    expect(describirRelaciones(final)).toEqual(describirRelaciones(original));
  });

  it('no invierte el rombo de la composición ni el de la agregación', () => {
    const { final } = idaYVuelta();
    const nombre = (id: string) => final.classes.find(c => c.id === id)?.name;

    const composicion = final.relationships.find(r => r.type === 'composition')!;
    expect(nombre(composicion.sourceId)).toBe('Venta');
    expect(nombre(composicion.targetId)).toBe('Pago');

    const agregacion = final.relationships.find(r => r.type === 'aggregation')!;
    expect(nombre(agregacion.sourceId)).toBe('Persona');
    expect(nombre(agregacion.targetId)).toBe('Email');
  });

  it('conserva la clase de asociación colgando de su conector', () => {
    const { final } = idaYVuelta();

    const item = final.classes.find(c => c.name === 'Item')!;
    expect(item).withContext('Item tiene que seguir siendo una clase').toBeDefined();
    expect(item.attributes.map(a => a.name)).toEqual(['cantidad', 'descuento']);

    const ancla = final.relationships.find(r => r.type === 'associationClass')!;
    expect(ancla.targetId).toBe(item.id);

    const conector = final.relationships.find(r => r.id === ancla.sourceId)!;
    const nombre = (id: string) => final.classes.find(c => c.id === id)?.name;
    expect(nombre(conector.sourceId)).toBe('Venta');
    expect(nombre(conector.targetId)).toBe('Producto');
  });

  it('conserva la herencia apuntando de la hija al padre, y sin multiplicidades', () => {
    const { final } = idaYVuelta();

    const persona = final.classes.find(c => c.name === 'Persona')!;
    const herencias = final.relationships.filter(r => r.type === 'generalization');

    expect(herencias.length).toBe(2);
    expect(herencias.every(h => h.targetId === persona.id)).toBeTrue();
    expect(herencias.every(h => !h.labels || h.labels.length === 0))
      .withContext('una herencia no lleva cardinalidades').toBeTrue();
  });

  it('conserva la disposición relativa de las clases', () => {
    const { original, final } = idaYVuelta();

    // Las coordenadas absolutas no se comparan: el importador separa las cajas
    // multiplicándolas por un factor, y en esta prueba eso ocurre dos veces
    // porque el modelo nunca pasa por el lienzo, que es quien normaliza los
    // tamaños. Lo que sí tiene que sobrevivir es el orden relativo.
    const posicion = (dto: UmlExportDTO, nombre: string) =>
      dto.classes.find(c => c.name === nombre)!.position;

    for (const [a, b] of [['Persona', 'Venta'], ['Telefono', 'Email'], ['Pago', 'Producto']]) {
      const antesX = posicion(original, a).x - posicion(original, b).x;
      const despuesX = posicion(final, a).x - posicion(final, b).x;
      expect(Math.sign(antesX)).withContext(`${a} vs ${b} en horizontal`).toBe(Math.sign(despuesX));

      const antesY = posicion(original, a).y - posicion(original, b).y;
      const despuesY = posicion(final, a).y - posicion(final, b).y;
      expect(Math.sign(antesY)).withContext(`${a} vs ${b} en vertical`).toBe(Math.sign(despuesY));
    }
  });
});

/**
 * El SQL es la salida que más se usa, así que conviene comprobar que un diagrama
 * importado de EA produce un esquema coherente.
 */
describe('SQL generado a partir de un diagrama importado', () => {
  let esquema: string;

  beforeAll(() => {
    const diagrama = new XmiImportService().parse(EA_SAMPLE_XMI).diagram;
    esquema = new SqlExportService().exportToSql(diagrama);
  });

  /** El bloque `CREATE TABLE` de una tabla, para poder inspeccionarlo aparte. */
  const tabla = (nombre: string) =>
    esquema.split('CREATE TABLE ').find(b => b.startsWith(`${nombre} (`));

  it('crea una tabla por cada clase suelta', () => {
    for (const nombre of ['Persona', 'Cliente', 'Empleado', 'Venta', 'Producto', 'Pago', 'Telefono', 'Email']) {
      expect(tabla(nombre)).withContext(`falta la tabla ${nombre}`).toBeDefined();
    }
  });

  it('emite la clase de asociación como tabla de unión, con sus dos foráneas', () => {
    const item = tabla('Item');
    expect(item).withContext('Item tiene que existir como tabla').toBeDefined();
    expect(item!).toContain('venta_id');
    expect(item!).toContain('producto_id');
  });

  it('le da clave primaria compuesta a la tabla de unión', () => {
    expect(tabla('Item')!).toContain('PRIMARY KEY (venta_id, producto_id)');
  });

  it('conserva los atributos propios de la clase de asociación', () => {
    const item = tabla('Item')!;
    expect(item).toContain('cantidad');
    expect(item).toContain('descuento');
  });

  it('ata cada clase hija a la tabla del padre', () => {
    expect(esquema).toContain('ALTER TABLE Cliente');
    expect(esquema).toContain('ALTER TABLE Empleado');
    expect(esquema).toContain('REFERENCES Persona(id)');
  });

  it('usa un tipo numérico para los importes', () => {
    // `monto` y `precio` son float en EA. Si el importador los hubiera degradado
    // a un tipo desconocido, acá aparecerían como VARCHAR.
    expect(esquema).toMatch(/monto\s+FLOAT/);
    expect(esquema).toMatch(/precio\s+FLOAT/);
  });

  it('no deja ninguna columna sin tipo', () => {
    const sinTipo = esquema.match(/^\s{2}\w+\s*,$/gm) ?? [];
    expect(sinTipo).toEqual([]);
  });
});
