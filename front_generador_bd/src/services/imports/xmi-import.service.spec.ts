import { XmiImportService } from './xmi-import.service';
import { EA_SAMPLE_XMI } from './ea-sample.fixture';

describe('XmiImportService', () => {
  let service: XmiImportService;

  // El servicio no inyecta nada, así que se instancia directo: TestBed obligaría
  // a configurar la detección de cambios zoneless sin aportar nada acá.
  beforeEach(() => {
    service = new XmiImportService();
  });

  /** Atajo: busca una clase por nombre y falla claro si no está. */
  const claseDe = (diagrama: { classes: any[] }, nombre: string) => {
    const cls = diagrama.classes.find(c => c.name === nombre);
    if (!cls) throw new Error(`No se importó la clase "${nombre}"`);
    return cls;
  };

  describe('sobre el diagrama "empresa" exportado de Enterprise Architect', () => {

    it('importa las nueve clases, incluida la de asociación', () => {
      const { diagram } = service.parse(EA_SAMPLE_XMI);

      expect(diagram.classes.map(c => c.name).sort()).toEqual([
        'Cliente', 'Email', 'Empleado', 'Item', 'Pago',
        'Persona', 'Producto', 'Telefono', 'Venta'
      ]);
    });

    it('no importa nada sin avisar', () => {
      const { warnings } = service.parse(EA_SAMPLE_XMI);
      expect(warnings).toEqual([]);
    });

    it('toma el tipo real de la extensión y no el degradado del modelo UML', () => {
      const { diagram } = service.parse(EA_SAMPLE_XMI);

      // EA escribe estos tres como `href=...#UnlimitedNatural` en la parte UML,
      // que no es un tipo de dato. El valor que eligió el usuario solo está en
      // el bloque de extensión: float, float y double.
      expect(claseDe(diagram, 'Pago').attributes).toEqual([
        { name: 'id', type: 'Int' },
        { name: 'monto', type: 'Float' }
      ]);
      expect(claseDe(diagram, 'Producto').attributes).toEqual([
        { name: 'id', type: 'Int' },
        { name: 'descripcion', type: 'String' },
        { name: 'precio', type: 'Float' }
      ]);
      expect(claseDe(diagram, 'Item').attributes).toEqual([
        { name: 'cantidad', type: 'Int' },
        { name: 'descuento', type: 'Double' }
      ]);
    });

    it('conserva el tipo Date', () => {
      const { diagram } = service.parse(EA_SAMPLE_XMI);
      const fecha = claseDe(diagram, 'Venta').attributes.find((a: any) => a.name === 'fecha');
      expect(fecha.type).toBe('Date');
    });

    it('orienta la herencia de la hija hacia el padre', () => {
      const { diagram } = service.parse(EA_SAMPLE_XMI);

      const persona = claseDe(diagram, 'Persona');
      const herencias = diagram.relationships.filter(r => r.type === 'generalization');

      expect(herencias.length).toBe(2);
      expect(herencias.every(h => h.targetId === persona.id))
        .withContext('Persona debe ser el padre de las dos').toBeTrue();
      expect(herencias.map(h => claseDe(diagram, 'Cliente').id === h.sourceId ||
                                claseDe(diagram, 'Empleado').id === h.sourceId))
        .toEqual([true, true]);
    });

    it('pone el rombo de la agregación y la composición en el origen', () => {
      const { diagram } = service.parse(EA_SAMPLE_XMI);

      // Nuestro lienzo dibuja el rombo en el extremo de origen, así que el
      // "todo" tiene que quedar como source: Persona tiene Emails, Venta tiene
      // Pagos.
      const agregacion = diagram.relationships.find(r => r.type === 'aggregation')!;
      expect(agregacion.sourceId).toBe(claseDe(diagram, 'Persona').id);
      expect(agregacion.targetId).toBe(claseDe(diagram, 'Email').id);

      const composicion = diagram.relationships.find(r => r.type === 'composition')!;
      expect(composicion.sourceId).toBe(claseDe(diagram, 'Venta').id);
      expect(composicion.targetId).toBe(claseDe(diagram, 'Pago').id);
    });

    it('distingue agregación de composición aunque EA use el mismo ea_type', () => {
      const { diagram } = service.parse(EA_SAMPLE_XMI);

      // Los dos conectores son `ea_type="Aggregation"`; lo que los separa es el
      // atributo `aggregation` (shared vs composite) del extremo.
      expect(diagram.relationships.filter(r => r.type === 'aggregation').length).toBe(1);
      expect(diagram.relationships.filter(r => r.type === 'composition').length).toBe(1);
    });

    it('lee las multiplicidades de cada lado', () => {
      const { diagram } = service.parse(EA_SAMPLE_XMI);

      const cliente = claseDe(diagram, 'Cliente');
      const clienteVenta = diagram.relationships.find(
        r => r.type === 'association' && r.sourceId === cliente.id
      )!;
      expect(clienteVenta.labels).toEqual(['1', '1..*']);

      const persona = claseDe(diagram, 'Persona');
      const personaTelefono = diagram.relationships.find(
        r => r.type === 'association' && r.sourceId === persona.id
      )!;
      // `0..*` se abrevia a `*`, que es como se tipea en el lienzo.
      expect(personaTelefono.labels).toEqual(['1', '*']);
    });

    it('engancha la clase de asociación al conector N:M', () => {
      const { diagram } = service.parse(EA_SAMPLE_XMI);

      const ancla = diagram.relationships.find(r => r.type === 'associationClass')!;
      expect(ancla.targetId).toBe(claseDe(diagram, 'Item').id);

      // El origen del ancla es un conector, no una clase.
      const conector = diagram.relationships.find(r => r.id === ancla.sourceId)!;
      expect(conector.type).toBe('association');
      expect(conector.sourceId).toBe(claseDe(diagram, 'Venta').id);
      expect(conector.targetId).toBe(claseDe(diagram, 'Producto').id);
      expect(conector.labels).toEqual(['1..*', '1..*']);
    });

    it('no toma los extremos de asociación como atributos de la clase', () => {
      const { diagram } = service.parse(EA_SAMPLE_XMI);

      // EA guarda los extremos navegables como `ownedAttribute` dentro de la
      // clase. Si se colaran, cada relación sería además una columna fantasma.
      expect(claseDe(diagram, 'Persona').attributes.map((a: any) => a.name))
        .toEqual(['id', 'dni', 'apellido', 'nombre']);
      expect(claseDe(diagram, 'Telefono').attributes.length).toBe(1);
    });

    it('conserva la disposición del diagrama de EA, separando las cajas', () => {
      const { diagram } = service.parse(EA_SAMPLE_XMI);

      // Las coordenadas se multiplican por un factor único para que las cajas
      // del lienzo, más grandes que las de EA, no se tapen entre sí. Lo que
      // tiene que sobrevivir es la disposición relativa, no el valor absoluto.
      const persona = claseDe(diagram, 'Persona');   // en EA: (245, 67)
      const telefono = claseDe(diagram, 'Telefono'); // en EA: arriba y a la derecha
      const venta = claseDe(diagram, 'Venta');       // en EA: abajo

      expect(telefono.position.x).toBeGreaterThan(persona.position.x);
      expect(telefono.position.y).toBeLessThan(persona.position.y);
      expect(venta.position.y).toBeGreaterThan(persona.position.y);

      // El factor es el mismo para todas: la proporción entre dos clases
      // cualesquiera no cambia respecto del original.
      const factor = persona.position.x / 245;
      expect(factor).toBeGreaterThanOrEqual(1);
      expect(Math.abs(venta.position.x / 249 - factor)).toBeLessThan(0.05);
    });

    it('no deja dos clases apiladas en el mismo lugar', () => {
      const { diagram } = service.parse(EA_SAMPLE_XMI);

      const vistas = new Set(diagram.classes.map(c => `${c.position.x},${c.position.y}`));
      expect(vistas.size).toBe(diagram.classes.length);
    });

    it('deja todas las relaciones apuntando a elementos que existen', () => {
      const { diagram } = service.parse(EA_SAMPLE_XMI);

      const classIds = new Set(diagram.classes.map(c => c.id));
      const relIds = new Set(diagram.relationships.map(r => r.id));

      for (const rel of diagram.relationships) {
        const origenValido = rel.type === 'associationClass'
          ? relIds.has(rel.sourceId)
          : classIds.has(rel.sourceId);
        expect(origenValido).withContext(`origen de ${rel.type}`).toBeTrue();
        expect(classIds.has(rel.targetId)).withContext(`destino de ${rel.type}`).toBeTrue();
      }
    });

    it('reasigna los ids para no chocar con lo que ya está en el lienzo', () => {
      const { diagram } = service.parse(EA_SAMPLE_XMI);

      expect(diagram.classes.some(c => c.id.startsWith('EAID_'))).toBeFalse();
      expect(new Set(diagram.classes.map(c => c.id)).size).toBe(diagram.classes.length);
    });
  });

  describe('ante archivos que no sirven', () => {

    it('rechaza un archivo que no es XMI con un mensaje entendible', () => {
      expect(() => service.parse('<html><body>hola</body></html>'))
        .toThrowError(/XMI 2\.1/);
    });

    it('rechaza XML mal formado', () => {
      expect(() => service.parse('<xmi:XMI><sin cerrar>'))
        .toThrowError(/no es XML válido/);
    });

    it('rechaza un XMI sin clases', () => {
      const vacio = `<?xml version="1.0"?>
        <xmi:XMI xmlns:xmi="http://schema.omg.org/spec/XMI/2.1" xmlns:uml="http://schema.omg.org/spec/UML/2.1">
          <uml:Model xmi:type="uml:Model" name="vacio">
            <packagedElement xmi:type="uml:Package" xmi:id="p1" name="Paquete vacío"/>
          </uml:Model>
        </xmi:XMI>`;
      expect(() => service.parse(vacio)).toThrowError(/ninguna clase/);
    });
  });
});
