import { Injectable } from '@angular/core';
import { v4 as uuid } from 'uuid';
import { UmlClassDTO, UmlExportDTO, UmlRelationshipDTO } from '../exports/diagram-export.service';

/**
 * Lo que se obtuvo de un archivo XMI, junto con todo lo que no se pudo
 * representar. Un importador que descarta cosas en silencio es peor que uno que
 * falla: el usuario se entera del hueco recién cuando genera la base de datos.
 */
export interface XmiImportResult {
  diagram: UmlExportDTO;
  warnings: string[];
}

/** Geometría de una caja tal como la guarda Enterprise Architect. */
interface Geometry {
  position: { x: number; y: number };
  size: { width: number; height: number };
}

/**
 * Lee un XMI 2.1 (el formato que exporta Enterprise Architect) y lo convierte al
 * JSON que consume `DiagramService.loadFromJson`.
 *
 * Hay dos caminos para sacar las relaciones, y el orden importa:
 *
 * 1. **El bloque `<connectors>` de la extensión de EA**, si está. Da el origen,
 *    el destino, las multiplicidades y el tipo ya resueltos en un solo lugar.
 * 2. **El modelo UML** (`packagedElement`), si no hay extensión. Es el caso de
 *    un XMI genérico y el del propio exportador de este diagramador.
 *
 * Se prefiere el primero porque el modelo UML que escribe EA es ambiguo: los
 * extremos de una asociación no vienen en un orden fijo (en un mismo archivo una
 * asociación escribe primero el destino y otra primero el origen) y el atributo
 * `aggregation` del metamodelo aparece en `none` aunque el conector sea una
 * composición.
 *
 * Casi todo se busca por `localName` y no por nombre calificado: el prefijo de
 * los espacios de nombres (`xmi:`, `uml:`) y hasta la URI cambian entre archivos.
 */
@Injectable({ providedIn: 'root' })
export class XmiImportService {

  private readonly DEFAULT_SIZE = { width: 180, height: 110 };

  /**
   * Lee un archivo elegido por el usuario respetando la codificación que el
   * propio XML declara.
   *
   * No es un detalle menor: Enterprise Architect declara `windows-1252`, no
   * UTF-8. Si se leyera como UTF-8, una clase llamada `Categoría` o un atributo
   * `descripción` llegarían con el nombre roto, y eso termina en el nombre de
   * una tabla de la base de datos.
   */
  async readFile(file: File): Promise<string> {
    const buffer = await file.arrayBuffer();

    // La declaración está en los primeros bytes y es ASCII, así que se puede
    // leer sin saber todavía la codificación real.
    const head = new TextDecoder('ascii').decode(buffer.slice(0, 200));
    const declared = /encoding\s*=\s*["']([^"']+)["']/i.exec(head)?.[1];

    try {
      return new TextDecoder(declared || 'utf-8').decode(buffer);
    } catch {
      // Una codificación que el navegador no conozca no debería impedir la
      // importación: el contenido ASCII se lee igual.
      return new TextDecoder('utf-8').decode(buffer);
    }
  }

  parse(xmlText: string): XmiImportResult {
    const warnings: string[] = [];

    const doc = new DOMParser().parseFromString(xmlText, 'application/xml');
    const failure = doc.querySelector('parsererror');
    if (failure) {
      throw new Error(`El archivo no es XML válido: ${failure.textContent?.trim() ?? 'error desconocido'}`);
    }

    const packaged = this.deep(doc, 'packagedElement');
    if (packaged.length === 0) {
      throw new Error(
        'No se encontró ningún <packagedElement>. ¿Seguro que el archivo es un XMI 2.1? ' +
        'Enterprise Architect también exporta XMI 1.1, que tiene otra estructura.'
      );
    }

    // Índice de todas las Property del documento. Hace falta porque los extremos
    // de una asociación no siempre son hijos de la asociación: cuando el extremo
    // es navegable, EA lo escribe como `ownedAttribute` de la clase y la
    // asociación solo lo referencia por id desde `memberEnd`.
    const propertyById = new Map<string, Element>();
    for (const prop of this.deep(doc, 'ownedAttribute').concat(this.deep(doc, 'ownedEnd'))) {
      const id = this.xmiAttr(prop, 'id');
      if (id) propertyById.set(id, prop);
    }

    // Índice de nombres por id, para resolver los tipos de atributo. EA declara
    // los primitivos como elementos propios (`EAJava_int` → `name="int"`), así
    // que esto alcanza para traducirlos.
    const nameById = new Map<string, string>();
    for (const el of Array.from(doc.getElementsByTagName('*'))) {
      const id = this.xmiAttr(el, 'id');
      const name = this.plainAttr(el, 'name');
      if (id && name) nameById.set(id, name);
    }

    // EA degrada los tipos en la parte UML: un `float` termina escrito como
    // `href=...#UnlimitedNatural`, que en UML no es un tipo de dato sino el de
    // los límites de multiplicidad. El tipo que el usuario eligió de verdad solo
    // sobrevive en el bloque de extensión, así que ese manda.
    const eaTypeByAttrId = new Map<string, string>();
    for (const attrEl of this.deep(doc, 'attribute')) {
      const ref = this.xmiAttr(attrEl, 'idref');
      const props = this.kids(attrEl, 'properties')[0];
      const declared = props && this.plainAttr(props, 'type');
      if (ref && declared) eaTypeByAttrId.set(ref, declared);
    }

    const geometryBySubject = this.readGeometry(doc);

    const classEls = packaged.filter(el => this.typeOf(el) === 'Class');
    const assocClassEls = packaged.filter(el => this.typeOf(el) === 'AssociationClass');
    const assocEls = packaged.filter(el => this.typeOf(el) === 'Association');
    const depEls = packaged.filter(el => this.typeOf(el) === 'Dependency');

    // Los ids del archivo se reemplazan por ids propios. EA usa ids como
    // `EAID_0A1B...` que podrían chocar con los del lienzo al importar sobre un
    // diagrama existente.
    const idMap = new Map<string, string>();
    const mapId = (original: string | null): string => {
      if (!original) return uuid();
      let mapped = idMap.get(original);
      if (!mapped) {
        mapped = uuid();
        idMap.set(original, mapped);
      }
      return mapped;
    };

    const classes: UmlClassDTO[] = [];

    let unplaced = 0;
    const placeOf = (originalId: string | null, name: string): Geometry => {
      const found = originalId ? geometryBySubject.get(originalId) : undefined;
      if (found) return found;
      warnings.push(`La clase "${name}" no traía posición en el diagrama; se ubicó automáticamente.`);
      return {
        position: { x: 80 + (unplaced % 4) * 240, y: 80 + Math.floor(unplaced++ / 4) * 200 },
        size: { ...this.DEFAULT_SIZE }
      };
    };

    const addClass = (el: Element, id: string) => {
      const originalId = this.xmiAttr(el, 'id');
      const name = this.plainAttr(el, 'name') || 'SinNombre';
      const place = placeOf(originalId, name);
      classes.push({
        id,
        name,
        attributes: this.readAttributes(el, nameById, eaTypeByAttrId, warnings),
        methods: this.readOperations(el, nameById),
        position: place.position,
        size: place.size
      });
    };

    // ====== CLASES ======
    for (const el of classEls) {
      addClass(el, mapId(this.xmiAttr(el, 'id')));
    }

    // ====== CLASES DE ASOCIACIÓN ======
    // En UML 2 una clase de asociación es UN solo elemento que es clase y
    // asociación a la vez. Nuestro modelo la guarda como tres piezas: el
    // conector N:M, la clase con los atributos, y una relación `associationClass`
    // que une la una con el otro. Acá se crea la clase; el conector y el ancla
    // los arma después el camino que corresponda.
    const assocClassIdByOriginal = new Map<string, string>();
    for (const el of assocClassEls) {
      const originalId = this.xmiAttr(el, 'id');
      // La clase necesita un id propio porque el del archivo puede quedar
      // tomado por el conector.
      const classId = uuid();
      if (originalId) assocClassIdByOriginal.set(originalId, classId);
      addClass(el, classId);
    }

    // ====== RELACIONES ======
    const connectors = this.deep(doc, 'connector');
    const relationships = connectors.length > 0
      ? this.readFromConnectors(connectors, mapId, assocClassIdByOriginal, warnings)
      : this.readFromModel(
          { classEls, assocClassEls, assocEls, depEls },
          propertyById, mapId, assocClassIdByOriginal, warnings
        );

    // Una relación que apunte a una clase que no se importó rompe el lienzo al
    // resolver la vista, así que se descarta acá y se avisa.
    const knownClassIds = new Set(classes.map(c => c.id));
    const knownRelIds = new Set(relationships.map(r => r.id));
    const resolved = relationships.filter(rel => {
      const sourceOk = rel.type === 'associationClass'
        ? knownRelIds.has(rel.sourceId)
        : knownClassIds.has(rel.sourceId);
      const targetOk = knownClassIds.has(rel.targetId);
      if (!sourceOk || !targetOk) {
        warnings.push(`Se omitió una relación de tipo "${rel.type}" porque apunta a un elemento que no está en el archivo.`);
        return false;
      }
      return true;
    });

    if (classes.length === 0) {
      throw new Error('El archivo no contiene ninguna clase.');
    }

    this.spreadPositions(classes);

    return { diagram: { classes, relationships: resolved }, warnings };
  }

  /**
   * Separa las cajas para que no se pisen al caer en el lienzo.
   *
   * Las posiciones que trae EA son fieles a lo que dibujó el usuario, pero sus
   * cajas son bastante más chicas que las nuestras: EA las dibuja compactas,
   * mientras que el lienzo arranca en 180 de ancho y además reserva un
   * compartimento para los métodos. Con cajas del doble de tamaño sobre las
   * mismas coordenadas, las clases se superponen.
   *
   * Se multiplica por un único factor para las dos direcciones: usar uno por eje
   * deformaría la disposición, y lo que se quiere conservar es justamente la
   * forma del diagrama original.
   *
   * Es una aproximación, no una solución exacta: el alto real de una caja
   * depende de cuántos atributos tenga y eso lo resuelve el lienzo recién al
   * dibujarla. Puede quedar alguna separación de más, que es preferible a que se
   * tapen entre sí.
   */
  private spreadPositions(classes: UmlClassDTO[]): void {
    const anchos = classes.map(c => c.size.width).filter(w => w > 0);
    if (anchos.length === 0) return;

    const anchoPromedio = anchos.reduce((a, w) => a + w, 0) / anchos.length;
    // El tope evita que un archivo con cajas diminutas mande las clases a
    // coordenadas absurdas, fuera de la vista.
    const factor = Math.min(3, Math.max(1, this.DEFAULT_SIZE.width / anchoPromedio));
    if (factor === 1) return;

    for (const cls of classes) {
      cls.position = {
        x: Math.round(cls.position.x * factor),
        y: Math.round(cls.position.y * factor)
      };
    }
  }

  // ========= Camino 1: el bloque <connectors> de Enterprise Architect =========

  /**
   * Cada `<connector>` trae el origen, el destino, la multiplicidad de cada lado
   * y el tipo de relación, todo explícito. Es la fuente más confiable de un
   * archivo de EA.
   */
  private readFromConnectors(
    connectors: Element[],
    mapId: (id: string | null) => string,
    assocClassIdByOriginal: Map<string, string>,
    warnings: string[]
  ): UmlRelationshipDTO[] {
    const relationships: UmlRelationshipDTO[] = [];

    for (const connector of connectors) {
      const sourceEl = this.kids(connector, 'source')[0];
      const targetEl = this.kids(connector, 'target')[0];
      if (!sourceEl || !targetEl) continue;

      const sourceRef = this.xmiAttr(sourceEl, 'idref');
      const targetRef = this.xmiAttr(targetEl, 'idref');
      if (!sourceRef || !targetRef) continue;

      const props = this.kids(connector, 'properties')[0];
      const eaType = (props && this.plainAttr(props, 'ea_type')) || 'Association';

      const sourceInfo = this.kids(sourceEl, 'type')[0];
      const targetInfo = this.kids(targetEl, 'type')[0];
      const sourceAgg = (sourceInfo && this.plainAttr(sourceInfo, 'aggregation')) || 'none';
      const targetAgg = (targetInfo && this.plainAttr(targetInfo, 'aggregation')) || 'none';

      const connectorId = mapId(this.xmiAttr(connector, 'idref'));

      // La herencia no lleva multiplicidades. En EA el origen es la clase hija y
      // el destino la padre, igual que en nuestro modelo.
      //
      // `labels: []` no es redundante: el constructor de relaciones del lienzo
      // le cuelga `0..1` y `1..*` por defecto a todo conector, y una herencia
      // con multiplicidades no existe. Dejarlo sin la propiedad haría que el
      // diagrama importado no se pareciera al de Enterprise Architect.
      if (eaType === 'Generalization') {
        relationships.push({
          id: connectorId,
          type: 'generalization',
          sourceId: mapId(sourceRef),
          targetId: mapId(targetRef),
          labels: []
        });
        continue;
      }

      if (eaType === 'Dependency' || eaType === 'Usage') {
        relationships.push({
          id: connectorId,
          type: 'dependency',
          sourceId: mapId(sourceRef),
          targetId: mapId(targetRef),
          labels: []
        });
        continue;
      }

      if (eaType !== 'Association' && eaType !== 'Aggregation') {
        warnings.push(
          `El conector de tipo "${eaType}" no tiene equivalente en el diagramador; ` +
          `se importó como una asociación simple.`
        );
      }

      // El rombo de una agregación o composición se dibuja en el extremo del
      // todo, y nuestro lienzo lo dibuja siempre en el origen. En el bloque de
      // conectores, `aggregation` describe el rol de ese mismo extremo, así que
      // el lado marcado es el que tiene que quedar como origen.
      let type = 'association';
      let sourceId = sourceRef;
      let targetId = targetRef;
      let sourceMult = this.multiplicityOf(sourceInfo);
      let targetMult = this.multiplicityOf(targetInfo);

      const markedIsSource = sourceAgg !== 'none';
      const markedIsTarget = targetAgg !== 'none';

      if (markedIsSource || markedIsTarget) {
        const aggregation = markedIsSource ? sourceAgg : targetAgg;
        type = aggregation === 'composite' ? 'composition' : 'aggregation';

        if (markedIsTarget) {
          // El todo está del lado del destino: se invierte para que quede como
          // origen, junto con su multiplicidad.
          [sourceId, targetId] = [targetId, sourceId];
          [sourceMult, targetMult] = [targetMult, sourceMult];
        }
      }

      relationships.push({
        id: connectorId,
        type,
        sourceId: mapId(sourceId),
        targetId: mapId(targetId),
        labels: [sourceMult, targetMult]
      });

      // EA enlaza el conector con su clase de asociación desde acá.
      const extended = this.kids(connector, 'extendedProperties')[0];
      const assocClassRef = extended && this.plainAttr(extended, 'associationclass');
      if (assocClassRef) {
        const classId = assocClassIdByOriginal.get(assocClassRef);
        if (classId) {
          relationships.push({
            id: uuid(),
            type: 'associationClass',
            sourceId: connectorId,
            targetId: classId
          });
        } else {
          warnings.push('Un conector declara una clase de asociación que no está en el archivo; quedó como asociación simple.');
        }
      }
    }

    return relationships;
  }

  /** Multiplicidad ya resuelta como cadena por EA: `1`, `0..*`, `1..*`. */
  private multiplicityOf(typeEl: Element | undefined): string {
    if (!typeEl) return '';
    const raw = this.plainAttr(typeEl, 'multiplicity');
    if (!raw) return '';
    return this.normalizeMultiplicity(raw);
  }

  // ========= Camino 2: el modelo UML =========

  /**
   * Relaciones sacadas del modelo UML, para los archivos que no traen la
   * extensión de EA: un XMI genérico, o el que exporta este mismo diagramador.
   */
  private readFromModel(
    els: { classEls: Element[]; assocClassEls: Element[]; assocEls: Element[]; depEls: Element[] },
    propertyById: Map<string, Element>,
    mapId: (id: string | null) => string,
    assocClassIdByOriginal: Map<string, string>,
    warnings: string[]
  ): UmlRelationshipDTO[] {
    const relationships: UmlRelationshipDTO[] = [];

    // La generalización vive dentro de la clase hija, no como elemento suelto.
    // `general` apunta al padre, que es el `targetId` de nuestro modelo.
    for (const el of els.classEls.concat(els.assocClassEls)) {
      const childId = this.xmiAttr(el, 'id');
      for (const gen of this.kids(el, 'generalization')) {
        const parent = this.plainAttr(gen, 'general') ?? this.refOfChild(gen, 'general');
        if (!parent) {
          warnings.push(`Una herencia de "${this.plainAttr(el, 'name')}" no indicaba clase padre; se omitió.`);
          continue;
        }
        relationships.push({
          id: mapId(this.xmiAttr(gen, 'id')),
          type: 'generalization',
          sourceId: mapId(childId),
          targetId: mapId(parent),
          // Ver la nota del mismo caso en `readFromConnectors`: sin esto el
          // lienzo le pone multiplicidades por defecto a la herencia.
          labels: []
        });
      }
    }

    for (const el of els.assocEls) {
      const rel = this.readAssociation(el, propertyById, mapId);
      if (rel) relationships.push(rel);
    }

    for (const el of els.assocClassEls) {
      const originalId = this.xmiAttr(el, 'id');
      const rel = this.readAssociation(el, propertyById, mapId);
      if (!rel) {
        warnings.push(`La clase de asociación "${this.plainAttr(el, 'name')}" no tenía dos extremos resolubles; se omitió el conector.`);
        continue;
      }
      relationships.push(rel);

      const classId = originalId ? assocClassIdByOriginal.get(originalId) : undefined;
      if (classId) {
        relationships.push({
          id: uuid(),
          type: 'associationClass',
          sourceId: rel.id,
          targetId: classId
        });
      }
    }

    for (const el of els.depEls) {
      const client = this.plainAttr(el, 'client') ?? this.refOfChild(el, 'client');
      const supplier = this.plainAttr(el, 'supplier') ?? this.refOfChild(el, 'supplier');
      if (!client || !supplier) {
        warnings.push('Una dependencia no indicaba origen y destino; se omitió.');
        continue;
      }
      relationships.push({
        id: mapId(this.xmiAttr(el, 'id')),
        type: 'dependency',
        sourceId: mapId(client),
        targetId: mapId(supplier),
        labels: []
      });
    }

    return relationships;
  }

  /**
   * Extremos de una asociación del modelo UML → relación de nuestro modelo.
   *
   * Devuelve `null` si no se pudieron resolver los dos extremos, que es lo que
   * pasa cuando la asociación referencia clases fuera del paquete exportado.
   */
  private readAssociation(
    el: Element,
    propertyById: Map<string, Element>,
    mapId: (id: string | null) => string
  ): UmlRelationshipDTO | null {
    let ends = this.kids(el, 'ownedEnd');

    if (ends.length < 2) {
      // Extremos navegables: viven en las clases y la asociación los referencia.
      const referenced = this.kids(el, 'memberEnd')
        .map(m => this.xmiAttr(m, 'idref') ?? this.plainAttr(m, 'idref'))
        .map(id => (id ? propertyById.get(id) : undefined))
        .filter((p): p is Element => !!p);
      if (referenced.length >= 2) ends = referenced;
    }

    if (ends.length < 2) return null;

    // El orden de los extremos no es fiable, pero EA nombra sus ids con los
    // prefijos `EAID_src`/`EAID_dst`. Cuando están, mandan ellos.
    const byName = (needle: string) =>
      ends.find(end => (this.xmiAttr(end, 'id') ?? '').toLowerCase().includes(needle));
    const namedSource = byName('_src');
    const namedTarget = byName('_dst');

    let [first, second] = ends;
    if (namedSource && namedTarget && namedSource !== namedTarget) {
      first = namedSource;
      second = namedTarget;
    }

    // El rombo se dibuja en el extremo del todo, pero el atributo `aggregation`
    // del metamodelo va en el extremo opuesto, el de la parte. Nuestro lienzo
    // dibuja el rombo en el origen, así que el extremo marcado es el destino.
    // Es la convención que usa `XmiExportService`, y deshacerla acá es lo que
    // hace que el ida y vuelta cierre.
    const aggregationOf = (end: Element) => this.plainAttr(end, 'aggregation') || 'none';
    const marked = ends.find(end => aggregationOf(end) !== 'none');

    let type = 'association';
    let sourceEnd = first;
    let targetEnd = second;

    if (marked) {
      targetEnd = marked;
      sourceEnd = marked === first ? second : first;
      type = aggregationOf(marked) === 'composite' ? 'composition' : 'aggregation';
    }

    const sourceId = this.endTypeId(sourceEnd);
    const targetId = this.endTypeId(targetEnd);
    if (!sourceId || !targetId) return null;

    return {
      id: mapId(this.xmiAttr(el, 'id')),
      type,
      sourceId: mapId(sourceId),
      targetId: mapId(targetId),
      labels: [this.readMultiplicity(sourceEnd), this.readMultiplicity(targetEnd)]
    };
  }

  /**
   * Multiplicidad de un extremo, reconstruida como la escribe el usuario en el
   * lienzo. UML la guarda en dos valores separados: `1..*` son un límite inferior
   * `1` y uno superior `*`.
   */
  private readMultiplicity(end: Element): string {
    const lower = this.valueOf(end, 'lowerValue');
    const upper = this.valueOf(end, 'upperValue');

    if (lower === null && upper === null) return '';
    const low = this.normalizeBound(lower ?? '1');
    const high = this.normalizeBound(upper ?? low);

    return this.normalizeMultiplicity(low === high ? low : `${low}..${high}`);
  }

  /**
   * EA escribe el límite superior "sin tope" como `-1`, no como `*`. Tomarlo
   * literal daría multiplicidades como `1..-1`.
   */
  private normalizeBound(value: string): string {
    return value.trim() === '-1' ? '*' : value.trim();
  }

  /** `0..*` se escribe `*` en el lienzo, que es como lo tipea la gente. */
  private normalizeMultiplicity(value: string): string {
    const clean = value.trim();
    return clean === '0..*' ? '*' : clean;
  }

  private valueOf(end: Element, localName: string): string | null {
    const el = this.kids(end, localName)[0];
    if (!el) return null;
    return this.plainAttr(el, 'value');
  }

  // ========= Lectura de clases =========

  /**
   * Atributos propios de una clase.
   *
   * Un `ownedAttribute` con el atributo `association` no es un campo de la clase:
   * es el extremo navegable de una asociación, que EA guarda dentro de la clase.
   * Si se tomara como atributo, cada relación aparecería además como una columna
   * fantasma en la tabla generada.
   */
  private readAttributes(
    cls: Element,
    nameById: Map<string, string>,
    eaTypeByAttrId: Map<string, string>,
    warnings: string[]
  ) {
    return this.kids(cls, 'ownedAttribute')
      .filter(attr => !this.plainAttr(attr, 'association'))
      .map(attr => {
        const name = this.plainAttr(attr, 'name') || 'campo';

        // El tipo declarado en la extensión de EA gana: en la parte UML un
        // `float` aparece como `UnlimitedNatural` y se perdería la precisión.
        const ownId = this.xmiAttr(attr, 'id');
        const declared = ownId ? eaTypeByAttrId.get(ownId) : undefined;
        const type = declared ? this.capitalize(declared) : this.resolveType(attr, nameById);

        if (!type) {
          warnings.push(`El atributo "${name}" no declaraba tipo; se asumió String.`);
        }
        return { name, type: type || 'String' };
      });
  }

  private readOperations(cls: Element, nameById: Map<string, string>) {
    return this.kids(cls, 'ownedOperation').map(op => {
      const params = this.kids(op, 'ownedParameter');
      const ret = params.find(p => this.plainAttr(p, 'direction') === 'return');
      const args = params
        .filter(p => p !== ret)
        .map(p => {
          const pName = this.plainAttr(p, 'name') || 'arg';
          const pType = this.resolveType(p, nameById);
          return pType ? `${pName}: ${pType}` : pName;
        });

      return {
        name: this.plainAttr(op, 'name') || 'metodo',
        parameters: args.join(', '),
        returnType: (ret && this.resolveType(ret, nameById)) || ''
      };
    });
  }

  /**
   * Tipo de un atributo o parámetro. Aparece de tres formas según la versión de
   * EA: como `href` a los primitivos de la OMG, como referencia por id a un tipo
   * declarado en el propio archivo (`EAJava_int` → `name="int"`), o como
   * atributo suelto.
   *
   * El nombre sale capitalizado porque los generadores de SQL y de backend
   * traducen los tipos con una tabla que usa `String`, `Integer`, `Date`: un
   * `string` en minúscula no se encontraría y caería en el tipo por defecto.
   */
  private resolveType(owner: Element, nameById: Map<string, string>): string | null {
    const typeEl = this.kids(owner, 'type')[0];

    if (typeEl) {
      const href = this.plainAttr(typeEl, 'href');
      if (href) {
        const fragment = href.split('#').pop();
        if (fragment) return this.capitalize(fragment);
      }
      const ref = this.xmiAttr(typeEl, 'idref') ?? this.plainAttr(typeEl, 'idref');
      if (ref) {
        const name = nameById.get(ref);
        return name ? this.capitalize(name) : null;
      }
    }

    const direct = this.plainAttr(owner, 'type');
    if (direct) {
      const name = nameById.get(direct);
      return name ? this.capitalize(name) : null;
    }

    return null;
  }

  /**
   * Geometría de las cajas, que vive en el bloque de extensión de EA y no en el
   * modelo UML. Sin esto todas las clases se apilarían en la misma posición.
   */
  private readGeometry(doc: Document): Map<string, Geometry> {
    const result = new Map<string, Geometry>();

    for (const el of this.deep(doc, 'element')) {
      const subject = this.plainAttr(el, 'subject');
      const geometry = this.plainAttr(el, 'geometry');
      if (!subject || !geometry) continue;

      const parts = new Map<string, number>();
      for (const chunk of geometry.split(';')) {
        const [key, raw] = chunk.split('=');
        const value = Number(raw);
        if (key && Number.isFinite(value)) parts.set(key.trim(), value);
      }

      const left = parts.get('Left');
      const top = parts.get('Top');
      const right = parts.get('Right');
      const bottom = parts.get('Bottom');
      // Los conectores traen geometría de ruta (SX/SY/EX/EY) y no de caja.
      if (left === undefined || top === undefined) continue;

      result.set(subject, {
        position: { x: left, y: top },
        size: {
          width: right !== undefined ? Math.max(right - left, 60) : this.DEFAULT_SIZE.width,
          height: bottom !== undefined ? Math.max(bottom - top, 40) : this.DEFAULT_SIZE.height
        }
      });
    }

    return result;
  }

  // ========= Utilidades de XML =========

  /** El id de clase al que apunta un extremo de asociación. */
  private endTypeId(end: Element): string | null {
    const direct = this.plainAttr(end, 'type');
    if (direct) return direct;
    const typeEl = this.kids(end, 'type')[0];
    if (typeEl) return this.xmiAttr(typeEl, 'idref') ?? this.plainAttr(typeEl, 'idref');
    return null;
  }

  /** Referencia que algunos archivos escriben como hijo en vez de como atributo. */
  private refOfChild(el: Element, localName: string): string | null {
    const child = this.kids(el, localName)[0];
    if (!child) return null;
    return this.xmiAttr(child, 'idref') ?? this.plainAttr(child, 'idref');
  }

  /** `uml:Class` → `Class`. El prefijo cambia entre archivos, el nombre no. */
  private typeOf(el: Element): string | null {
    const raw = this.xmiAttr(el, 'type');
    if (!raw) return null;
    return raw.includes(':') ? raw.split(':').pop()! : raw;
  }

  /**
   * Atributo con prefijo, como `xmi:id`. Se busca por nombre local porque el
   * prefijo no está garantizado; el segundo intento cubre los archivos que no
   * declaran el espacio de nombres y donde `xmi:id` queda como nombre literal.
   */
  private xmiAttr(el: Element, localName: string): string | null {
    for (const a of Array.from(el.attributes)) {
      if (a.prefix && a.localName === localName) return a.value;
      if (a.name === `xmi:${localName}`) return a.value;
    }
    return null;
  }

  /** Atributo sin prefijo, como `name` o `aggregation`. */
  private plainAttr(el: Element, name: string): string | null {
    const value = el.getAttribute(name);
    return value === null || value === '' ? null : value;
  }

  private kids(el: Element, localName: string): Element[] {
    return Array.from(el.children).filter(child => this.local(child) === localName);
  }

  private deep(root: Document, localName: string): Element[] {
    return Array.from(root.getElementsByTagName('*')).filter(el => this.local(el) === localName);
  }

  private local(el: Element): string {
    const name = el.localName;
    const colon = name.indexOf(':');
    return colon === -1 ? name : name.slice(colon + 1);
  }

  private capitalize(value: string): string {
    return value.charAt(0).toUpperCase() + value.slice(1);
  }
}
