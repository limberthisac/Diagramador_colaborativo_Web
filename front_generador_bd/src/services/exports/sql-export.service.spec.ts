import { SqlExportService } from './sql-export.service';

describe('SqlExportService', () => {
  const employeeClass = {
    id: 'employee',
    name: 'Employee',
    attributes: [{ name: 'id', type: 'int' }],
    methods: []
  };

  it('genera una FK autorreferenciada 1:N usando el rol', () => {
    const service = new SqlExportService();
    const sql = service.exportToSql({
      classes: [employeeClass],
      relationships: [{
        id: 'supervision',
        type: 'association',
        sourceId: 'employee',
        targetId: 'employee',
        labels: ['1', '0..*', 'supervisor', 'subordinates']
      }]
    });

    expect(sql).toContain('ADD COLUMN supervisor_id INT');
    expect(sql).toContain('FOREIGN KEY (supervisor_id) REFERENCES Employee(id)');
  });

  it('genera dos FK distintas para una autorrelación N:M', () => {
    const service = new SqlExportService();
    const sql = service.exportToSql({
      classes: [employeeClass],
      relationships: [{
        id: 'mentoring',
        type: 'association',
        sourceId: 'employee',
        targetId: 'employee',
        labels: ['0..*', '0..*', 'mentor', 'mentee']
      }]
    });

    expect(sql).toContain('PRIMARY KEY (mentor_id, mentee_id)');
    expect(sql).toContain('FOREIGN KEY (mentor_id) REFERENCES Employee(id)');
    expect(sql).toContain('FOREIGN KEY (mentee_id) REFERENCES Employee(id)');
  });

  it('ignora una autoherencia inválida', () => {
    const service = new SqlExportService();
    const sql = service.exportToSql({
      classes: [employeeClass],
      relationships: [{
        id: 'invalid',
        type: 'generalization',
        sourceId: 'employee',
        targetId: 'employee',
        labels: []
      }]
    });

    expect(sql).not.toContain('ALTER TABLE Employee');
  });

  it('referencia una tabla intermedia con su clave compuesta completa', () => {
    const service = new SqlExportService();
    const sql = service.exportToSql({
      classes: [
        {
          id: 'devolucion',
          name: 'Devolucion',
          attributes: [{ name: 'id', type: 'int' }],
          methods: []
        },
        {
          id: 'producto',
          name: 'Producto',
          attributes: [{ name: 'id', type: 'int' }],
          methods: []
        },
        {
          id: 'venta',
          name: 'Venta',
          attributes: [{ name: 'id', type: 'string' }],
          methods: []
        },
        {
          id: 'detalle-venta',
          name: 'DetalleVenta',
          attributes: [
            { name: 'cantidad', type: 'int' },
            { name: 'precio_unidad', type: 'double' }
          ],
          methods: []
        },
        {
          id: 'detalle-devolucion',
          name: 'DetalleDevolucion',
          attributes: [{ name: 'cantidad_devuelta', type: 'int' }],
          methods: []
        }
      ],
      relationships: [
        {
          id: 'venta-producto',
          type: 'association',
          sourceId: 'producto',
          targetId: 'venta',
          labels: ['0..*', '1..*']
        },
        {
          id: 'detalle-venta-anchor',
          type: 'associationClass',
          sourceId: 'venta-producto',
          targetId: 'detalle-venta'
        },
        {
          id: 'devolucion-detalle-venta',
          type: 'association',
          sourceId: 'devolucion',
          targetId: 'detalle-venta',
          labels: ['0..*', '1..*']
        },
        {
          id: 'detalle-devolucion-anchor',
          type: 'associationClass',
          sourceId: 'devolucion-detalle-venta',
          targetId: 'detalle-devolucion'
        }
      ]
    });

    expect(sql).toContain(
      'PRIMARY KEY (devolucion_id, producto_id, venta_id)'
    );
    expect(sql).toContain(
      'FOREIGN KEY (producto_id, venta_id) REFERENCES DetalleVenta(producto_id, venta_id)'
    );
    expect(sql).not.toContain('REFERENCES DetalleVenta(cantidad)');
  });
});
