import { DiagramService } from './diagram.service';

class FakeLink {
  id = 'recursive-link';
  state: Record<string, any> = {
    source: { id: 'employee' },
    target: { id: 'employee' },
    relationType: 'association',
    labels: []
  };

  get(key: string): any {
    return this.state[key];
  }

  set(key: string | Record<string, any>, value?: any): this {
    if (typeof key === 'string') this.state[key] = value;
    else Object.assign(this.state, key);
    return this;
  }

  appendLabel(label: any): void {
    this.state['labels'] = [...(this.state['labels'] || []), label];
  }
}

describe('DiagramService - autorrelaciones', () => {
  it('inserta en el grafo una relación creada mediante edición', () => {
    const service = Object.create(DiagramService.prototype) as any;
    const link = new FakeLink();
    link.state['labels'] = [
      { attrs: { text: { text: '1' } } },
      { attrs: { text: { text: '0..*' } } }
    ];
    service.createTypedRelationship = jasmine.createSpy().and.returnValue(link);
    service.graph = { addCell: jasmine.createSpy('addCell') };
    service.collab = { broadcast: jasmine.createSpy('broadcast') };

    service.createNewRelationshipFromEdit('employee', 'employee', {
      type: 'association',
      labels: ['1', '0..*', 'supervisor', 'subordinates']
    });

    expect(service.graph.addCell).toHaveBeenCalledOnceWith(link);
  });

  it('genera un rectángulo unido a dos puntos del lado derecho', () => {
    const service = Object.create(DiagramService.prototype) as any;
    const link = new FakeLink();
    link.state['labels'] = [{}, {}];
    service.graph = {
      getLinks: () => [link],
      getCell: () => ({
        getBBox: () => ({ x: 100, y: 100, width: 180, height: 110 })
      })
    };

    service.layoutRecursiveLinksForElement('employee');

    expect(link.state['source'].id).toBe('employee');
    expect(link.state['target'].id).toBe('employee');
    expect(link.state['source'].anchor.name).toBe('right');
    expect(link.state['target'].anchor.name).toBe('right');
    expect(link.state['vertices'][0].x).toBe(link.state['vertices'][1].x);
    expect(link.state['vertices'][0].y).toBeLessThan(link.state['vertices'][1].y);
  });
});
