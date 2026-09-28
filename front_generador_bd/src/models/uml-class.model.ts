export interface Attribute {
  name: string;
  type: string;
}

export interface Method {
  name: string;
  parameters?: string;
  returnType?: string;
}

export interface UmlClass {
  id?: string;
  name: string;
  attributes: Attribute[];
  methods: Method[];
  position: { x: number; y: number };
  size?: { width: number; height: number };
}
