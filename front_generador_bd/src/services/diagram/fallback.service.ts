import { Injectable } from '@angular/core';
import { UmlClass } from '../../models/uml-class.model';

@Injectable({
  providedIn: 'root'
})
export class FallbackService {
  
  /**
   * Crea un elemento HTML como respaldo cuando JointJS falla
   */
  createFallbackElement(container: HTMLElement, umlClass: UmlClass): HTMLElement {
    const div = document.createElement('div');
    div.className = 'fallback-entity';
    
    // Formateamos los atributos y métodos
    const attributes = umlClass.attributes
      .map(attr => `${attr.name}: ${attr.type}`)
      .join('<br>');
    
    const methods = umlClass.methods
      .map(method => {
        const params = method.parameters ? `(${method.parameters})` : '()';
        const returnType = method.returnType ? `: ${method.returnType}` : '';
        return `${method.name}${params}${returnType}`;
      })
      .join('<br>');
    
    // Creamos la estructura HTML
    div.innerHTML = `
      <div class="entity-header">${umlClass.name}</div>
      <div class="entity-attrs">${attributes || 'Sin atributos'}</div>
      <div class="entity-methods">${methods || 'Sin métodos'}</div>
    `;
    
    // Configuramos el estilo y posición
    div.style.position = 'absolute';
    div.style.left = `${umlClass.position.x}px`;
    div.style.top = `${umlClass.position.y}px`;
    div.style.width = `${umlClass.size?.width || 180}px`;
    div.style.zIndex = '1000';
    
    // Hacemos el elemento arrastrable
    this.makeElementDraggable(div);
    
    // Añadimos al contenedor
    container.appendChild(div);
    
    return div;
  }
  
  /**
   * Hace un elemento HTML arrastrable
   */
  private makeElementDraggable(element: HTMLElement): void {
    element.onmousedown = (e: MouseEvent) => {
      e.preventDefault();
      
      // Obtenemos la posición inicial
      const rect = element.getBoundingClientRect();
      let offsetX = e.clientX - rect.left;
      let offsetY = e.clientY - rect.top;
      
      const mouseMoveHandler = (e: MouseEvent) => {
        element.style.left = (e.clientX - offsetX) + 'px';
        element.style.top = (e.clientY - offsetY) + 'px';
      };
      
      const mouseUpHandler = () => {
        document.removeEventListener('mousemove', mouseMoveHandler);
        document.removeEventListener('mouseup', mouseUpHandler);
      };
      
      // Añadimos listeners para el arrastre
      document.addEventListener('mousemove', mouseMoveHandler);
      document.addEventListener('mouseup', mouseUpHandler);
    };
  }
}
