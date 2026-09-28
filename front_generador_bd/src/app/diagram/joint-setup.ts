import * as _ from 'lodash';

// Esta función se utiliza para inicializar y configurar JointJS
export async function setupJointJS() {
  const joint = await import('jointjs');
  
  // Configuramos el estilo global para los elementos JointJS
  const defaultStyle = {
    '.connection': { stroke: '#333333', 'stroke-width': 2 },
    '.marker-target': { fill: '#333333', stroke: '#333333' },
    '.marker-source': { fill: '#333333', stroke: '#333333' }
  };
  
  // Aseguramos que el espacio de nombres shapes.standard exista
  // No sobrescribimos joint.shapes.standard, solo verificamos su existencia
  if (!joint.shapes.standard) {
    throw new Error('joint.shapes.standard no está disponible. Verifica la instalación de JointJS.');
  }
  
  // Creamos una clase personalizada para representar entidades
  class EntityShape extends joint.dia.Element {
    constructor() {
      super({
        type: 'Entity',
        size: { width: 180, height: 100 },
        attrs: {
          rect: { 
            fill: '#ffffff', 
            stroke: '#000000', 
            'stroke-width': 2,
            width: 180,
            height: 100
          },
          text: { 
            'font-size': 14, 
            'font-weight': 'bold',
            text: 'Entity Name', 
            'ref-x': .5, 
            'ref-y': .2, 
            'text-anchor': 'middle', 
            fill: '#000000'
          }
        },
        z: 100 // Z-index alto para asegurar que esté en primer plano
      });
    }
  }
  
  // Registramos la forma personalizada en el namespace de shapes
  (joint.shapes as any)['entity'] = {};
  (joint.shapes as any)['entity'].Entity = EntityShape;
  
  // Devolver el objeto JointJS configurado
  return joint;
}
