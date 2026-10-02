import { SqlExportService } from './sql-export.service';

describe('SqlExportService', () => {
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
