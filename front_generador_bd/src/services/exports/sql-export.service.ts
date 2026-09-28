import { Injectable } from '@angular/core';

@Injectable({ providedIn: 'root' })
export class SqlExportService {

  private typeMap: Record<string, string> = {
    'UUID': 'UUID',
    'String': 'VARCHAR(255)',
    'Text': 'TEXT',
    'Integer': 'INT',
    'Int': 'INT',
    'int': 'INT',
    'Long': 'BIGINT',
    'Boolean': 'BOOLEAN',
    'Float': 'FLOAT',
    'Double': 'DOUBLE PRECISION',
    'Decimal': 'DECIMAL(15,2)',
    'Date': 'DATE',
    'DateTime': 'TIMESTAMP'
  };

  private invalidPkTypes = new Set(['TEXT', 'FLOAT', 'DOUBLE PRECISION', 'DECIMAL(15,2)', 'BOOLEAN']);

  exportToSql(umlJson: any, dbName: string = 'uml_database'): string {
    let sql = '';
    // Antes esto emitía `CREATE DATABASE` y `USE`, que son sintaxis MySQL,
    // mientras los tipos de más abajo son de PostgreSQL: el script no corría en
    // ningún motor sin editarlo. La base se crea aparte, así que acá solo va la
    // instrucción de cómo ejecutarlo.
    sql += `-- Esquema generado por el Diagramador UML\n`;
    sql += `-- Motor: PostgreSQL. Ejecutar sobre una base ya creada:\n`;
    sql += `--   createdb ${dbName}\n`;
    sql += `--   psql -d ${dbName} -f este_archivo.sql\n\n`;

    // ====== CLASES DE ASOCIACIÓN ======
    // Una clase de asociación es la tabla intermedia de un muchos a muchos con
    // atributos propios. Su relación apunta del conector N:M a la clase, así que
    // acá se indexa por el id del conector para poder consultarla más abajo.
    const assocClassByLink = new Map<string, string>();
    for (const rel of umlJson.relationships || []) {
      if (rel.type === 'associationClass') {
        assocClassByLink.set(rel.sourceId, rel.targetId);
      }
    }
    // Esas clases no se emiten como tabla suelta: salen como tabla de unión.
    const assocClassIds = new Set(assocClassByLink.values());

    // ====== TABLAS ======
    for (const cls of umlJson.classes) {
      if (assocClassIds.has(cls.id)) continue;
      // Verificar si la clase es hija en una relación de herencia
      const generalizationRel = umlJson.relationships.find((rel: any) => rel.type === 'generalization' && rel.sourceId === cls.id);
      sql += `CREATE TABLE ${cls.name} (\n`;
      const columns: string[] = [];
      if (generalizationRel) {
        // Es clase hija: la PK es la referencia al padre, con mismo nombre y tipo
        const parent = umlJson.classes.find((c: any) => c.id === generalizationRel.targetId);
        let parentPkName = 'id';
        let parentPkType = 'UUID';
        if (parent.attributes && parent.attributes.length > 0) {
          const firstAttr = parent.attributes[0];
          parentPkName = firstAttr.name;
          parentPkType = this.typeMap[firstAttr.type] || 'VARCHAR(255)';
        }
        columns.push(`  ${parentPkName} ${parentPkType} PRIMARY KEY`);
        if (cls.attributes && cls.attributes.length > 0) {
          cls.attributes.forEach((attr: any) => {
            if (attr.name !== parentPkName) {
              const sqlType = this.typeMap[attr.type] || 'VARCHAR(255)';
              columns.push(`  ${attr.name} ${sqlType}`);
            }
          });
        }
      } else if (!cls.attributes || cls.attributes.length === 0) {
        columns.push(`  id UUID PRIMARY KEY`);
      } else {
        cls.attributes.forEach((attr: any, index: number) => {
          const sqlType = this.typeMap[attr.type] || 'VARCHAR(255)';
          let colDef = `  ${attr.name} ${sqlType}`;
          if (index === 0) {
            if (this.invalidPkTypes.has(sqlType)) {
              columns.push(`  id UUID PRIMARY KEY`);
              columns.push(colDef);
            } else {
              colDef += ' PRIMARY KEY';
              columns.push(colDef);
            }
          } else {
            columns.push(colDef);
          }
        });
      }
      sql += columns.join(',\n') + `\n);\n\n`;
    }

    // ====== RELACIONES ======
    for (const rel of umlJson.relationships) {
      // La clase de asociación no es una clave foránea: solo dice qué clase lleva
      // los atributos del N:M. Ya se consultó al armar el índice de arriba.
      if (rel.type === 'associationClass') continue;

      const source = umlJson.classes.find((c: any) => c.id === rel.sourceId);
      const target = umlJson.classes.find((c: any) => c.id === rel.targetId);
      if (!source || !target) continue;

      // Herencia: la tabla hija ya copia el nombre y el tipo de la clave primaria
      // del padre en el recorrido de tablas, pero nada la ataba a él. Sin esta
      // restricción la base acepta una fila hija sin su fila padre, que es
      // exactamente lo que la herencia no debería permitir.
      // `source` es la hija y `target` el padre, igual que en el recorrido de tablas.
      if (rel.type === 'generalization') {
        const childPk = this.getPrimaryKeyInfo(source, umlJson);
        const parentPk = this.getPrimaryKeyInfo(target, umlJson);
        const fkName = `fk_${source.name.toLowerCase()}_${target.name.toLowerCase()}`;
        sql += `ALTER TABLE ${source.name}\n`;
        sql += `  ADD CONSTRAINT ${fkName} FOREIGN KEY (${childPk.name}) REFERENCES ${target.name}(${parentPk.name}) ON DELETE CASCADE ON UPDATE CASCADE;\n\n`;
        continue;
      }

      // Multiplicidad
      const multSource = rel.labels?.[0] || '1';
      const multTarget = rel.labels?.[1] || '1';

      // N:M → tabla intermedia
      if (multSource.includes('*') && multTarget.includes('*')) {
        // Si el usuario colgó una clase de asociación de este conector, esa clase
        // ES la tabla intermedia: aporta el nombre y sus atributos propios.
        const joinClass = umlJson.classes.find(
          (c: any) => c.id === assocClassByLink.get(rel.id)
        );

        const joinTable = joinClass ? joinClass.name : `${source.name}_${target.name}`;
        const srcCol = `${source.name.toLowerCase()}_id`;
        const trgCol = `${target.name.toLowerCase()}_id`;
        const srcPk = this.getPrimaryKeyInfo(source, umlJson);
        const trgPk = this.getPrimaryKeyInfo(target, umlJson);

        const cols: string[] = [
          `  ${srcCol} ${srcPk.type} NOT NULL`,
          `  ${trgCol} ${trgPk.type} NOT NULL`
        ];

        // Atributos propios de la relación (fecha, nota, cantidad…).
        for (const attr of joinClass?.attributes || []) {
          // Un atributo que choque con una de las dos claves foráneas daría una
          // columna duplicada y el CREATE TABLE fallaría.
          if (attr.name === srcCol || attr.name === trgCol) continue;
          cols.push(`  ${attr.name} ${this.typeMap[attr.type] || 'VARCHAR(255)'}`);
        }

        cols.push(`  PRIMARY KEY (${srcCol}, ${trgCol})`);
        cols.push(`  CONSTRAINT fk_${joinTable}_${source.name.toLowerCase()} FOREIGN KEY (${srcCol}) REFERENCES ${source.name}(${srcPk.name}) ON DELETE CASCADE ON UPDATE CASCADE`);
        cols.push(`  CONSTRAINT fk_${joinTable}_${target.name.toLowerCase()} FOREIGN KEY (${trgCol}) REFERENCES ${target.name}(${trgPk.name}) ON DELETE CASCADE ON UPDATE CASCADE`);

        sql += `CREATE TABLE ${joinTable} (\n` + cols.join(',\n') + `\n);\n\n`;
        continue;
      }

      // Determinar el lado de la FK según multiplicidad
      let fkTable = source;
      let refTable = target;
      let fkName = `fk_${source.name.toLowerCase()}_${target.name.toLowerCase()}`;
      let column = `${target.name.toLowerCase()}_id`;
      let onDelete = 'SET NULL';
      let notNull = '';

      // Si es 1:N, la FK va en el lado N, o si es dependencia, siempre FK en source
      if (['association', 'aggregation', 'composition', 'dependency'].includes(rel.type)) {
        if (rel.type === 'dependency') {
          // Siempre FK en el source hacia el target
          fkTable = source;
          refTable = target;
          fkName = `fk_${source.name.toLowerCase()}_${target.name.toLowerCase()}`;
          column = `${target.name.toLowerCase()}_id`;
          onDelete = 'NO ACTION';
          notNull = '';
        } else {
          if (multSource.includes('*') && !multTarget.includes('*')) {
            // source: muchos, target: uno → FK en source
            fkTable = source;
            refTable = target;
            fkName = `fk_${source.name.toLowerCase()}_${target.name.toLowerCase()}`;
            column = `${target.name.toLowerCase()}_id`;
          } else if (!multSource.includes('*') && multTarget.includes('*')) {
            // source: uno, target: muchos → FK en target
            fkTable = target;
            refTable = source;
            fkName = `fk_${target.name.toLowerCase()}_${source.name.toLowerCase()}`;
            column = `${source.name.toLowerCase()}_id`;
          } else {
            // 1:1 o caso ambiguo, por convención FK en source
            fkTable = source;
            refTable = target;
            fkName = `fk_${source.name.toLowerCase()}_${target.name.toLowerCase()}`;
            column = `${target.name.toLowerCase()}_id`;
          }
          // Composición: FK NOT NULL y ON DELETE CASCADE
          if (rel.type === 'composition') {
            notNull = ' NOT NULL';
            onDelete = 'CASCADE';
          } else if (rel.type === 'aggregation') {
            onDelete = 'SET NULL';
          } else if (rel.type === 'association') {
            onDelete = 'SET NULL';
          }
        }
        // El tipo de la columna tiene que ser el de la clave primaria que
        // referencia. Antes era `UUID` fijo, así que una PK `INT` o
        // `VARCHAR(255)` hacía fallar la constraint al crearla.
        const refPk = this.getPrimaryKeyInfo(refTable, umlJson);
        sql += `ALTER TABLE ${fkTable.name}\n`;
        sql += `  ADD COLUMN ${column} ${refPk.type}${notNull},\n`;
        sql += `  ADD CONSTRAINT ${fkName} FOREIGN KEY (${column}) REFERENCES ${refTable.name}(${refPk.name}) ON DELETE ${onDelete} ON UPDATE CASCADE;\n\n`;
        continue;
      }
    }

    return sql.trim();
  }

  /**
   * Nombre y tipo SQL de la clave primaria de una clase, tal como la emite el
   * recorrido de tablas de `exportToSql`. Las columnas que la referencian tienen
   * que declararse con ese mismo tipo o la constraint no se puede crear.
   *
   * `umlJson` es opcional solo por compatibilidad con llamadas viejas; sin él no
   * se puede resolver la clave heredada de una clase hija.
   */
  private getPrimaryKeyInfo(cls: any, umlJson?: any): { name: string; type: string } {
    // Clase hija de una generalización: su PK es la del padre, con el mismo
    // nombre y tipo. Así la emite el recorrido de tablas.
    const parentRel = umlJson?.relationships?.find(
      (rel: any) => rel.type === 'generalization' && rel.sourceId === cls?.id
    );
    if (parentRel) {
      const parent = umlJson.classes.find((c: any) => c.id === parentRel.targetId);
      if (parent?.attributes?.length) {
        const parentFirst = parent.attributes[0];
        return {
          name: parentFirst.name,
          type: this.typeMap[parentFirst.type] || 'VARCHAR(255)'
        };
      }
      return { name: 'id', type: 'UUID' };
    }

    if (!cls?.attributes || cls.attributes.length === 0) {
      return { name: 'id', type: 'UUID' };
    }

    const firstAttr = cls.attributes[0];
    const sqlType = this.typeMap[firstAttr.type] || 'VARCHAR(255)';

    // Un tipo que no sirve como clave primaria hace que la tabla se emita con una
    // columna `id UUID` sintética; hay que referenciar esa y no el atributo.
    return this.invalidPkTypes.has(sqlType)
      ? { name: 'id', type: 'UUID' }
      : { name: firstAttr.name, type: sqlType };
  }

  private getPrimaryKey(cls: any, umlJson?: any): string {
    return this.getPrimaryKeyInfo(cls, umlJson).name;
  }

  downloadSql(umlJson: any, fileName: string = 'diagram.sql'): void {
    const sqlContent = this.exportToSql(umlJson);
    const blob = new Blob([sqlContent], { type: 'text/sql' });
    const url = window.URL.createObjectURL(blob);

    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.click();

    window.URL.revokeObjectURL(url);
  }
}
