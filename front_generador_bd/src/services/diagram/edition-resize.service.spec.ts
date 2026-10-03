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
});
