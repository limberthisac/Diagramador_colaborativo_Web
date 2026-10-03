import { EditionService } from './edition.service';

describe('EditionService - tamaño manual', () => {
  it('conserva el tamaño elegido y no recorta el contenido', () => {
    const service = new EditionService({} as any, {} as any);
    const state: Record<string, any> = {
      size: { width: 180, height: 110 }
    };
    const model = {
      isElement: () => true,
      get: (key: string) => state[key],
      set: (key: string, value: any) => state[key] = value,
      size: () => state['size'],
      resize: (width: number, height: number) => state['size'] = { width, height },
      attr: () => undefined,
      portProp: () => undefined
    };
    const paper = {
      findViewByModel: () => ({
        findBySelector: () => [{ getBBox: () => ({ height: 25 }) }]
      })
    };

    service.setManualSize(model, paper, 320, 240);

    expect(state['manualSize']).toEqual({ width: 320, height: 240 });
    expect(state['size']).toEqual({ width: 320, height: 240 });
  });

  it('respeta el ancho y alto mínimos', () => {
    const service = new EditionService({} as any, {} as any);
    const state: Record<string, any> = { size: { width: 180, height: 110 } };
    const model = {
      isElement: () => true,
      get: (key: string) => state[key],
      set: (key: string, value: any) => state[key] = value,
      size: () => state['size'],
      resize: (width: number, height: number) => state['size'] = { width, height },
      attr: () => undefined,
      portProp: () => undefined
    };
    const paper = {
      findViewByModel: () => ({
        findBySelector: () => [{ getBBox: () => ({ height: 0 }) }]
      })
    };

    service.setManualSize(model, paper, 20, 20);

    expect(state['size'].width).toBe(service.MIN_W);
    expect(state['size'].height).toBe(
      service.NAME_H + service.MIN_ATTRS_H + service.MIN_METHS_H
    );
  });

  it('asigna el alto adicional a atributos y mantiene fijo el bloque de métodos', () => {
    const service = new EditionService({} as any, {} as any);
    const state: Record<string, any> = { size: { width: 180, height: 110 } };
    const attrs: Record<string, any> = {};
    const model = {
      isElement: () => true,
      get: (key: string) => state[key],
      set: (key: string, value: any) => state[key] = value,
      size: () => state['size'],
      resize: (width: number, height: number) => state['size'] = { width, height },
      attr: (path: string | Record<string, any>, value?: any) => {
        if (typeof path === 'string') attrs[path] = value;
        else Object.assign(attrs, path);
      },
      portProp: () => undefined
    };
    const paper = {
      findViewByModel: () => ({
        findBySelector: (selector: string) => [{
          getBBox: () => ({ height: selector.includes('methods') ? 20 : 30 })
        }]
      })
    };

    service.setManualSize(model, paper, 220, 260);

    const separatorY = attrs['.sep-attrs'].y1;
    const methodsTop = Number(
      String(attrs['.uml-class-methods-text/transform']).match(/,\s*(\d+)/)?.[1]
    );
    expect(separatorY).toBe(230.5);
    expect(methodsTop).toBe(240);
    expect(state['size'].height - separatorY).toBeCloseTo(29.5, 1);
  });
});
