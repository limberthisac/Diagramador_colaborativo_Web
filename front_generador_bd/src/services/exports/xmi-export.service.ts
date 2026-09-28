import { Injectable } from '@angular/core';

@Injectable({
  providedIn: 'root'
})
export class XmiExportService {

  constructor() { }

  exportToXmi(umlJson: any, filename: string = 'diagrama_ea.xml') {
    if (!umlJson || !umlJson.classes) {
      console.warn("No hay clases para exportar a XMI.");
      return;
    }

    // Índice de clases de asociación: id del conector → id de la clase.
    //
    // En UML 2 una clase de asociación no son dos elementos unidos: es UN solo
    // elemento que es clase y asociación a la vez. Así que las tres piezas que
    // nuestro modelo guarda por separado —la asociación N:M, la clase con los
    // atributos y la línea punteada entre ambas— se funden acá en un único
    // `uml:AssociationClass`.
    const assocClassByLink = new Map<string, string>();
    for (const rel of umlJson.relationships || []) {
      if (rel.type === 'associationClass') {
        assocClassByLink.set(rel.sourceId, rel.targetId);
      }
    }
    const assocClassIds = new Set(assocClassByLink.values());

    let xml = `<?xml version="1.0" encoding="windows-1252"?>\n`;
    xml += `<xmi:XMI xmlns:xmi="http://schema.omg.org/spec/XMI/2.1" xmlns:uml="http://schema.omg.org/spec/UML/2.1">\n`;
    xml += `  <xmi:Documentation exporter="Diagramador Web" exporterVersion="1.0"/>\n`;
    xml += `  <uml:Model xmi:type="uml:Model" name="EA_Model" visibility="public">\n`;
    xml += `    <packagedElement xmi:type="uml:Package" xmi:id="pkg1" name="Modelo Generado">\n`;

    // 1. Procesar clases
    umlJson.classes.forEach((cls: any) => {
      // Una clase de asociación no se emite suelta: sale fusionada con su
      // asociación, en el bloque de relaciones.
      if (assocClassIds.has(cls.id)) return;

      xml += `      <packagedElement xmi:type="uml:Class" xmi:id="${cls.id}" name="${this.esc(cls.name)}">\n`;
      xml += this.featuresXml(cls);

      // Herencias (Generalization) - Se inyectan dentro de la clase de origen
      if (umlJson.relationships) {
        umlJson.relationships
          .filter((r: any) => r.type === 'generalization' && r.sourceId === cls.id)
          .forEach((rel: any) => {
            const relId = rel.id || `gen_${cls.id}_${rel.targetId}`;
            xml += `        <generalization xmi:id="${relId}" general="${rel.targetId}"/>\n`;
          });
      }

      xml += `      </packagedElement>\n`;
    });

    // 2. Procesar relaciones (Asociaciones, Agregaciones, Composiciones, Dependencias)
    if (umlJson.relationships && umlJson.relationships.length > 0) {
      umlJson.relationships.forEach((rel: any, index: number) => {
        if (rel.type === 'generalization') return;     // Procesadas arriba
        if (rel.type === 'associationClass') return;   // Se funde con su asociación

        const relId = rel.id || `rel_${index}`;
        // En nuestro JSON exportado, los labels suelen estar en: [0] source, [1] target, [2] custom name
        const sourceCard = (rel.labels && rel.labels.length > 0) ? rel.labels[0] : '';
        const targetCard = (rel.labels && rel.labels.length > 1) ? rel.labels[1] : '';
        const relName = (rel.labels && rel.labels.length > 2) ? rel.labels[2] : '';

        if (rel.type === 'dependency') {
          xml += `      <packagedElement xmi:type="uml:Dependency" xmi:id="${relId}" client="${rel.sourceId}" supplier="${rel.targetId}" name="${this.esc(relName)}"/>\n`;
          return;
        }

        // association, aggregation, composition
        let srcAggregation = 'none';
        if (rel.type === 'aggregation') srcAggregation = 'shared';
        if (rel.type === 'composition') srcAggregation = 'composite';

        // ¿Tiene una clase de asociación colgada? Entonces este elemento lleva
        // también el nombre, los atributos y las operaciones de esa clase.
        const joinClass = umlJson.classes.find(
          (c: any) => c.id === assocClassByLink.get(rel.id)
        );
        const xmiType = joinClass ? 'uml:AssociationClass' : 'uml:Association';
        const name = joinClass ? joinClass.name : relName;

        xml += `      <packagedElement xmi:type="${xmiType}" xmi:id="${relId}" name="${this.esc(name)}">\n`;

        if (joinClass) {
          xml += this.featuresXml(joinClass);
        }

        xml += `        <memberEnd xmi:idref="${relId}_src"/>\n`;
        xml += `        <memberEnd xmi:idref="${relId}_tgt"/>\n`;

        // El rombo se DIBUJA en el extremo del todo, pero el atributo
        // `aggregation` del metamodelo va en el extremo OPUESTO, el de la parte:
        // la especificación dice que "composite" marca a la propiedad que está
        // agregada, y la agregada es la parte. En nuestro lienzo el rombo se
        // dibuja en el origen, así que la marca viaja al destino.
        xml += `        <ownedEnd xmi:type="uml:Property" xmi:id="${relId}_src" type="${rel.sourceId}" association="${relId}">\n`;
        xml += this.multiplicityXml(sourceCard, `${relId}_src`);
        xml += `        </ownedEnd>\n`;

        xml += `        <ownedEnd xmi:type="uml:Property" xmi:id="${relId}_tgt" type="${rel.targetId}" association="${relId}" aggregation="${srcAggregation}">\n`;
        xml += this.multiplicityXml(targetCard, `${relId}_tgt`);
        xml += `        </ownedEnd>\n`;

        xml += `      </packagedElement>\n`;
      });
    }

    xml += `    </packagedElement>\n`;
    xml += `  </uml:Model>\n`;

    // 3. Extensiones de Enterprise Architect para visualización del diagrama
    xml += `  <xmi:Extension extender="Enterprise Architect" extenderID="6.5">\n`;
    xml += `    <diagrams>\n`;
    xml += `      <diagram xmi:id="diagram_1" name="Diagrama Generado" type="Logical" format="1.0" version="1.0">\n`;
    xml += `        <model package="pkg1" localID="1" owner="pkg1"/>\n`;
    xml += `        <properties name="Diagrama Generado" type="Logical"/>\n`;
    xml += `        <project author="Diagramador Web" version="1.0" created="${new Date().toISOString().substring(0, 10)} 00:00:00" modified="${new Date().toISOString().substring(0, 10)} 00:00:00"/>\n`;
    xml += `        <style1 value="ShowPrivate=1;ShowProtected=1;ShowPublic=1;HideRelationships=0;Locked=0;Border=1;HighlightForeign=1;PackageContents=1;SequenceNotes=0;ScalePrintImage=0;PPgs.cx=1;PPgs.cy=1;DocSize.cx=826;DocSize.cy=1169;ShowDetails=0;Orientation=P;Zoom=100;ShowTags=0;OpParams=1;VisibleAttributeDetail=0;ShowOpRetType=1;ShowIcons=1;CollabNums=0;HideProps=0;ShowReqs=0;ShowCons=0;PaperSize=9;HideParents=0;UseAlias=0;HideAtts=0;HideOps=0;HideStereo=0;HideElemStereo=0;ShowTests=0;ShowMaint=0;ConnectorNotation=UML 2.1;ExplicitNavigability=0;ShowShape=1;AdvancedElementProps=1;AdvancedFeatureProps=1;AdvancedConnectorProps=1;m_bElement_in_16_colors=0;"/>\n`;
    xml += `        <style2 value="ExcludeRTF=0;DocAll=0;HideQuals=0;AttPkg=1;ShowTests=0;ShowMaint=0;SuppressFOC=1;MatrixActive=0;SwimlanesActive=1;KanbanActive=0;MatrixLineWidth=1;MatrixLineClr=0;MatrixLocked=0;TConnectorNotation=UML 2.1;TExplicitNavigability=0;AdvancedElementProps=1;AdvancedFeatureProps=1;AdvancedConnectorProps=1;m_bElement_in_16_colors=0;"/>\n`;
    xml += `        <elements>\n`;

    let seq = 1;
    // Elementos visuales de las clases
    umlJson.classes.forEach((cls: any) => {
      // La geometría de una clase de asociación se emite junto a su relación,
      // porque en el XMI las dos son el mismo elemento y comparten el id.
      if (assocClassIds.has(cls.id)) return;

      const left = Math.round(cls.position?.x || 100);
      const top = Math.round(cls.position?.y || 100);
      const right = left + Math.round(cls.size?.width || 180);
      const bottom = top + Math.round(cls.size?.height || 110);

      xml += `          <element geometry="Left=${left};Top=${top};Right=${right};Bottom=${bottom};" subject="${cls.id}" seqno="${seq++}" style="DUID=${cls.id}_visual;"/>\n`;
    });

    // Elementos visuales de las relaciones
    if (umlJson.relationships && umlJson.relationships.length > 0) {
      umlJson.relationships.forEach((rel: any, index: number) => {
        // La línea punteada no es un elemento propio en el XMI.
        if (rel.type === 'associationClass') return;

        const relId = rel.id || `rel_${index}`;
        const joinClass = umlJson.classes.find(
          (c: any) => c.id === assocClassByLink.get(rel.id)
        );

        if (joinClass) {
          // Es una clase de asociación: además del conector necesita la caja,
          // así que se le da la posición que tenía la clase en el lienzo.
          const left = Math.round(joinClass.position?.x || 100);
          const top = Math.round(joinClass.position?.y || 100);
          const right = left + Math.round(joinClass.size?.width || 180);
          const bottom = top + Math.round(joinClass.size?.height || 110);
          xml += `          <element geometry="Left=${left};Top=${top};Right=${right};Bottom=${bottom};SX=0;SY=0;EX=0;EY=0;Path=;" subject="${relId}" seqno="${seq++}" style="DUID=${joinClass.id}_visual;"/>\n`;
          return;
        }

        xml += `          <element geometry="SX=0;SY=0;EX=0;EY=0;Path=;" subject="${relId}" style=";Hidden=0;" seqno="${seq++}"/>\n`;
      });
    }

    xml += `        </elements>\n`;
    xml += `      </diagram>\n`;
    xml += `    </diagrams>\n`;
    xml += `  </xmi:Extension>\n`;

    xml += `</xmi:XMI>`;

    this.downloadFile(xml, filename);
  }

  // ========= Helpers privados =========

  /**
   * Atributos y operaciones de una clase. Se comparte entre las clases sueltas
   * y las clases de asociación, que llevan exactamente las mismas características.
   */
  private featuresXml(cls: any): string {
    let xml = '';

    if (cls.attributes && cls.attributes.length > 0) {
      cls.attributes.forEach((attr: any, index: number) => {
        const attrId = `${cls.id}_attr_${index}`;
        xml += `        <ownedAttribute xmi:type="uml:Property" xmi:id="${attrId}" name="${this.esc(attr.name)}" visibility="private">\n`;
        xml += `          <type xmi:type="uml:PrimitiveType" href="http://schema.omg.org/spec/UML/2.1/uml.xml#${(attr.type || 'String').toLowerCase()}"/>\n`;
        xml += `        </ownedAttribute>\n`;
      });
    }

    if (cls.methods && cls.methods.length > 0) {
      cls.methods.forEach((method: any, index: number) => {
        const methodId = `${cls.id}_op_${index}`;
        xml += `        <ownedOperation xmi:type="uml:Operation" xmi:id="${methodId}" name="${this.esc(method.name)}" visibility="public">\n`;
        if (method.returnType) {
          xml += `          <ownedParameter xmi:type="uml:Parameter" xmi:id="${methodId}_return" direction="return">\n`;
          xml += `            <type xmi:type="uml:PrimitiveType" href="http://schema.omg.org/spec/UML/2.1/uml.xml#${method.returnType.toLowerCase()}"/>\n`;
          xml += `          </ownedParameter>\n`;
        }
        xml += `        </ownedOperation>\n`;
      });
    }

    return xml;
  }

  /**
   * Multiplicidad de un extremo de asociación.
   *
   * UML la guarda en dos valores separados, no en la cadena que se ve en el
   * lienzo: `1..*` son un límite inferior `1` y uno superior `*`. Un valor suelto
   * como `1` significa que ambos límites valen lo mismo.
   */
  private multiplicityXml(cardinality: string, endId: string): string {
    const raw = (cardinality || '').trim();
    if (!raw) return '';

    const [lowerRaw, upperRaw] = raw.includes('..')
      ? raw.split('..').map(s => s.trim())
      : [raw, raw];

    // `*` a secas equivale a `0..*`
    const lower = lowerRaw === '*' ? '0' : lowerRaw;
    const upper = upperRaw || lower;

    let xml = `          <lowerValue xmi:type="uml:LiteralInteger" xmi:id="${endId}_lower" value="${this.esc(lower)}"/>\n`;
    xml += `          <upperValue xmi:type="uml:LiteralUnlimitedNatural" xmi:id="${endId}_upper" value="${this.esc(upper)}"/>\n`;
    return xml;
  }

  /** Escapa lo que va dentro de un atributo XML. */
  private esc(value: any): string {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  private downloadFile(content: string, filename: string) {
    const blob = new Blob([content], { type: 'application/xml' });
    const url = window.URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    window.URL.revokeObjectURL(url);
    document.body.removeChild(a);
  }
}
