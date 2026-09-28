import json
import os
from pathlib import Path
import unicodedata

class FlutterCRUDGenerator:
    def __init__(self, uml_json):
        self.uml_json = uml_json
        self.classes = uml_json.get('classes', [])
        self.relationships = uml_json.get('relationships', [])
        self.parsed_relationships = self._parse_relationships()

    def _parse_relationships(self):
      """Convierte relaciones UML en vínculos lógicos entre clases - MISMA LÓGICA QUE ProjectGenerator.java"""
      relations_map = {cls['id']: cls['name'] for cls in self.classes}
      parsed = []
      
      # Detectar relaciones ManyToMany para crear entidades intermedias
      many_to_many_relations = []

      for rel in self.relationships:
          src = relations_map.get(rel.get('sourceId'))
          tgt = relations_map.get(rel.get('targetId'))
          if not src or not tgt:
              continue
          
          rtype = rel.get("type", "").lower()
          labels = rel.get("labels", [])

          if rtype == "generalization":
              parsed.append({"from": src, "to": tgt, "kind": "inherits"})
          elif rtype in ["association", "aggregation", "composition", "dependency"]:
              # 1) Normalizar etiquetas (vacías -> valores por defecto)
              raw_source = labels[0].strip() if len(labels) > 0 and labels[0] else ""
              raw_target = labels[1].strip() if len(labels) > 1 and labels[1] else ""
              
              # Por defecto: source tiene multiplicidad *, target tiene multiplicidad 1
              source_card = raw_source if raw_source else "*"
              target_card = raw_target if raw_target else "1"
              
              # 2) Regla por defecto para dependency SIN multiplicidades
              if rtype == "dependency":
                  no_multis = (not raw_source and not raw_target)
                  if no_multis:
                      # Por defecto: muchos dependientes (*) apuntan a un principal (1)
                      source_card = "*"
                      target_card = "1"
              
              # 3) Detectar "many"
              source_is_many = "*" in source_card
              target_is_many = "*" in target_card
              
              # Prevenir que dependency sea tratado como 1..1
              if rtype == "dependency" and not source_is_many and not target_is_many:
                  source_is_many = True
                  target_is_many = False
              
              # 4) Aplicar lógica según multiplicidades (igual que ProjectGenerator.java)
              if source_is_many and target_is_many:
                  # *..* => ManyToMany - se generará entidad intermedia
                  first_entity = src if src < tgt else tgt
                  second_entity = tgt if src < tgt else src
                  intermediate_name = first_entity + second_entity
                  
                  many_to_many_relations.append({
                      "from": src,
                      "to": tgt,
                      "intermediate": intermediate_name,
                      "first": first_entity,
                      "second": second_entity
                  })
                  
                  # Agregar relaciones OneToMany desde ambas entidades originales hacia la intermedia
                  parsed.append({"from": src, "to": intermediate_name, "kind": "one_to_many"})
                  parsed.append({"from": tgt, "to": intermediate_name, "kind": "one_to_many"})
              elif source_is_many and not target_is_many:
                  # source *..1 target => Source tiene ManyToOne hacia Target
                  parsed.append({"from": src, "to": tgt, "kind": "many_to_one"})
              elif not source_is_many and not target_is_many:
                  # 1..1 => OneToOne
                  is_composition = rtype == "composition"
                  parsed.append({"from": src, "to": tgt, "kind": "one_to_one", "composition": is_composition})
              elif not source_is_many and target_is_many:
                  # source 1..* target => Source tiene OneToMany hacia Target
                  parsed.append({"from": src, "to": tgt, "kind": "one_to_many"})
              
              # === Lado INVERSO (Target) ===
              if not target_is_many and source_is_many:
                  # source *..1 target => Target tiene OneToMany hacia Source (relación inversa)
                  parsed.append({"from": tgt, "to": src, "kind": "one_to_many"})
              elif target_is_many and not source_is_many:
                  # source 1..* target => Target tiene ManyToOne hacia Source (relación inversa)
                  parsed.append({"from": tgt, "to": src, "kind": "many_to_one"})

      return parsed
        
    def generate_project(self, output_dir="generated_flutter_app"):
        """Genera el proyecto Flutter completo"""
        base_path = Path(output_dir)
        
        # Crear estructura de carpetas
        self._create_folder_structure(base_path)
        
        # Generar archivos base
        self._generate_pubspec(base_path)
        self._generate_config(base_path)
        
        # Detectar entidades intermedias de ManyToMany
        intermediate_entities = self._detect_intermediate_entities()
        
        # Agregar entidades intermedias a self.classes para que sean consideradas en el procesamiento
        # y agregar sus relaciones ManyToOne a parsed_relationships
        for intermediate in intermediate_entities:
            intermediate_name = intermediate['name']
            first_entity = intermediate['first_entity']
            second_entity = intermediate['second_entity']
            
            # Agregar la entidad intermedia como una "clase" temporal
            # Esto permite que sea detectada por related_class en _generate_detail_view
            self.classes.append({
                'id': f'intermediate_{intermediate_name}',
                'name': intermediate_name,
                'attributes': [
                    {'name': 'id', 'type': 'Long'}
                ],
                'is_intermediate': True  # Marcar como intermedia
            })
            
            # Agregar relación ManyToOne desde entidad intermedia a primera entidad
            self.parsed_relationships.append({
                "from": intermediate_name,
                "to": first_entity,
                "kind": "many_to_one"
            })
            
            # Agregar relación ManyToOne desde entidad intermedia a segunda entidad
            self.parsed_relationships.append({
                "from": intermediate_name,
                "to": second_entity,
                "kind": "many_to_one"
            })
        
        # Generar modelos, servicios y vistas para cada clase
        for clase in self.classes:
            self._generate_model(base_path, clase)
            self._generate_service(base_path, clase)
            self._generate_list_view(base_path, clase)
            self._generate_form_view(base_path, clase)
            self._generate_detail_view(base_path, clase)
        
        # Generar entidades intermedias (modelos, servicios y vistas)
        for intermediate in intermediate_entities:
            self._generate_intermediate_model(base_path, intermediate)
            self._generate_intermediate_service(base_path, intermediate)
            self._generate_intermediate_list_view(base_path, intermediate)
            self._generate_intermediate_form_view(base_path, intermediate)
            self._generate_intermediate_detail_view(base_path, intermediate)
        
        # Generar main.dart con todas las clases (originales + intermedias)
        self._generate_main(base_path, intermediate_entities)
        
        # Generar archivo de rutas
        self._generate_routes(base_path)
        
        print(f"✅ Proyecto Flutter generado en: {output_dir}")
        
    def _detect_intermediate_entities(self):
        """Detecta entidades intermedias generadas por relaciones ManyToMany"""
        intermediate_entities = []
        processed = set()
        
        for rel in self.relationships:
            if rel.get("type", "").lower() not in ["association", "aggregation", "composition", "dependency"]:
                continue
            
            src = next((c['name'] for c in self.classes if c['id'] == rel.get('sourceId')), None)
            tgt = next((c['name'] for c in self.classes if c['id'] == rel.get('targetId')), None)
            
            if not src or not tgt:
                continue
            
            labels = rel.get("labels", [])
            source_card = labels[0].strip() if len(labels) > 0 else ""
            target_card = labels[1].strip() if len(labels) > 1 else ""
            
            source_is_many = "*" in source_card
            target_is_many = "*" in target_card
            
            if source_is_many and target_is_many:
                # Ordenar alfabéticamente para consistencia
                first_entity = src if src < tgt else tgt
                second_entity = tgt if src < tgt else src
                intermediate_name = first_entity + second_entity
                
                # Evitar duplicados
                if intermediate_name in processed:
                    continue
                processed.add(intermediate_name)
                
                intermediate_entities.append({
                    "name": intermediate_name,
                    "first_entity": first_entity,
                    "second_entity": second_entity
                })
        
        return intermediate_entities
    
    def _create_folder_structure(self, base_path):
        """Crea la estructura de carpetas del proyecto"""
        folders = [
            'lib/models',
            'lib/services',
            'lib/views',
            'lib/widgets',
        ]
        for folder in folders:
            (base_path / folder).mkdir(parents=True, exist_ok=True)
    
    def _generate_pubspec(self, base_path):
        """Genera el archivo pubspec.yaml"""
        content = """name: generated_crud_app
description: Aplicación Flutter generada automáticamente con CRUDs
publish_to: 'none'
version: 1.0.0+1

environment:
  sdk: '>=3.0.0 <4.0.0'

dependencies:
  flutter:
    sdk: flutter
  cupertino_icons: ^1.0.2
  http: ^1.1.0
  provider: ^6.0.5

dev_dependencies:
  flutter_test:
    sdk: flutter
  flutter_lints: ^2.0.0

flutter:
  uses-material-design: true
"""
        with open(base_path / 'pubspec.yaml', "w", encoding="utf-8") as f:
          f.write(self._sanitize(content))    
    def _generate_main(self, base_path, intermediate_entities=[]):
        """Genera el archivo main.dart"""
        # Imports para clases originales
        imports = [f"import 'views/{self._to_snake_case(c['name'])}_list_view.dart';" for c in self.classes]
        # Imports para entidades intermedias
        imports.extend([f"import 'views/{self._to_snake_case(ie['name'])}_list_view.dart';" for ie in intermediate_entities])
        imports_str = '\n'.join(imports)
        
        content = f"""import 'package:flutter/material.dart';
{imports_str}

void main() {{
  runApp(const MyApp());
}}

class MyApp extends StatelessWidget {{
  const MyApp({{super.key}});

  @override
  Widget build(BuildContext context) {{
    return MaterialApp(
      title: 'CRUD Generator',
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(seedColor: Colors.deepPurple),
        useMaterial3: true,
      ),
      home: const HomePage(),
    );
  }}
}}

class HomePage extends StatelessWidget {{
  const HomePage({{super.key}});

  @override
  Widget build(BuildContext context) {{
    return Scaffold(
      appBar: AppBar(
        title: const Text('Gestión de Clases'),
        backgroundColor: Theme.of(context).colorScheme.inversePrimary,
      ),
      body: ListView(
        padding: const EdgeInsets.all(16),
        children: [
{self._generate_home_cards(intermediate_entities)}
        ],
      ),
    );
  }}
}}
"""
        (base_path / 'lib' / 'main.dart').write_text(self._sanitize(content), encoding="utf-8", newline="\n")
    
    def _generate_home_cards(self, intermediate_entities=[]):
        """Genera las tarjetas de navegación en el home"""
        cards = []
        
        # Obtener nombres de entidades intermedias para excluirlas
        intermediate_names = {ie['name'] for ie in intermediate_entities}
        
        # Tarjetas para clases originales (excluyendo entidades intermedias)
        for clase in self.classes:
            # Saltar si es una entidad intermedia
            if clase.get('is_intermediate', False) or clase['name'] in intermediate_names:
                continue
            name = clase['name']
            snake_name = self._to_snake_case(name)
            cards.append(f"""          Card(
            margin: const EdgeInsets.only(bottom: 16),
            child: ListTile(
              leading: const Icon(Icons.table_chart, size: 40),
              title: Text('{name}'),
              subtitle: Text('Gestionar {name}'),
              trailing: const Icon(Icons.arrow_forward_ios),
              onTap: () {{
                Navigator.push(
                  context,
                  MaterialPageRoute(
                    builder: (context) => {name}ListView(),
                  ),
                );
              }},
            ),
          )""")
        
        # Tarjetas para entidades intermedias (relaciones)
        for ie in intermediate_entities:
            name = ie['name']
            snake_name = self._to_snake_case(name)
            cards.append(f"""          Card(
            margin: const EdgeInsets.only(bottom: 16),
            color: Colors.purple.shade50,
            child: ListTile(
              leading: const Icon(Icons.link, size: 40, color: Colors.purple),
              title: Text('{name}'),
              subtitle: Text('Gestionar relación {ie["first_entity"]} - {ie["second_entity"]}'),
              trailing: const Icon(Icons.arrow_forward_ios),
              onTap: () {{
                Navigator.push(
                  context,
                  MaterialPageRoute(
                    builder: (context) => {name}ListView(),
                  ),
                );
              }},
            ),
          )""")
        
        return ',\n'.join(cards)
    
    def _generate_config(self, base_path):
        """Genera el archivo de configuración para el API"""
        content = """class ApiConfig {
  // Cambia esta URL según tu backend
  static const String baseUrl = 'http://localhost:9000/api';
  
  // Para Android Emulator, usa: 'http://10.0.2.2:9000/api'
  // Para iOS Simulator, usa: 'http://localhost:9000/api'
  // Para dispositivo físico, usa la IP de tu computadora: 'http://192.168.x.x:9000/api'
}
"""
        (base_path / 'lib' / 'config.dart').write_text(content, encoding="utf-8", newline="\n")
    
    def _generate_model(self, base_path, clase):
      """Genera el modelo de datos, con imports y parsing de relaciones"""
      name = clase['name']
      relationships = self.parsed_relationships
      attributes = clase.get('attributes', [])

      # Detectar clase padre (herencia)
      parent_class = None
      for rel in relationships:
          if rel["from"] == name and rel["kind"] == "inherits":
              parent_class = rel["to"]
              break

      # IMPORTANTE: El primer atributo es la PK
      # Detectar tipo de PK (numérica o string)
      pk_attr = attributes[0] if attributes and not parent_class else None
      pk_type = None
      pk_name = None
      is_numeric_pk = False
      
      if pk_attr:
          pk_name = pk_attr['name']
          pk_type = self._convert_type(pk_attr['type'])
          is_numeric_pk = pk_type in ['int', 'double']

      # Detectar modelos relacionados para importar
      related_models = set()
      if parent_class:
          related_models.add(parent_class)
      
      # Importar modelos para todas las relaciones (necesarios para parsear objetos anidados)
      for rel in relationships:
          if rel["from"] == name and rel["kind"] in ["many_to_one", "one_to_one", "one_to_many"]:
              related_models.add(rel["to"])

      imports = "\n".join([
          f"import '{self._to_snake_case(model)}.dart';"
          for model in sorted(related_models)
      ])

      # Clase extends o normal
      class_declaration = f"class {name} extends {parent_class}" if parent_class else f"class {name}"

      # Propiedades (solo las propias, NO las heredadas)
      properties = []
      
      # Función recursiva para obtener TODOS los nombres de atributos del padre
      def get_all_parent_attribute_names(parent_class_name):
          parent_attr_names = set()
          parent = next((c for c in self.classes if c['name'] == parent_class_name), None)
          if parent:
              # Buscar si el padre también tiene padre
              for rel in relationships:
                  if rel["from"] == parent_class_name and rel["kind"] == "inherits":
                      # Recursivamente obtener atributos del abuelo
                      parent_attr_names.update(get_all_parent_attribute_names(rel["to"]))
              # Agregar atributos propios del padre
              for attr in parent.get('attributes', []):
                  parent_attr_names.add(attr['name'].lower())
          return parent_attr_names
      
      # Si NO tiene padre, agregar todos los atributos normalmente
      # Si SÍ tiene padre, NO agregar atributos que ya estén en el padre
      parent_attr_names = get_all_parent_attribute_names(parent_class) if parent_class else set()
      
      if not parent_class:
          # Sin herencia: agregar todos los atributos incluyendo PK
          for attr in attributes:
              dart_type = self._convert_type(attr['type'])
              properties.append(f"  final {dart_type} {attr['name']};")
      else:
          # Con herencia: NO agregar atributos que ya existen en el padre (recursivamente)
          for attr in attributes:
              # Comparar nombre del atributo con todos los atributos del padre
              if attr['name'].lower() not in parent_attr_names:
                  dart_type = self._convert_type(attr['type'])
                  properties.append(f"  final {dart_type} {attr['name']};")

      # Relaciones - ManyToOne/OneToOne: ID (required) + objeto completo (opcional para leer). OneToMany: lista completa
      # Normalizar nombres eliminando guiones bajos y convirtiendo a lowercase para comparación
      existing_attr_names = {attr['name'].lower().replace('_', '') for attr in attributes}
      rel_fields = []
      for rel in relationships:
          if rel["from"] == name:
              if rel["kind"] == "many_to_one":
                  # ManyToOne: ID (para enviar) + objeto completo opcional (para leer del GET)
                  field_name = f"{self._to_snake_case(rel['to'])}Id"
                  normalized_field = field_name.lower().replace('_', '')
                  if normalized_field not in existing_attr_names:
                      rel_fields.append(f"  final String {field_name};")
                  # Agregar también el objeto completo (nullable, solo para lectura)
                  obj_field_name = self._to_snake_case(rel['to'])
                  normalized_obj = obj_field_name.lower().replace('_', '')
                  if normalized_obj not in existing_attr_names:
                      rel_fields.append(f"  final {rel['to']}? {obj_field_name};")
              elif rel["kind"] == "one_to_one":
                  # OneToOne: ID (para enviar) + objeto completo opcional (para leer del GET)
                  field_name = f"{self._to_snake_case(rel['to'])}Id"
                  normalized_field = field_name.lower().replace('_', '')
                  if normalized_field not in existing_attr_names:
                      rel_fields.append(f"  final String {field_name};")
                  # Agregar también el objeto completo (nullable, solo para lectura)
                  obj_field_name = self._to_snake_case(rel['to'])
                  normalized_obj = obj_field_name.lower().replace('_', '')
                  if normalized_obj not in existing_attr_names:
                      rel_fields.append(f"  final {rel['to']}? {obj_field_name};")
              elif rel["kind"] == "one_to_many":
                  # OneToMany: Lista de objetos completos (solo para lectura desde GET)
                  # El backend devuelve la lista anidada en GET, pero NO se envía en POST/PUT
                  field_name = self._to_snake_case(rel['to'])
                  normalized_field = field_name.lower().replace('_', '')
                  if normalized_field not in existing_attr_names:
                      rel_fields.append(f"  final List<{rel['to']}> {field_name};")
      properties.extend(rel_fields)

      # Constructor con super() si hay herencia
      constructor_params_list = []
      super_params_list = []
      
      # Si tiene padre, necesitamos pasar sus parámetros al super()
      if parent_class:
          # Función recursiva para obtener TODOS los atributos del padre (incluyendo PK)
          def get_all_parent_attributes(class_name):
              attrs = []
              current_class = next((c for c in self.classes if c['name'] == class_name), None)
              if current_class:
                  # Buscar si esta clase también tiene padre
                  parent_rels = [r for r in relationships if r["from"] == class_name and r["kind"] == "inherits"]
                  if parent_rels:
                      parent_name = parent_rels[0]["to"]
                      attrs.extend(get_all_parent_attributes(parent_name))
                  # Agregar atributos propios del padre
                  attrs.extend(current_class.get('attributes', []))
              return attrs
          
          # Función para obtener relaciones del padre
          def get_all_parent_relationships(class_name):
              rels = []
              # Buscar si esta clase tiene padre primero
              parent_rels = [r for r in relationships if r["from"] == class_name and r["kind"] == "inherits"]
              if parent_rels:
                  # Recursivamente obtener relaciones del abuelo
                  rels.extend(get_all_parent_relationships(parent_rels[0]["to"]))
              
              # Agregar relaciones propias de esta clase (excepto herencia)
              for rel in relationships:
                  if rel["from"] == class_name and rel["kind"] != "inherits":
                      rels.append(rel)
              return rels
          
          # Obtener TODOS los atributos del padre (recursivamente)
          parent_attrs = get_all_parent_attributes(parent_class)
          parent_relationships = get_all_parent_relationships(parent_class)
          
          # Agregar parámetros del padre para el super()
          for attr in parent_attrs:
              attr_name = attr['name']
              attr_type = self._convert_type(attr['type'])
              super_params_list.append(f"{attr_name}: {attr_name}")
              constructor_params_list.append(f"required {attr_type} {attr_name}")
          
          # Agregar relaciones del padre al constructor (SOLO IDs)
          parent_existing_attrs = {attr['name'].lower().replace('_', '') for attr in parent_attrs}
          for rel in parent_relationships:
              if rel["kind"] == "many_to_one":
                  # ManyToOne: agregar el ID
                  field_name = f"{self._to_snake_case(rel['to'])}Id"
                  normalized = field_name.lower().replace('_', '')
                  if normalized not in parent_existing_attrs:
                      super_params_list.append(f"{field_name}: {field_name}")
                      constructor_params_list.append(f"required String {field_name}")
              elif rel["kind"] == "one_to_one":
                  # OneToOne: agregar el ID
                  field_name = f"{self._to_snake_case(rel['to'])}Id"
                  normalized = field_name.lower().replace('_', '')
                  if normalized not in parent_existing_attrs:
                      super_params_list.append(f"{field_name}: {field_name}")
                      constructor_params_list.append(f"required String {field_name}")
              # OneToMany: NO se agrega al constructor
      else:
          # Si no tiene padre, los atributos se agregan abajo con this.
          pass
      
      # Agregar parámetros propios (con this. si no hay padre, sin this. si hay padre)
      # Si hay herencia, NO agregar atributos que ya estén en el padre
      for attr in attributes:
          # Verificar si este atributo NO está en el padre
          if parent_class and attr['name'].lower() in parent_attr_names:
              continue  # Saltar atributos heredados
          constructor_params_list.append(f"required this.{attr['name']}")
      
      # Normalizar para comparación
      existing_attr_names_normalized = {attr['name'].lower().replace('_', '') for attr in attributes}
      
      for rel in relationships:
          if rel["from"] == name:
              if rel["kind"] == "many_to_one":
                  # Agregar FK (ID) para relaciones ManyToOne (required)
                  field_name = f"{self._to_snake_case(rel['to'])}Id"
                  normalized_field = field_name.lower().replace('_', '')
                  if normalized_field not in existing_attr_names_normalized:
                      constructor_params_list.append(f"required this.{field_name}")
                  # Agregar objeto completo (opcional, default null)
                  obj_field_name = self._to_snake_case(rel['to'])
                  normalized_obj = obj_field_name.lower().replace('_', '')
                  if normalized_obj not in existing_attr_names_normalized:
                      constructor_params_list.append(f"this.{obj_field_name}")
              elif rel["kind"] == "one_to_one":
                  # Agregar FK (ID) para relaciones OneToOne (required)
                  field_name = f"{self._to_snake_case(rel['to'])}Id"
                  normalized_field = field_name.lower().replace('_', '')
                  if normalized_field not in existing_attr_names_normalized:
                      constructor_params_list.append(f"required this.{field_name}")
                  # Agregar objeto completo (opcional, default null)
                  obj_field_name = self._to_snake_case(rel['to'])
                  normalized_obj = obj_field_name.lower().replace('_', '')
                  if normalized_obj not in existing_attr_names_normalized:
                      constructor_params_list.append(f"this.{obj_field_name}")
              elif rel["kind"] == "one_to_many":
                  # OneToMany: Lista opcional (vacía por defecto para POST/PUT, poblada en GET)
                  field_name = self._to_snake_case(rel['to'])
                  normalized_field = field_name.lower().replace('_', '')
                  if normalized_field not in existing_attr_names_normalized:
                      constructor_params_list.append(f"this.{field_name} = const []")
      constructor_params = ", ".join(constructor_params_list)
      
      # Generar llamada al super() si hay herencia
      super_call = ""
      if parent_class and super_params_list:
          super_call = f" : super({', '.join(super_params_list)})"

      # fromJson
      from_json_fields = []
      
      # Si tiene padre, incluir TODOS los atributos heredados (incluyendo PK)
      if parent_class:
          # Función recursiva para obtener todos los atributos del padre
          def get_all_parent_attributes_for_json(class_name):
              attrs = []
              current_class = next((c for c in self.classes if c['name'] == class_name), None)
              if current_class:
                  # Buscar si esta clase también tiene padre
                  parent_rels = [r for r in relationships if r["from"] == class_name and r["kind"] == "inherits"]
                  if parent_rels:
                      parent_name = parent_rels[0]["to"]
                      attrs.extend(get_all_parent_attributes_for_json(parent_name))
                  # Agregar atributos propios del padre
                  attrs.extend(current_class.get('attributes', []))
              return attrs
          
          # Función para obtener relaciones del padre (recursiva)
          def get_all_parent_relationships_for_json(class_name):
              rels = []
              parent_rels = [r for r in relationships if r["from"] == class_name and r["kind"] == "inherits"]
              if parent_rels:
                  rels.extend(get_all_parent_relationships_for_json(parent_rels[0]["to"]))
              for rel in relationships:
                  if rel["from"] == class_name and rel["kind"] != "inherits":
                      rels.append(rel)
              return rels
          
          parent_attrs = get_all_parent_attributes_for_json(parent_class)
          parent_rels = get_all_parent_relationships_for_json(parent_class)
          
          # Agregar todos los atributos heredados al fromJson
          for attr in parent_attrs:
              attr_type = self._convert_type(attr['type'])
              json_key = self._to_backend_json_key(attr['name'])
              if attr_type == 'int':
                  from_json_fields.append(f"{attr['name']}: json['{json_key}'] is int ? json['{json_key}'] : int.tryParse(json['{json_key}']?.toString() ?? '0') ?? 0")
              elif attr_type == 'double':
                  from_json_fields.append(f"{attr['name']}: json['{json_key}'] is double ? json['{json_key}'] : double.tryParse(json['{json_key}']?.toString() ?? '0.0') ?? 0.0")
              elif attr_type == 'String':
                  from_json_fields.append(f"{attr['name']}: json['{json_key}']?.toString() ?? ''")
              elif attr_type == 'bool':
                  from_json_fields.append(f"{attr['name']}: json['{json_key}'] == true")
              else:
                  from_json_fields.append(f"{attr['name']}: json['{json_key}']")
          
          # Agregar relaciones heredadas del padre (SOLO IDs)
          parent_existing_attrs = {attr['name'].lower().replace('_', '') for attr in parent_attrs}
          for rel in parent_rels:
              rel_name = self._to_snake_case(rel['to'])
              normalized = rel_name.lower().replace('_', '')
              if normalized not in parent_existing_attrs:
                  if rel["kind"] == "many_to_one":
                      # Parsear solo el ID
                      field_name = f"{rel_name}Id"
                      fk_json_key = self._to_backend_json_key(field_name)
                      from_json_fields.append(f"{field_name}: json['{fk_json_key}']?.toString() ?? ''")
                  elif rel["kind"] == "one_to_one":
                      # Parsear solo el ID
                      field_name = f"{rel_name}Id"
                      fk_json_key = self._to_backend_json_key(field_name)
                      from_json_fields.append(f"{field_name}: json['{fk_json_key}']?.toString() ?? ''")
                  # OneToMany NO se parsea en fromJson
      
      # Agregar campos propios (evitando duplicar atributos heredados)
      for attr in attributes:
          # Si hay herencia, saltar atributos que ya estén en el padre
          if parent_class and attr['name'].lower() in parent_attr_names:
              continue  # Ya fue agregado por el padre
          
          attr_type = self._convert_type(attr['type'])
          json_key = self._to_backend_json_key(attr['name'])
          if attr_type == 'int':
              from_json_fields.append(f"{attr['name']}: json['{json_key}'] is int ? json['{json_key}'] : int.tryParse(json['{json_key}']?.toString() ?? '0') ?? 0")
          elif attr_type == 'double':
              from_json_fields.append(f"{attr['name']}: json['{json_key}'] is double ? json['{json_key}'] : double.tryParse(json['{json_key}']?.toString() ?? '0.0') ?? 0.0")
          elif attr_type == 'String':
              from_json_fields.append(f"{attr['name']}: json['{json_key}']?.toString() ?? ''")
          elif attr_type == 'bool':
              from_json_fields.append(f"{attr['name']}: json['{json_key}'] == true")
          else:
              from_json_fields.append(f"{attr['name']}: json['{json_key}']")

      # Agregar relaciones - parsear IDs, objetos anidados y listas
      for rel in relationships:
          if rel["from"] == name:
              rel_name = self._to_snake_case(rel['to'])
              if rel["kind"] == "many_to_one":
                  # Parsear el ID de la relación ManyToOne
                  # Puede venir como campo separado 'personaid' o dentro del objeto 'persona.id'
                  field_name = f"{rel_name}Id"
                  fk_json_key = self._to_backend_json_key(field_name)
                  json_key = self._to_backend_json_key(rel_name)
                  
                  # Intentar obtener el ID de múltiples fuentes: campo directo, objeto.id, o conversión de int
                  id_parsing = f"{field_name}: json['{fk_json_key}'] != null ? json['{fk_json_key}'].toString() : (json['{json_key}'] is Map ? json['{json_key}']['id']?.toString() : json['{json_key}']?.toString()) ?? ''"
                  from_json_fields.append(id_parsing)
                  
                  # Parsear también el objeto completo si viene anidado en el JSON (validar que sea Map)
                  from_json_fields.append(f"{rel_name}: json['{json_key}'] is Map<String, dynamic> ? {rel['to']}.fromJson(json['{json_key}']) : null")
              elif rel["kind"] == "one_to_one":
                  # Parsear el ID de la relación OneToOne
                  # Puede venir como campo separado o dentro del objeto
                  field_name = f"{rel_name}Id"
                  fk_json_key = self._to_backend_json_key(field_name)
                  json_key = self._to_backend_json_key(rel_name)
                  
                  # Intentar obtener el ID de múltiples fuentes
                  id_parsing = f"{field_name}: json['{fk_json_key}'] != null ? json['{fk_json_key}'].toString() : (json['{json_key}'] is Map ? json['{json_key}']['id']?.toString() : json['{json_key}']?.toString()) ?? ''"
                  from_json_fields.append(id_parsing)
                  
                  # Parsear también el objeto completo si viene anidado en el JSON (validar que sea Map)
                  from_json_fields.append(f"{rel_name}: json['{json_key}'] is Map<String, dynamic> ? {rel['to']}.fromJson(json['{json_key}']) : null")
              elif rel["kind"] == "one_to_many":
                  # OneToMany: Parsear lista de objetos anidados que vienen en GET
                  # El backend puede devolver listas mixtas [objeto, id, objeto] debido a @JsonIdentityInfo
                  # Filtrar solo los objetos completos (Maps), omitir los IDs sueltos
                  json_key = self._to_backend_json_key(rel_name)
                  parse_logic = f"""json['{json_key}'] is List 
          ? (json['{json_key}'] as List)
              .whereType<Map<String, dynamic>>()
              .map((e) => {rel['to']}.fromJson(e))
              .toList()
          : []"""
                  from_json_fields.append(f"{rel_name}: {parse_logic}")

      # toJson - incluir campos heredados también
      to_json_fields = []
      
      # Si tiene padre, incluir todos los campos heredados (incluyendo PK)
      if parent_class:
          # Función recursiva para obtener todos los atributos del padre
          def get_all_parent_attributes_for_tojson(class_name):
              attrs = []
              current_class = next((c for c in self.classes if c['name'] == class_name), None)
              if current_class:
                  # Buscar si esta clase también tiene padre
                  parent_rels = [r for r in relationships if r["from"] == class_name and r["kind"] == "inherits"]
                  if parent_rels:
                      parent_name = parent_rels[0]["to"]
                      attrs.extend(get_all_parent_attributes_for_tojson(parent_name))
                  # Agregar atributos propios del padre
                  attrs.extend(current_class.get('attributes', []))
              return attrs
          
          # Función para obtener relaciones del padre (recursiva)
          def get_all_parent_relationships_for_tojson(class_name):
              rels = []
              parent_rels = [r for r in relationships if r["from"] == class_name and r["kind"] == "inherits"]
              if parent_rels:
                  rels.extend(get_all_parent_relationships_for_tojson(parent_rels[0]["to"]))
              for rel in relationships:
                  if rel["from"] == class_name and rel["kind"] != "inherits":
                      rels.append(rel)
              return rels
          
          parent_attrs = get_all_parent_attributes_for_tojson(parent_class)
          parent_rels = get_all_parent_relationships_for_tojson(parent_class)
          
          # Agregar todos los atributos heredados al toJson
          for attr in parent_attrs:
              json_key = self._to_backend_json_key(attr['name'])
              to_json_fields.append(f"'{json_key}': {attr['name']}")
          
          # Agregar relaciones heredadas del padre (SOLO IDs)
          parent_existing_attrs = {attr['name'].lower().replace('_', '') for attr in parent_attrs}
          for rel in parent_rels:
              rel_name = self._to_snake_case(rel['to'])
              normalized = rel_name.lower().replace('_', '')
              if normalized not in parent_existing_attrs:
                  if rel["kind"] == "many_to_one":
                      # Enviar solo el ID
                      field_name = f"{rel_name}Id"
                      fk_json_key = self._to_backend_json_key(field_name)
                      to_json_fields.append(f"'{fk_json_key}': {field_name}")
                  elif rel["kind"] == "one_to_one":
                      # Enviar solo el ID
                      field_name = f"{rel_name}Id"
                      fk_json_key = self._to_backend_json_key(field_name)
                      to_json_fields.append(f"'{fk_json_key}': {field_name}")
                  # OneToMany NO se envía en toJson
      
      # Agregar campos propios (evitando duplicar atributos heredados)
      for attr in attributes:
          # Si hay herencia, saltar atributos que ya estén en el padre
          if parent_class and attr['name'].lower() in parent_attr_names:
              continue  # Ya fue agregado por el padre
          
          json_key = self._to_backend_json_key(attr['name'])
          to_json_fields.append(f"'{json_key}': {attr['name']}")
      
      # Agregar relaciones - ENVIAR SOLO IDs, NO objetos completos
      for rel in relationships:
          if rel["from"] == name:
              rel_name = self._to_snake_case(rel['to'])
              if rel["kind"] == "many_to_one":
                  # Para ManyToOne: enviar solo el ID (formato: personaId)
                  field_name = f"{rel_name}Id"
                  fk_json_key = self._to_backend_json_key(field_name)
                  to_json_fields.append(f"'{fk_json_key}': {field_name}")
              elif rel["kind"] == "one_to_one":
                  # Para OneToOne: enviar solo el ID (formato: relacionId)
                  field_name = f"{rel_name}Id"
                  fk_json_key = self._to_backend_json_key(field_name)
                  to_json_fields.append(f"'{fk_json_key}': {field_name}")
              elif rel["kind"] == "one_to_many":
                  # OneToMany NO se envía en el formulario (se gestiona desde el lado "many")
                  pass

      # Generar el constructor - no se necesitan parámetros extra para PK
      # La PK se maneja como el primer atributo
      id_param = ""
      
      # fromJson - no se necesita manejo especial, la PK viene en los atributos
      id_from_json = ""

      # toJson - no se necesita manejo especial, la PK está en los atributos  
      id_to_json = ""

      # Generar método toString() con los 2 primeros atributos significativos (sin id)
      display_attrs = [attr for attr in attributes if attr['name'].lower() != 'id'][:2]
      if display_attrs:
          to_string_parts = [f"'{attr['name']}: ${{{attr['name']}}}'" for attr in display_attrs]
          to_string_body = ' + ", " + '.join(to_string_parts)
      else:
          # Si no hay atributos además del id, usar el id o pk_name
          if pk_name:
              to_string_body = f"'ID: ${{{pk_name}}}'"
          else:
              to_string_body = f"'ID: ${{id}}'"

      content = f"""{imports}

  {class_declaration} {{
  {chr(10).join(properties)}

    {name}({{
      {id_param}
      {constructor_params},
    }}){super_call};

    factory {name}.fromJson(Map<String, dynamic> json) {{
      return {name}(
        {id_from_json}
        {', '.join(from_json_fields)},
      );
    }}

    Map<String, dynamic> toJson() {{
      return {{
        {id_to_json}
        {', '.join(to_json_fields)},
      }};
    }}

    @override
    String toString() {{
      return {to_string_body};
    }}
  }}
  """
      file_path = base_path / 'lib' / 'models' / f'{self._to_snake_case(name)}.dart'
      file_path.write_text(self._sanitize(content), encoding="utf-8", newline="\n")


    
    def _generate_service(self, base_path, clase):
        """Genera el servicio para operaciones CRUD, con relaciones anidadas"""
        name = clase['name']
        snake_name = self._to_snake_case(name)
        # Convertir nombre de clase al formato del backend para URLs
        backend_url_name = self._to_backend_json_key(name)
        relationships = [r for r in self.parsed_relationships if r["from"] == name]
        attributes = clase.get('attributes', [])

        # Detectar herencia y obtener todos los atributos (propios + heredados)
        parent_class = None
        for rel in relationships:
            if rel["kind"] == "inherits":
                parent_class = rel["to"]
                break
        
        # Función recursiva para obtener todos los atributos heredados
        def get_all_attributes(class_name):
            attrs = []
            current_class = next((c for c in self.classes if c['name'] == class_name), None)
            if current_class:
                # Primero obtener atributos del padre (si existe)
                parent_rels = [r for r in self.parsed_relationships if r["from"] == class_name and r["kind"] == "inherits"]
                if parent_rels:
                    parent_name = parent_rels[0]["to"]
                    attrs.extend(get_all_attributes(parent_name))
                
                # Luego agregar atributos propios (solo si no existen ya en attrs)
                existing_attr_names = {attr['name'].lower() for attr in attrs}
                for attr in current_class.get('attributes', []):
                    if attr['name'].lower() not in existing_attr_names:
                        attrs.append(attr)
            return attrs
        
        all_attributes = get_all_attributes(name)

        # Verificar si la clase tiene un atributo 'id' definido
        has_id = any(attr['name'].lower() == 'id' for attr in all_attributes)

        # Importar modelos relacionados
        related_models = [
            rel["to"] for rel in relationships if rel["kind"] in ["one_to_one", "one_to_many"]
        ]
        imports = "\n".join([
            f"import '../models/{self._to_snake_case(model)}.dart';"
            for model in related_models
        ])

        content = f"""{imports}
import 'dart:convert';
import 'package:http/http.dart' as http;
import '../models/{snake_name}.dart';
import '../config.dart';

class {name}Service {{
  static const String baseUrl = ApiConfig.baseUrl;
  
  Future<List<{name}>> getAll() async {{
    try {{
      final response = await http.get(
        Uri.parse('$baseUrl/{backend_url_name}'),
        headers: {{'Content-Type': 'application/json'}},
      );

      if (response.statusCode == 200) {{
        final List<dynamic> jsonList = json.decode(response.body);
        // El backend puede devolver listas mixtas [objeto, id] debido a @JsonIdentityInfo
        // Filtrar solo los objetos completos (Maps), omitir los IDs sueltos
        return jsonList
            .whereType<Map<String, dynamic>>()
            .map((item) => {name}.fromJson(item))
            .toList();
      }} else {{
        throw Exception('Error al cargar {name}s: ${{response.statusCode}}');
      }}
    }} catch (e) {{
      throw Exception('Error de conexión: $e');
    }}
  }}

  Future<{name}?> getById(String id) async {{
    try {{
      final response = await http.get(
        Uri.parse('$baseUrl/{backend_url_name}/$id'),
        headers: {{'Content-Type': 'application/json'}},
      );

      if (response.statusCode == 200) {{
        return {name}.fromJson(json.decode(response.body));
      }} else if (response.statusCode == 404) {{
        return null;
      }} else {{
        throw Exception('Error al obtener {name}: ${{response.statusCode}}');
      }}
    }} catch (e) {{
      throw Exception('Error de conexión: $e');
    }}
  }}

  Future<{name}> create({name} item) async {{
    try {{
      final response = await http.post(
        Uri.parse('$baseUrl/{backend_url_name}'),
        headers: {{'Content-Type': 'application/json'}},
        body: json.encode(item.toJson()),
      );

      if (response.statusCode == 201 || response.statusCode == 200) {{
        return {name}.fromJson(json.decode(response.body));
      }} else {{
        throw Exception('Error al crear {name}: ${{response.statusCode}} - ${{response.body}}');
      }}
    }} catch (e) {{
      throw Exception('Error de conexión: $e');
    }}
  }}

  Future<{name}> update(String id, {name} item) async {{
    try {{
      final response = await http.put(
        Uri.parse('$baseUrl/{backend_url_name}/$id'),
        headers: {{'Content-Type': 'application/json'}},
        body: json.encode(item.toJson()),
      );

      if (response.statusCode == 200) {{
        return {name}.fromJson(json.decode(response.body));
      }} else {{
        throw Exception('Error al actualizar {name}: ${{response.statusCode}} - ${{response.body}}');
      }}
    }} catch (e) {{
      throw Exception('Error de conexión: $e');
    }}
  }}

  Future<void> delete(String id) async {{
    try {{
      final response = await http.delete(
        Uri.parse('$baseUrl/{backend_url_name}/$id'),
        headers: {{'Content-Type': 'application/json'}},
      );

      if (response.statusCode != 204 && response.statusCode != 200) {{
        throw Exception('Error al eliminar {name}: ${{response.statusCode}}');
      }}
    }} catch (e) {{
      throw Exception('Error de conexión: $e');
    }}
  }}
}}
"""
        file_path = base_path / 'lib' / 'services' / f'{snake_name}_service.dart'
        file_path.write_text(self._sanitize(content), encoding="utf-8", newline="\n")

    
    def _generate_list_view(self, base_path, clase):
        """Genera la vista de listado"""
        name = clase['name']
        snake_name = self._to_snake_case(name)
        relationships = [r for r in self.parsed_relationships if r["from"] == name]
        attributes = clase.get('attributes', [])
        
        # Detectar herencia para obtener todos los atributos
        parent_class = None
        for rel in relationships:
            if rel["kind"] == "inherits":
                parent_class = rel["to"]
                break
        
        # Función recursiva para obtener todos los atributos heredados
        def get_all_attributes(class_name):
            attrs = []
            current_class = next((c for c in self.classes if c['name'] == class_name), None)
            if current_class:
                parent_rels = [r for r in self.parsed_relationships if r["from"] == class_name and r["kind"] == "inherits"]
                if parent_rels:
                    parent_name = parent_rels[0]["to"]
                    attrs.extend(get_all_attributes(parent_name))
                
                # Luego agregar atributos propios (solo si no existen ya en attrs)
                existing_attr_names = {attr['name'].lower() for attr in attrs}
                for attr in current_class.get('attributes', []):
                    if attr['name'].lower() not in existing_attr_names:
                        attrs.append(attr)
            return attrs
        
        all_attributes = get_all_attributes(name)
        
        # El primer atributo es la PK
        pk_attr = all_attributes[0] if all_attributes else None
        pk_name = pk_attr['name'] if pk_attr else 'id'
        
        # Segundo atributo para mostrar en la lista (o el primero si solo hay uno)
        display_attr = all_attributes[1]['name'] if len(all_attributes) > 1 else pk_name
        
        content = f"""import 'package:flutter/material.dart';
import '../models/{snake_name}.dart';
import '../services/{snake_name}_service.dart';
import '{snake_name}_form_view.dart';
import '{snake_name}_detail_view.dart';

class {name}ListView extends StatefulWidget {{
  const {name}ListView({{super.key}});

  @override
  State<{name}ListView> createState() => _{name}ListViewState();
}}

class _{name}ListViewState extends State<{name}ListView> {{
  final {name}Service _service = {name}Service();
  List<{name}> _items = [];
  bool _isLoading = true;

  @override
  void initState() {{
    super.initState();
    _loadItems();
  }}

  Future<void> _loadItems() async {{
    setState(() => _isLoading = true);
    try {{
      final items = await _service.getAll();
      setState(() {{
        _items = items;
        _isLoading = false;
      }});
    }} catch (e) {{
      setState(() => _isLoading = false);
      if (mounted) {{
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Error al cargar: $e')),
        );
      }}
    }}
  }}

  Future<void> _deleteItem(String id) async {{
    try {{
      await _service.delete(id);
      _loadItems();
      if (mounted) {{
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Eliminado exitosamente')),
        );
      }}
    }} catch (e) {{
      if (mounted) {{
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Error al eliminar: $e')),
        );
      }}
    }}
  }}

  @override
  Widget build(BuildContext context) {{
    return Scaffold(
      appBar: AppBar(
        title: const Text('{name}'),
        backgroundColor: Theme.of(context).colorScheme.inversePrimary,
      ),
      body: _isLoading
          ? const Center(child: CircularProgressIndicator())
          : _items.isEmpty
              ? const Center(
                  child: Text('No hay registros. ¡Crea uno nuevo!'),
                )
              : ListView.builder(
                  itemCount: _items.length,
                  itemBuilder: (context, index) {{
                    final item = _items[index];
                    return Card(
                      margin: const EdgeInsets.symmetric(
                        horizontal: 16,
                        vertical: 8,
                      ),
                      child: ListTile(
                        title: Text(item.{display_attr}.toString()),
                        subtitle: Text('{pk_name}: ${{item.{pk_name}}}'),
                        trailing: Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            IconButton(
                              icon: const Icon(Icons.edit),
                              onPressed: () async {{
                                await Navigator.push(
                                  context,
                                  MaterialPageRoute(
                                    builder: (context) => {name}FormView(
                                      item: item,
                                    ),
                                  ),
                                );
                                _loadItems();
                              }},
                            ),
                            IconButton(
                              icon: const Icon(Icons.delete),
                              color: Colors.red,
                              onPressed: () {{
                                showDialog(
                                  context: context,
                                  builder: (context) => AlertDialog(
                                    title: const Text('Confirmar'),
                                    content: const Text(
                                      '¿Deseas eliminar este registro?',
                                    ),
                                    actions: [
                                      TextButton(
                                        onPressed: () => Navigator.pop(context),
                                        child: const Text('Cancelar'),
                                      ),
                                      TextButton(
                                        onPressed: () {{
                                          Navigator.pop(context);
                                          _deleteItem(item.{pk_name}.toString());
                                        }},
                                        child: const Text('Eliminar'),
                                      ),
                                    ],
                                  ),
                                );
                              }},
                            ),
                          ],
                        ),
                        onTap: () {{
                          Navigator.push(
                            context,
                            MaterialPageRoute(
                              builder: (context) => {name}DetailView(item: item),
                            ),
                          );
                        }},
                      ),
                    );
                  }},
                ),
      floatingActionButton: FloatingActionButton(
        onPressed: () async {{
          await Navigator.push(
            context,
            MaterialPageRoute(
              builder: (context) => const {name}FormView(),
            ),
          );
          _loadItems();
        }},
        child: const Icon(Icons.add),
      ),
    );
  }}
}}
"""
        file_path = base_path / 'lib' / 'views' / f'{snake_name}_list_view.dart'
        file_path.write_text(content, encoding="utf-8", newline="\n")
    
    def _generate_form_view(self, base_path, clase):
        """Genera la vista de formulario (crear/editar)"""
        name = clase['name']
        snake_name = self._to_snake_case(name)
        relationships = [r for r in self.parsed_relationships if r["from"] == name]
        attributes = clase.get('attributes', [])
        
        # Detectar herencia y obtener todos los atributos (propios + heredados)
        all_attributes = []
        parent_class = None
        for rel in relationships:
            if rel["kind"] == "inherits":
                parent_class = rel["to"]
                break
        
        # Función recursiva para obtener todos los atributos heredados
        def get_all_attributes(class_name):
            attrs = []
            current_class = next((c for c in self.classes if c['name'] == class_name), None)
            if current_class:
                # Primero obtener atributos del padre (si existe)
                parent_rels = [r for r in self.parsed_relationships if r["from"] == class_name and r["kind"] == "inherits"]
                if parent_rels:
                    parent_name = parent_rels[0]["to"]
                    attrs.extend(get_all_attributes(parent_name))
                
                # Luego agregar atributos propios (solo si no existen ya en attrs)
                existing_attr_names = {attr['name'].lower() for attr in attrs}
                for attr in current_class.get('attributes', []):
                    if attr['name'].lower() not in existing_attr_names:
                        attrs.append(attr)
            return attrs
        
        all_attributes = get_all_attributes(name)
        
        # Detectar tipo de PK (primer atributo si no hay herencia)
        pk_attr = all_attributes[0] if all_attributes else None
        pk_type = self._convert_type(pk_attr['type']) if pk_attr else 'String'
        is_numeric_pk = pk_type in ['int', 'double'] if pk_attr else False
        pk_name = pk_attr['name'] if pk_attr else 'id'
        
        # Verificar si la clase tiene un atributo 'id' definido
        has_id = any(attr['name'].lower() == 'id' for attr in all_attributes)
        
        # Normalizar para comparación (declarar temprano para uso posterior)
        existing_attr_names_normalized = {attr['name'].lower().replace('_', '') for attr in all_attributes}
        
        # Generar controladores
        # - Para PK numérica (autoincremental): NO generar controlador (solo en edición, readonly)
        # - Para PK string: SÍ generar controlador (se debe ingresar manualmente)
        # - Los atributos heredados SÍ necesitan controladores para poder editarlos
        controllers_list = []
        for i, attr in enumerate(all_attributes):
            # Si es la PK (primer atributo) y es numérica, no generar controlador para creación
            if i == 0 and is_numeric_pk:
                # Solo se mostrará readonly en edición
                continue
            # Para todos los demás atributos (propios y heredados), generar controlador
            controllers_list.append(f"final TextEditingController _{attr['name']}Controller = TextEditingController();")
        
        # Agregar variables para relaciones many_to_one y one_to_one (propias y heredadas)
        # Rastrear qué relaciones ya se agregaron para evitar duplicados
        added_relations = set()
        
        # Función para obtener todas las relaciones (propias y del padre)
        def get_all_relations_for_state(class_name):
            rels = []
            # Buscar padre
            for r in self.parsed_relationships:
                if r["from"] == class_name and r["kind"] == "inherits":
                    # Recursivamente obtener relaciones del padre
                    rels.extend(get_all_relations_for_state(r["to"]))
                    break
            # Agregar relaciones propias (ManyToOne y OneToOne)
            for r in self.parsed_relationships:
                if r["from"] == class_name and r["kind"] in ["many_to_one", "one_to_one"]:
                    rels.append(r)
            return rels
        
        all_relations = get_all_relations_for_state(name)
        for rel in all_relations:
            rel_key = f"{rel['to']}"
            if rel_key not in added_relations:
                controllers_list.append(f"String? _selected{rel['to']}Id;")
                added_relations.add(rel_key)
        
        # Relaciones one_to_many NO necesitan variables de estado en el formulario
        # porque NO se editan desde este lado (se gestionan desde el lado "many")
        
        controllers = '\n  '.join(controllers_list)
        
        # Inicializar controladores si es edición - incluir campos heredados
        init_controllers_list = []
        for i, attr in enumerate(all_attributes):
            # Si es PK numérica, no hay controlador para inicializar (solo lectura)
            if i == 0 and is_numeric_pk:
                continue
            # Inicializar todos los controladores (propios y heredados)
            init_controllers_list.append(f"_{attr['name']}Controller.text = widget.item!.{attr['name']}.toString();")
        
        # Inicializar relaciones many_to_one y one_to_one (propias y heredadas)
        # Usar las mismas relaciones que ya obtuvimos antes
        initialized_relations = set()
        for rel in all_relations:
            rel_key = f"{rel['to']}"
            if rel_key not in initialized_relations:
                field_name = f"{self._to_snake_case(rel['to'])}Id"
                # Convertir a String y manejar valores vacíos para evitar que sea ""
                # El dropdown espera null o un valor válido que exista en la lista
                init_controllers_list.append(f"if (widget.item!.{field_name}.isNotEmpty) {{ _selected{rel['to']}Id = widget.item!.{field_name}; }}")
                initialized_relations.add(rel_key)
        
        # Relaciones one_to_many NO se inicializan en el formulario
        # porque NO se editan desde este lado (solo lectura en vista de detalle)
        
        init_controllers = '\n      '.join(init_controllers_list)
        
        # Generar campos del formulario
        form_fields = []
        for i, attr in enumerate(all_attributes):
            dart_type = self._convert_type(attr['type'])
            keyboard_type = 'TextInputType.number' if dart_type in ['int', 'double'] else 'TextInputType.text'
            
            # Si es PK numérica y estamos EDITANDO, mostrar campo readonly
            if i == 0 and is_numeric_pk:
                form_fields.append(f"""            if (widget.item != null)
              TextFormField(
                initialValue: widget.item!.{attr['name']}.toString(),
                decoration: const InputDecoration(
                  labelText: '{attr['name']} (Auto)',
                  border: OutlineInputBorder(),
                ),
                enabled: false,
              )""")
                continue
            
            # Para todos los demás atributos (propios y heredados), crear campo editable
            form_fields.append(f"""            TextFormField(
              controller: _{attr['name']}Controller,
              decoration: const InputDecoration(
                labelText: '{attr['name']}',
                border: OutlineInputBorder(),
              ),
              keyboardType: {keyboard_type},
              validator: (value) {{
                if (value == null || value.isEmpty) {{
                  return 'Este campo es requerido';
                }}
                return null;
              }},
            )""")
        
        # Relaciones ManyToOne → Dropdown (sin coma al final)
        for rel in relationships:
            if rel["kind"] == "many_to_one":
                # Obtener la PK y display attr de la clase relacionada
                related_class = next((c for c in self.classes if c['name'] == rel['to']), None)
                
                # Función para obtener la PK de una clase (considerando herencia)
                def get_related_pk(class_name):
                    current = next((c for c in self.classes if c['name'] == class_name), None)
                    if current:
                        parent_rels = [r for r in self.parsed_relationships if r["from"] == class_name and r["kind"] == "inherits"]
                        if parent_rels:
                            return get_related_pk(parent_rels[0]["to"])
                        attrs = current.get('attributes', [])
                        if attrs:
                            return attrs[0]['name']
                    return 'id'
                
                related_pk = get_related_pk(rel['to'])
                display_attr = related_pk
                
                if related_class:
                    attrs = related_class.get('attributes', [])
                    # Buscar el primer atributo que no sea la PK para mostrar
                    for attr in attrs:
                        if attr['name'] != related_pk:
                            display_attr = attr['name']
                            break
                
                form_fields.append(f"""FutureBuilder<List<{rel['to']}>>(
              future: {rel['to']}Service().getAll(),
              builder: (context, snapshot) {{
                if (!snapshot.hasData) return const CircularProgressIndicator();
                final items = snapshot.data!;
                // Eliminar duplicados por ID si existen
                final uniqueItems = {{
                  for (var item in items) item.{related_pk}.toString(): item
                }}.values.toList();
                // Verificar que el valor seleccionado exista en la lista
                final validValue = _selected{rel['to']}Id != null && 
                    uniqueItems.any((e) => e.{related_pk}.toString() == _selected{rel['to']}Id)
                    ? _selected{rel['to']}Id
                    : null;
                return DropdownButtonFormField<String>(
                  decoration: const InputDecoration(labelText: '{rel['to']}'),
                  value: validValue,
                  items: uniqueItems.map((e) => DropdownMenuItem(
                    value: e.{related_pk}.toString(),
                    child: Text(e.{display_attr}.toString()),
                  )).toList(),
                  onChanged: (v) {{
                    setState(() {{
                      _selected{rel['to']}Id = v;
                    }});
                  }},
                  validator: (value) {{
                    if (value == null || value.isEmpty) {{
                      return 'Este campo es requerido';
                    }}
                    return null;
                  }},
                );
              }},
            )""")
        
        # Relaciones OneToOne → Dropdown
        for rel in relationships:
            if rel["kind"] == "one_to_one":
                field_name = self._to_snake_case(rel['to'])
                normalized_field = field_name.lower().replace('_', '')
                if normalized_field not in existing_attr_names_normalized:
                    # Obtener la PK y display attr de la clase relacionada
                    related_class = next((c for c in self.classes if c['name'] == rel['to']), None)
                    
                    # Función para obtener la PK de una clase (considerando herencia)
                    def get_related_pk_one(class_name):
                        current = next((c for c in self.classes if c['name'] == class_name), None)
                        if current:
                            parent_rels = [r for r in self.parsed_relationships if r["from"] == class_name and r["kind"] == "inherits"]
                            if parent_rels:
                                return get_related_pk_one(parent_rels[0]["to"])
                            attrs = current.get('attributes', [])
                            if attrs:
                                return attrs[0]['name']
                        return 'id'
                    
                    related_pk = get_related_pk_one(rel['to'])
                    display_attr = related_pk
                    
                    if related_class:
                        attrs = related_class.get('attributes', [])
                        # Buscar el primer atributo que no sea la PK para mostrar
                        for attr in attrs:
                            if attr['name'] != related_pk:
                                display_attr = attr['name']
                                break
                    
                    form_fields.append(f"""FutureBuilder<List<{rel['to']}>>(
              future: {rel['to']}Service().getAll(),
              builder: (context, snapshot) {{
                if (!snapshot.hasData) return const CircularProgressIndicator();
                return DropdownButtonFormField<String>(
                  decoration: const InputDecoration(labelText: '{rel['to']}'),
                  value: _selected{rel['to']}Id,
                  items: snapshot.data!.map((e) => DropdownMenuItem(
                    value: e.{related_pk}.toString(),
                    child: Text(e.{display_attr}.toString()),
                  )).toList(),
                  onChanged: (v) {{
                    setState(() {{
                      _selected{rel['to']}Id = v;
                    }});
                  }},
                  validator: (value) {{
                    if (value == null || value.isEmpty) {{
                      return 'Este campo es requerido';
                    }}
                    return null;
                  }},
                );
              }},
            )""")
        
        # Relaciones OneToMany → NO generar campos de formulario
        # En REST estándar, las relaciones one_to_many se gestionan desde el lado "many"
        # Solo se muestran en la vista de detalle (read-only), NO en el formulario
        # Por ejemplo: Persona tiene List<Perro>, pero NO se edita desde Persona
        # Se edita desde Perro seleccionando la Persona (many_to_one)

        # Generar creación del objeto
        # Para PKs numéricas: Si es creación, NO enviar (backend genera). Si es edición, enviar desde widget.item
        # Para PKs string: Siempre enviar desde el controlador
        create_object_fields_list = []
        for i, attr in enumerate(all_attributes):
            # Si es PK numérica (primer atributo y numérico)
            if i == 0 and is_numeric_pk:
                # En edición, usar el PK del item existente. En creación, el backend lo genera
                create_object_fields_list.append(f"{attr['name']}: widget.item?.{attr['name']} ?? 0")
            else:
                # Para todos los demás atributos (propios y heredados), usar el valor del controlador
                create_object_fields_list.append(f"{attr['name']}: {self._parse_field_value(attr)}")
        
        # Si hay herencia, agregar las relaciones del padre al objeto
        # Crear un set con los nombres ya usados para evitar duplicados
        used_field_names = {field.split(':')[0].strip() for field in create_object_fields_list}
        
        if parent_class:
            # Función recursiva para obtener relaciones del padre
            def get_all_parent_relationships_for_form(class_name):
                rels = []
                parent_rels = [r for r in self.parsed_relationships if r["from"] == class_name and r["kind"] == "inherits"]
                if parent_rels:
                    rels.extend(get_all_parent_relationships_for_form(parent_rels[0]["to"]))
                for rel in self.parsed_relationships:
                    if rel["from"] == class_name and rel["kind"] != "inherits":
                        rels.append(rel)
                return rels
            
            parent_rels = get_all_parent_relationships_for_form(parent_class)
            for rel in parent_rels:
                # Solo agregar relaciones ManyToOne y OneToOne (que son IDs)
                # OneToMany NO se pasa en el constructor (no existe en el modelo)
                if rel["kind"] == "many_to_one":
                    field_name = f"{self._to_snake_case(rel['to'])}Id"
                    if field_name not in used_field_names:
                        create_object_fields_list.append(f"{field_name}: _selected{rel['to']}Id ?? ''")
                        used_field_names.add(field_name)
                elif rel["kind"] == "one_to_one":
                    field_name = f"{self._to_snake_case(rel['to'])}Id"
                    if field_name not in used_field_names:
                        create_object_fields_list.append(f"{field_name}: _selected{rel['to']}Id ?? ''")
                        used_field_names.add(field_name)
                # OneToMany: NO se agrega (no existe en el modelo)
        
        create_object_fields = ',\n          '.join(create_object_fields_list)
        
        # Agregar relaciones many_to_one al objeto
        many_to_one_fields = []
        for rel in relationships:
            if rel["kind"] == "many_to_one":
                field_name = f"{self._to_snake_case(rel['to'])}Id"
                normalized_field = field_name.lower().replace('_', '')
                if normalized_field not in existing_attr_names_normalized:
                    many_to_one_fields.append(f"{field_name}: _selected{rel['to']}Id ?? ''")
        
        if many_to_one_fields:
            if create_object_fields:
                create_object_fields += ',\n          ' + ',\n          '.join(many_to_one_fields)
            else:
                create_object_fields = ',\n          '.join(many_to_one_fields)
        
        # Agregar relaciones OneToOne al objeto (solo IDs)
        one_to_one_fields = []
        for rel in relationships:
            if rel["kind"] == "one_to_one":
                field_name = f"{self._to_snake_case(rel['to'])}Id"
                normalized_field = field_name.lower().replace('_', '')
                if normalized_field not in existing_attr_names_normalized:
                    one_to_one_fields.append(f"{field_name}: _selected{rel['to']}Id ?? ''")
        
        if one_to_one_fields:
            if create_object_fields:
                create_object_fields += ',\n          ' + ',\n          '.join(one_to_one_fields)
            else:
                create_object_fields = ',\n          '.join(one_to_one_fields)
        
        # Generar imports para modelos y servicios relacionados
        related_imports = []
        
        for rel in relationships:
            # Importar servicios para cargar opciones de dropdown (ManyToOne y OneToOne)
            if rel["kind"] in ["one_to_one", "many_to_one"]:
                related_imports.append(f"import '../models/{self._to_snake_case(rel['to'])}.dart';")
                related_imports.append(f"import '../services/{self._to_snake_case(rel['to'])}_service.dart';")
            # one_to_many NO necesita imports en formulario (solo en vista de detalle)
        
        # Eliminar duplicados y ordenar
        related_imports = sorted(set(related_imports))
        related_imports_str = '\n'.join(related_imports) if related_imports else ''
        
        # No se necesitan métodos helper porque trabajamos solo con IDs
        helper_methods = []
        
        content = f"""import 'package:flutter/material.dart';
import '../models/{snake_name}.dart';
import '../services/{snake_name}_service.dart';
{related_imports_str}

class {name}FormView extends StatefulWidget {{
  final {name}? item;

  const {name}FormView({{super.key, this.item}});

  @override
  State<{name}FormView> createState() => _{name}FormViewState();
}}

class _{name}FormViewState extends State<{name}FormView> {{
  final _formKey = GlobalKey<FormState>();
  final {name}Service _service = {name}Service();
  {controllers}
  bool _isLoading = false;

  @override
  void initState() {{
    super.initState();
    if (widget.item != null) {{
      {init_controllers}
    }}
  }}

  @override
  void dispose() {{
{self._generate_dispose_controllers(all_attributes, is_numeric_pk, parent_class)}
    super.dispose();
  }}

  Future<void> _submit() async {{
    if (!_formKey.currentState!.validate()) return;

    setState(() => _isLoading = true);

    try {{
      final item = {name}(
        {create_object_fields},
      );

      if (widget.item == null) {{
        await _service.create(item);
      }} else {{
        await _service.update(item.{pk_name}.toString(), item);
      }}

      if (mounted) {{
        Navigator.pop(context);
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(widget.item == null
                ? 'Creado exitosamente'
                : 'Actualizado exitosamente'),
          ),
        );
      }}
    }} catch (e) {{
      setState(() => _isLoading = false);
      if (mounted) {{
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Error: $e')),
        );
      }}
    }}
  }}
{''.join(helper_methods)}

  @override
  Widget build(BuildContext context) {{
    return Scaffold(
      appBar: AppBar(
        title: Text(widget.item == null ? 'Crear {name}' : 'Editar {name}'),
        backgroundColor: Theme.of(context).colorScheme.inversePrimary,
      ),
      body: _isLoading
          ? const Center(child: CircularProgressIndicator())
          : SingleChildScrollView(
              padding: const EdgeInsets.all(16),
              child: Form(
                key: _formKey,
                child: Column(
                  children: [
{','.join([chr(10) + '                    const SizedBox(height: 16),' + chr(10) + field for field in form_fields])},
                    const SizedBox(height: 24),
                    SizedBox(
                      width: double.infinity,
                      child: ElevatedButton(
                        onPressed: _submit,
                        style: ElevatedButton.styleFrom(
                          padding: const EdgeInsets.all(16),
                        ),
                        child: Text(
                          widget.item == null ? 'Crear' : 'Actualizar',
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            ),
    );
  }}
}}
"""
        file_path = base_path / 'lib' / 'views' / f'{snake_name}_form_view.dart'
        file_path.write_text(content, encoding="utf-8", newline="\n")
    
    def _generate_detail_view(self, base_path, clase):
        """Genera la vista de detalle"""
        name = clase['name']
        snake_name = self._to_snake_case(name)
        relationships = [r for r in self.parsed_relationships if r["from"] == name]
        attributes = clase.get('attributes', [])
        
        # Detectar herencia y obtener todos los atributos
        parent_class = None
        for rel in relationships:
            if rel["kind"] == "inherits":
                parent_class = rel["to"]
                break
        
        # Función recursiva para obtener todos los atributos heredados
        def get_all_attributes(class_name):
            attrs = []
            current_class = next((c for c in self.classes if c['name'] == class_name), None)
            if current_class:
                # Primero obtener atributos del padre (si existe)
                parent_rels = [r for r in self.parsed_relationships if r["from"] == class_name and r["kind"] == "inherits"]
                if parent_rels:
                    parent_name = parent_rels[0]["to"]
                    attrs.extend(get_all_attributes(parent_name))
                
                # Luego agregar atributos propios (solo si no existen ya en attrs)
                existing_attr_names = {attr['name'].lower() for attr in attrs}
                for attr in current_class.get('attributes', []):
                    if attr['name'].lower() not in existing_attr_names:
                        attrs.append(attr)
            return attrs
        
        all_attributes = get_all_attributes(name)
        
        # El primer atributo es la PK
        pk_attr = all_attributes[0] if all_attributes else None
        pk_name = pk_attr['name'] if pk_attr else 'id'
        
        # Normalizar para evitar duplicados
        existing_attr_names_normalized = {attr['name'].lower().replace('_', '') for attr in all_attributes}
        
        # Generar filas de detalles - incluir todos los campos (incluyendo PK)
        detail_rows = []
        for attr in all_attributes:
            detail_rows.append(f"""              _buildDetailRow('{attr['name']}', item.{attr['name']}.toString()),""")
        
        # Agregar relaciones
        for rel in relationships:
            if rel["kind"] == "one_to_many":
                # OneToMany: Mostrar lista de objetos relacionados (viene del backend en GET)
                field_name = self._to_snake_case(rel['to'])
                normalized_field = field_name.lower().replace('_', '')
                if normalized_field not in existing_attr_names_normalized:
                    # Obtener información de la clase relacionada
                    related_class = next((c for c in self.classes if c['name'] == rel['to']), None)
                    
                    # Detectar si es una entidad intermedia (tiene exactamente 2 relaciones ManyToOne)
                    is_intermediate = False
                    intermediate_relations = []
                    if related_class:
                        related_relationships = [r for r in self.parsed_relationships if r["from"] == rel['to']]
                        many_to_one_rels = [r for r in related_relationships if r["kind"] == "many_to_one"]
                        if len(many_to_one_rels) == 2:
                            is_intermediate = True
                            intermediate_relations = many_to_one_rels
                    
                    # ALTERNATIVA: Detectar si el nombre de la clase relacionada contiene el nombre de la entidad actual
                    # Esto captura casos como "PerroPersona" cuando estamos en "Persona" o "Perro"
                    is_likely_intermediate = False
                    if not is_intermediate and related_class:
                        class_name_lower = rel['to'].lower()
                        current_name_lower = name.lower()
                        # Si el nombre de la clase contiene el nombre de la entidad actual, probablemente es intermedia
                        if current_name_lower in class_name_lower and len(rel['to']) > len(name):
                            is_likely_intermediate = True
                            # Forzar la detección de relaciones para esta entidad
                            related_relationships = [r for r in self.parsed_relationships if r["from"] == rel['to']]
                            many_to_one_rels = [r for r in related_relationships if r["kind"] == "many_to_one"]
                            if len(many_to_one_rels) >= 2:
                                is_intermediate = True
                                intermediate_relations = many_to_one_rels
                    
                    if is_intermediate and len(intermediate_relations) == 2:
                        # Es una entidad intermedia - mostrar solo la entidad relacionada (NO la actual)
                        first_rel = intermediate_relations[0]
                        second_rel = intermediate_relations[1]
                        
                        # Determinar cuál entidad es la "otra" (no la actual)
                        other_rel = None
                        other_field = None
                        other_entity_name = None
                        
                        if first_rel['to'] != name:
                            other_rel = first_rel
                            other_field = self._to_snake_case(first_rel['to'])
                            other_entity_name = first_rel['to']
                        elif second_rel['to'] != name:
                            other_rel = second_rel
                            other_field = self._to_snake_case(second_rel['to'])
                            other_entity_name = second_rel['to']
                        
                        if other_rel and other_field:
                            # Obtener los 2 primeros atributos significativos de la otra entidad (sin id)
                            other_entity_class = next((c for c in self.classes if c['name'] == other_entity_name), None)
                            other_attrs = []
                            
                            if other_entity_class:
                                other_attrs = [attr['name'] for attr in other_entity_class.get('attributes', []) if attr['name'].lower() != 'id'][:2]
                            
                            # Generar el código para mostrar solo la otra entidad con sus atributos
                            if other_attrs:
                                # Generar interpolaciones dentro de una sola cadena
                                attr_interpolations = ', '.join([f"${{e.{other_field}?.{attr}}}" for attr in other_attrs])
                                display_code = f"'• {attr_interpolations}'"
                            else:
                                display_code = f"'ID: ${{e.{other_field}id}}'"
                            
                            detail_rows.append(f"""              const SizedBox(height: 16),
              Text('{other_entity_name}s:', style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 16)),
              const SizedBox(height: 8),
              if (item.{field_name}.isEmpty)
                const Padding(
                  padding: EdgeInsets.only(left: 16, bottom: 4),
                  child: Text('No hay {other_entity_name.lower()}s relacionados', style: TextStyle(fontSize: 14, fontStyle: FontStyle.italic, color: Colors.grey)),
                )
              else
                ...item.{field_name}.map((e) => Padding(
                  padding: const EdgeInsets.only(left: 16, bottom: 4),
                  child: Text({display_code}, style: const TextStyle(fontSize: 14), overflow: TextOverflow.ellipsis, maxLines: 2),
                )),""")
                    
                    if not is_intermediate or len(intermediate_relations) != 2:
                        # Relación OneToMany normal: Mostrar el primer atributo descriptivo
                        display_attr = 'id'
                        if related_class:
                            attrs = related_class.get('attributes', [])
                            # Buscar un atributo descriptivo (no id)
                            for attr in attrs:
                                if attr['name'].lower() not in ['id']:
                                    display_attr = attr['name']
                                    break
                        
                        detail_rows.append(f"""              const SizedBox(height: 16),
              Text('{rel['to']}s:', style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 16)),
              const SizedBox(height: 8),
              if (item.{field_name}.isEmpty)
                const Padding(
                  padding: EdgeInsets.only(left: 16, bottom: 4),
                  child: Text('No hay {rel['to'].lower()}s registrados', style: TextStyle(fontSize: 14, fontStyle: FontStyle.italic, color: Colors.grey)),
                )
              else
                ...item.{field_name}.map((e) => Padding(
                  padding: const EdgeInsets.only(left: 16, bottom: 4),
                  child: Text('• ${{e.{display_attr}.toString()}}', style: const TextStyle(fontSize: 14)),
                ))""")
            elif rel["kind"] == "one_to_one" or rel["kind"] == "many_to_one":
                field_name = self._to_snake_case(rel['to'])
                normalized_field = field_name.lower().replace('_', '')
                if normalized_field not in existing_attr_names_normalized:
                    # Obtener atributos de la clase relacionada
                    related_class = next((c for c in self.classes if c['name'] == rel['to']), None)
                    if related_class:
                        attrs = related_class.get('attributes', [])
                        
                        # Si el objeto está disponible, mostrar los primeros 2 atributos (o 1 si solo tiene 1)
                        # Filtrar atributos que no sean 'id'
                        display_attrs = [attr for attr in attrs if attr['name'].lower() != 'id']
                        # Tomar los primeros 2 (o menos si no hay suficientes)
                        attrs_to_show = display_attrs[:2]
                        
                        for attr in attrs_to_show:
                            detail_rows.append(f"""              if (item.{field_name} != null) _buildDetailRow('{rel['to']}.{attr['name']}', item.{field_name}!.{attr['name']}.toString())""")
        
        content = f"""import 'package:flutter/material.dart';
import '../models/{snake_name}.dart';

class {name}DetailView extends StatelessWidget {{
  final {name} item;

  const {name}DetailView({{super.key, required this.item}});

  @override
  Widget build(BuildContext context) {{
    return Scaffold(
      appBar: AppBar(
        title: const Text('Detalle de {name}'),
        backgroundColor: Theme.of(context).colorScheme.inversePrimary,
      ),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(16),
        child: Card(
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  '{name}',
                  style: Theme.of(context).textTheme.headlineSmall,
                ),
                const Divider(height: 32),
{chr(10).join([row + chr(10) + '                const SizedBox(height: 12),' for row in detail_rows])}
              ],
            ),
          ),
        ),
      ),
    );
  }}

  Widget _buildDetailRow(String label, String value) {{
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SizedBox(
          width: 120,
          child: Text(
            '$label:',
            style: const TextStyle(
              fontWeight: FontWeight.bold,
              fontSize: 16,
            ),
          ),
        ),
        Expanded(
          child: Text(
            value,
            style: const TextStyle(fontSize: 16),
          ),
        ),
      ],
    );
  }}
}}
"""
        file_path = base_path / 'lib' / 'views' / f'{snake_name}_detail_view.dart'
        file_path.write_text(content, encoding="utf-8", newline="\n")
    
    def _generate_routes(self, base_path):
        """Genera el archivo de rutas (opcional)"""
        pass
    
    # ========================================
    # === GENERADORES PARA ENTIDADES INTERMEDIAS ===
    # ========================================
    
    def _generate_intermediate_model(self, base_path, intermediate):
        """Genera el modelo para una entidad intermedia (relación ManyToMany)"""
        name = intermediate['name']
        first_entity = intermediate['first_entity']
        second_entity = intermediate['second_entity']
        snake_name = self._to_snake_case(name)
        first_snake = self._to_snake_case(first_entity)
        second_snake = self._to_snake_case(second_entity)
        
        # El backend devuelve los campos con el nombre de la entidad en minúsculas
        # Por ejemplo: "perro" y "persona", no "perroid" y "personaid"
        first_json_key = first_snake  # ya está en snake_case/lowercase
        second_json_key = second_snake
        
        content = f"""import '{first_snake}.dart';
import '{second_snake}.dart';

class {name} {{
  final int id;
  final int {first_snake}id;
  final {first_entity}? {first_snake};
  final int {second_snake}id;
  final {second_entity}? {second_snake};

  {name}({{
    required this.id,
    required this.{first_snake}id,
    this.{first_snake},
    required this.{second_snake}id,
    this.{second_snake},
  }});

  factory {name}.fromJson(Map<String, dynamic> json) {{
    return {name}(
      id: json['id'] is int ? json['id'] : int.tryParse(json['id']?.toString() ?? '0') ?? 0,
      {first_snake}id: json['{first_json_key}'] != null && json['{first_json_key}'] is Map
          ? (json['{first_json_key}']['id'] is int ? json['{first_json_key}']['id'] : int.tryParse(json['{first_json_key}']['id']?.toString() ?? '0') ?? 0)
          : 0,
      {first_snake}: json['{first_json_key}'] != null && json['{first_json_key}'] is Map 
          ? {first_entity}.fromJson(json['{first_json_key}']) 
          : null,
      {second_snake}id: json['{second_json_key}'] != null && json['{second_json_key}'] is Map
          ? (json['{second_json_key}']['id'] is int ? json['{second_json_key}']['id'] : int.tryParse(json['{second_json_key}']['id']?.toString() ?? '0') ?? 0)
          : 0,
      {second_snake}: json['{second_json_key}'] != null && json['{second_json_key}'] is Map
          ? {second_entity}.fromJson(json['{second_json_key}']) 
          : null,
    );
  }}

  Map<String, dynamic> toJson() {{
    return {{
      '{first_snake}id': {first_snake}id,
      '{second_snake}id': {second_snake}id,
    }};
  }}

  @override
  String toString() {{
    final firstStr = {first_snake}?.toString() ?? 'ID: ${{{first_snake}id}}';
    final secondStr = {second_snake}?.toString() ?? 'ID: ${{{second_snake}id}}';
    return '({first_entity}: $firstStr) ↔ ({second_entity}: $secondStr)';
  }}
}}
"""
        file_path = base_path / 'lib' / 'models' / f'{snake_name}.dart'
        file_path.write_text(self._sanitize(content), encoding="utf-8", newline="\n")
    
    def _generate_intermediate_service(self, base_path, intermediate):
        """Genera el servicio para una entidad intermedia"""
        name = intermediate['name']
        snake_name = self._to_snake_case(name)
        backend_url_name = self._to_backend_json_key(name)
        
        content = f"""import 'dart:convert';
import 'package:http/http.dart' as http;
import '../models/{snake_name}.dart';
import '../config.dart';

class {name}Service {{
  static const String baseUrl = ApiConfig.baseUrl;
  
  Future<List<{name}>> getAll() async {{
    try {{
      final response = await http.get(
        Uri.parse('$baseUrl/{backend_url_name}'),
        headers: {{'Content-Type': 'application/json'}},
      );

      if (response.statusCode == 200) {{
        final List<dynamic> jsonList = json.decode(response.body);
        // El backend puede devolver listas mixtas [objeto, id] debido a @JsonIdentityInfo
        // Filtrar solo los objetos completos (Maps), omitir los IDs sueltos
        return jsonList
            .whereType<Map<String, dynamic>>()
            .map((item) => {name}.fromJson(item))
            .toList();
      }} else {{
        throw Exception('Error al cargar {name}s: ${{response.statusCode}}');
      }}
    }} catch (e) {{
      throw Exception('Error de conexión: $e');
    }}
  }}

  Future<{name}?> getById(String id) async {{
    try {{
      final response = await http.get(
        Uri.parse('$baseUrl/{backend_url_name}/$id'),
        headers: {{'Content-Type': 'application/json'}},
      );

      if (response.statusCode == 200) {{
        return {name}.fromJson(json.decode(response.body));
      }} else if (response.statusCode == 404) {{
        return null;
      }} else {{
        throw Exception('Error al obtener {name}: ${{response.statusCode}}');
      }}
    }} catch (e) {{
      throw Exception('Error de conexión: $e');
    }}
  }}

  Future<{name}> create({name} item) async {{
    try {{
      final response = await http.post(
        Uri.parse('$baseUrl/{backend_url_name}'),
        headers: {{'Content-Type': 'application/json'}},
        body: json.encode(item.toJson()),
      );

      if (response.statusCode == 201 || response.statusCode == 200) {{
        return {name}.fromJson(json.decode(response.body));
      }} else {{
        throw Exception('Error al crear {name}: ${{response.statusCode}} - ${{response.body}}');
      }}
    }} catch (e) {{
      throw Exception('Error de conexión: $e');
    }}
  }}

  Future<{name}> update(String id, {name} item) async {{
    try {{
      final response = await http.put(
        Uri.parse('$baseUrl/{backend_url_name}/$id'),
        headers: {{'Content-Type': 'application/json'}},
        body: json.encode(item.toJson()),
      );

      if (response.statusCode == 200) {{
        return {name}.fromJson(json.decode(response.body));
      }} else {{
        throw Exception('Error al actualizar {name}: ${{response.statusCode}} - ${{response.body}}');
      }}
    }} catch (e) {{
      throw Exception('Error de conexión: $e');
    }}
  }}

  Future<void> delete(String id) async {{
    try {{
      final response = await http.delete(
        Uri.parse('$baseUrl/{backend_url_name}/$id'),
        headers: {{'Content-Type': 'application/json'}},
      );

      if (response.statusCode != 204 && response.statusCode != 200) {{
        throw Exception('Error al eliminar {name}: ${{response.statusCode}}');
      }}
    }} catch (e) {{
      throw Exception('Error de conexión: $e');
    }}
  }}
}}
"""
        file_path = base_path / 'lib' / 'services' / f'{snake_name}_service.dart'
        file_path.write_text(self._sanitize(content), encoding="utf-8", newline="\n")
    
    def _generate_intermediate_list_view(self, base_path, intermediate):
        """Genera la vista de listado para una entidad intermedia"""
        name = intermediate['name']
        first_entity = intermediate['first_entity']
        second_entity = intermediate['second_entity']
        snake_name = self._to_snake_case(name)
        first_snake = self._to_snake_case(first_entity)
        second_snake = self._to_snake_case(second_entity)
        
        content = f"""import 'package:flutter/material.dart';
import '../models/{snake_name}.dart';
import '../services/{snake_name}_service.dart';
import '{snake_name}_form_view.dart';
import '{snake_name}_detail_view.dart';

class {name}ListView extends StatefulWidget {{
  const {name}ListView({{super.key}});

  @override
  State<{name}ListView> createState() => _{name}ListViewState();
}}

class _{name}ListViewState extends State<{name}ListView> {{
  final {name}Service _service = {name}Service();
  List<{name}> _items = [];
  bool _isLoading = true;

  @override
  void initState() {{
    super.initState();
    _loadItems();
  }}

  Future<void> _loadItems() async {{
    setState(() => _isLoading = true);
    try {{
      final items = await _service.getAll();
      setState(() {{
        _items = items;
        _isLoading = false;
      }});
    }} catch (e) {{
      setState(() => _isLoading = false);
      if (mounted) {{
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Error al cargar: $e')),
        );
      }}
    }}
  }}

  Future<void> _deleteItem(String id) async {{
    try {{
      await _service.delete(id);
      _loadItems();
      if (mounted) {{
        ScaffoldMessenger.of(context).showSnackBar(
          const SnackBar(content: Text('Eliminado exitosamente')),
        );
      }}
    }} catch (e) {{
      if (mounted) {{
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Error al eliminar: $e')),
        );
      }}
    }}
  }}

  @override
  Widget build(BuildContext context) {{
    return Scaffold(
      appBar: AppBar(
        title: const Text('{name} (Relación)'),
        backgroundColor: Colors.purple,
      ),
      body: _isLoading
          ? const Center(child: CircularProgressIndicator())
          : _items.isEmpty
              ? const Center(
                  child: Text('No hay relaciones. ¡Crea una nueva!'),
                )
              : ListView.builder(
                  itemCount: _items.length,
                  itemBuilder: (context, index) {{
                    final item = _items[index];
                    final firstDisplay = item.{first_snake}?.toString() ?? 'ID: ${{item.{first_snake}id}}';
                    final secondDisplay = item.{second_snake}?.toString() ?? 'ID: ${{item.{second_snake}id}}';
                    
                    return Card(
                      margin: const EdgeInsets.symmetric(
                        horizontal: 16,
                        vertical: 8,
                      ),
                      child: ListTile(
                        leading: const Icon(Icons.link, color: Colors.purple),
                        title: Text('{first_entity} ↔ {second_entity}'),
                        subtitle: Text('$firstDisplay → $secondDisplay'),
                        trailing: Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            IconButton(
                              icon: const Icon(Icons.edit),
                              onPressed: () async {{
                                await Navigator.push(
                                  context,
                                  MaterialPageRoute(
                                    builder: (context) => {name}FormView(
                                      item: item,
                                    ),
                                  ),
                                );
                                _loadItems();
                              }},
                            ),
                            IconButton(
                              icon: const Icon(Icons.delete),
                              color: Colors.red,
                              onPressed: () {{
                                showDialog(
                                  context: context,
                                  builder: (context) => AlertDialog(
                                    title: const Text('Confirmar'),
                                    content: const Text(
                                      '¿Deseas eliminar esta relación?',
                                    ),
                                    actions: [
                                      TextButton(
                                        onPressed: () => Navigator.pop(context),
                                        child: const Text('Cancelar'),
                                      ),
                                      TextButton(
                                        onPressed: () {{
                                          Navigator.pop(context);
                                          _deleteItem(item.id.toString());
                                        }},
                                        child: const Text('Eliminar'),
                                      ),
                                    ],
                                  ),
                                );
                              }},
                            ),
                          ],
                        ),
                        onTap: () {{
                          Navigator.push(
                            context,
                            MaterialPageRoute(
                              builder: (context) => {name}DetailView(item: item),
                            ),
                          );
                        }},
                      ),
                    );
                  }},
                ),
      floatingActionButton: FloatingActionButton(
        onPressed: () async {{
          await Navigator.push(
            context,
            MaterialPageRoute(
              builder: (context) => const {name}FormView(),
            ),
          );
          _loadItems();
        }},
        child: const Icon(Icons.add),
      ),
    );
  }}
}}
"""
        file_path = base_path / 'lib' / 'views' / f'{snake_name}_list_view.dart'
        file_path.write_text(content, encoding="utf-8", newline="\n")
    
    def _generate_intermediate_form_view(self, base_path, intermediate):
        """Genera el formulario para crear/editar una entidad intermedia"""
        name = intermediate['name']
        first_entity = intermediate['first_entity']
        second_entity = intermediate['second_entity']
        snake_name = self._to_snake_case(name)
        first_snake = self._to_snake_case(first_entity)
        second_snake = self._to_snake_case(second_entity)
        
        content = f"""import 'package:flutter/material.dart';
import '../models/{snake_name}.dart';
import '../models/{first_snake}.dart';
import '../models/{second_snake}.dart';
import '../services/{snake_name}_service.dart';
import '../services/{first_snake}_service.dart';
import '../services/{second_snake}_service.dart';

class {name}FormView extends StatefulWidget {{
  final {name}? item;

  const {name}FormView({{super.key, this.item}});

  @override
  State<{name}FormView> createState() => _{name}FormViewState();
}}

class _{name}FormViewState extends State<{name}FormView> {{
  final _formKey = GlobalKey<FormState>();
  final {name}Service _service = {name}Service();
  final {first_entity}Service _{first_snake}Service = {first_entity}Service();
  final {second_entity}Service _{second_snake}Service = {second_entity}Service();
  
  bool _isLoading = false;
  List<{first_entity}> _{first_snake}Options = [];
  List<{second_entity}> _{second_snake}Options = [];
  int? _selected{first_entity}Id;
  int? _selected{second_entity}Id;

  @override
  void initState() {{
    super.initState();
    _loadOptions();
    if (widget.item != null) {{
      _selected{first_entity}Id = widget.item!.{first_snake}id;
      _selected{second_entity}Id = widget.item!.{second_snake}id;
    }}
  }}

  Future<void> _loadOptions() async {{
    try {{
      final {first_snake}List = await _{first_snake}Service.getAll();
      final {second_snake}List = await _{second_snake}Service.getAll();
      setState(() {{
        _{first_snake}Options = {first_snake}List;
        _{second_snake}Options = {second_snake}List;
      }});
    }} catch (e) {{
      if (mounted) {{
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Error al cargar opciones: $e')),
        );
      }}
    }}
  }}

  Future<void> _submit() async {{
    if (!_formKey.currentState!.validate()) return;
    if (_selected{first_entity}Id == null || _selected{second_entity}Id == null) {{
      ScaffoldMessenger.of(context).showSnackBar(
        const SnackBar(content: Text('Debes seleccionar ambas entidades')),
      );
      return;
    }}

    setState(() => _isLoading = true);

    try {{
      final item = {name}(
        id: widget.item?.id ?? 0,
        {first_snake}id: _selected{first_entity}Id!,
        {second_snake}id: _selected{second_entity}Id!,
      );

      if (widget.item == null) {{
        await _service.create(item);
      }} else {{
        await _service.update(item.id.toString(), item);
      }}

      if (mounted) {{
        Navigator.pop(context);
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(
            content: Text(widget.item == null
                ? 'Relación creada exitosamente'
                : 'Relación actualizada exitosamente'),
          ),
        );
      }}
    }} catch (e) {{
      setState(() => _isLoading = false);
      if (mounted) {{
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Error: $e')),
        );
      }}
    }}
  }}

  @override
  Widget build(BuildContext context) {{
    return Scaffold(
      appBar: AppBar(
        title: Text(widget.item == null ? 'Crear Relación {name}' : 'Editar Relación {name}'),
        backgroundColor: Colors.purple,
      ),
      body: _isLoading
          ? const Center(child: CircularProgressIndicator())
          : SingleChildScrollView(
              padding: const EdgeInsets.all(16),
              child: Form(
                key: _formKey,
                child: Column(
                  children: [
                    DropdownButtonFormField<int>(
                      value: _selected{first_entity}Id,
                      decoration: const InputDecoration(
                        labelText: 'Seleccionar {first_entity}',
                        border: OutlineInputBorder(),
                      ),
                      items: _{first_snake}Options.map((item) {{
                        return DropdownMenuItem<int>(
                          value: item.id,
                          child: Text(item.toString()),
                        );
                      }}).toList(),
                      onChanged: (value) {{
                        setState(() => _selected{first_entity}Id = value);
                      }},
                      validator: (value) {{
                        if (value == null) return 'Debes seleccionar una opción';
                        return null;
                      }},
                    ),
                    const SizedBox(height: 16),
                    DropdownButtonFormField<int>(
                      value: _selected{second_entity}Id,
                      decoration: const InputDecoration(
                        labelText: 'Seleccionar {second_entity}',
                        border: OutlineInputBorder(),
                      ),
                      items: _{second_snake}Options.map((item) {{
                        return DropdownMenuItem<int>(
                          value: item.id,
                          child: Text(item.toString()),
                        );
                      }}).toList(),
                      onChanged: (value) {{
                        setState(() => _selected{second_entity}Id = value);
                      }},
                      validator: (value) {{
                        if (value == null) return 'Debes seleccionar una opción';
                        return null;
                      }},
                    ),
                    const SizedBox(height: 24),
                    SizedBox(
                      width: double.infinity,
                      child: ElevatedButton(
                        onPressed: _submit,
                        style: ElevatedButton.styleFrom(
                          padding: const EdgeInsets.all(16),
                        ),
                        child: Text(
                          widget.item == null ? 'Crear Relación' : 'Actualizar Relación',
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            ),
    );
  }}
}}
"""
        file_path = base_path / 'lib' / 'views' / f'{snake_name}_form_view.dart'
        file_path.write_text(content, encoding="utf-8", newline="\n")
    
    def _generate_intermediate_detail_view(self, base_path, intermediate):
        """Genera la vista de detalle para una entidad intermedia"""
        name = intermediate['name']
        first_entity = intermediate['first_entity']
        second_entity = intermediate['second_entity']
        snake_name = self._to_snake_case(name)
        first_snake = self._to_snake_case(first_entity)
        second_snake = self._to_snake_case(second_entity)
        
        # Obtener los 2 primeros atributos significativos de cada entidad relacionada (sin id)
        first_entity_class = next((c for c in self.classes if c['name'] == first_entity), None)
        second_entity_class = next((c for c in self.classes if c['name'] == second_entity), None)
        
        first_attrs = []
        second_attrs = []
        
        if first_entity_class:
            first_attrs = [attr for attr in first_entity_class.get('attributes', []) if attr['name'].lower() != 'id'][:2]
        if second_entity_class:
            second_attrs = [attr for attr in second_entity_class.get('attributes', []) if attr['name'].lower() != 'id'][:2]
        
        # Generar filas para mostrar los atributos de cada entidad
        first_entity_rows = []
        if first_attrs:
            for attr in first_attrs:
                first_entity_rows.append(f"""                if (item.{first_snake} != null) _buildDetailRow('{first_entity}.{attr['name']}', item.{first_snake}!.{attr['name']}.toString()),
                if (item.{first_snake} != null) const SizedBox(height: 12),""")
        
        second_entity_rows = []
        if second_attrs:
            for attr in second_attrs:
                second_entity_rows.append(f"""                if (item.{second_snake} != null) _buildDetailRow('{second_entity}.{attr['name']}', item.{second_snake}!.{attr['name']}.toString()),
                if (item.{second_snake} != null) const SizedBox(height: 12),""")
        
        content = f"""import 'package:flutter/material.dart';
import '../models/{snake_name}.dart';

class {name}DetailView extends StatelessWidget {{
  final {name} item;

  const {name}DetailView({{super.key, required this.item}});

  @override
  Widget build(BuildContext context) {{
    return Scaffold(
      appBar: AppBar(
        title: const Text('Detalle de Relación {name}'),
        backgroundColor: Colors.purple,
      ),
      body: SingleChildScrollView(
        padding: const EdgeInsets.all(16),
        child: Card(
          child: Padding(
            padding: const EdgeInsets.all(16),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  'Relación {first_entity} - {second_entity}',
                  style: Theme.of(context).textTheme.headlineSmall,
                ),
                const Divider(height: 32),
                _buildDetailRow('ID de Relación', item.id.toString()),
                const SizedBox(height: 12),
                _buildDetailRow('ID de {first_entity}', item.{first_snake}id.toString()),
                const SizedBox(height: 12),
{chr(10).join(first_entity_rows) if first_entity_rows else f"                _buildDetailRow('{first_entity}', item.{first_snake}?.toString() ?? 'No disponible'),{chr(10)}                const SizedBox(height: 12)"}
                _buildDetailRow('ID de {second_entity}', item.{second_snake}id.toString()),
                const SizedBox(height: 12),
{chr(10).join(second_entity_rows) if second_entity_rows else f"                _buildDetailRow('{second_entity}', item.{second_snake}?.toString() ?? 'No disponible'),"}
              ],
            ),
          ),
        ),
      ),
    );
  }}

  Widget _buildDetailRow(String label, String value) {{
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SizedBox(
          width: 150,
          child: Text(
            '$label:',
            style: const TextStyle(
              fontWeight: FontWeight.bold,
              fontSize: 16,
            ),
          ),
        ),
        Expanded(
          child: Text(
            value,
            style: const TextStyle(fontSize: 16),
          ),
        ),
      ],
    );
  }}
}}
"""
        file_path = base_path / 'lib' / 'views' / f'{snake_name}_detail_view.dart'
        file_path.write_text(content, encoding="utf-8", newline="\n")
    
    # Utilidades
    def _to_snake_case(self, name):
        """Convierte PascalCase a snake_case"""
        import re
        name = re.sub('(.)([A-Z][a-z]+)', r'\1_\2', name)
        return re.sub('([a-z0-9])([A-Z])', r'\1_\2', name).lower()
    
    def _to_backend_json_key(self, name):
        """Convierte nombre de atributo al formato del backend: minúsculas sin separadores"""
        # Eliminar guiones bajos y convertir a minúsculas
        return name.replace('_', '').lower()
    
    def _convert_type(self, uml_type):
        """Convierte tipos UML a tipos Dart"""
        type_map = {
            'string': 'String',
            'String': 'String',
            'int': 'int',
            'Int': 'int',
            'double': 'double',
            'Double': 'double',
            'bool': 'bool',
            'Boolean': 'bool',
            'Date': 'DateTime',
        }
        return type_map.get(uml_type, 'String')
    
    def _generate_copy_with_params(self, attributes):
        """Genera parámetros para copyWith"""
        params = []
        for attr in attributes:
            dart_type = self._convert_type(attr['type'])
            params.append(f"    {dart_type}? {attr['name']}")
        return ',\n'.join(params) + ',' if params else ''
    
    def _generate_copy_with_assignments(self, attributes):
        """Genera asignaciones para copyWith"""
        assignments = []
        for attr in attributes:
            assignments.append(f"      {attr['name']}: {attr['name']} ?? this.{attr['name']}")
        return ',\n'.join(assignments) + ',' if assignments else ''
    
    def _parse_field_value(self, attr):
        """Genera el código para parsear el valor del campo"""
        dart_type = self._convert_type(attr['type'])
        field_name = attr['name']
        
        if dart_type == 'int':
            return f"int.tryParse(_{field_name}Controller.text) ?? 0"
        elif dart_type == 'double':
            return f"double.tryParse(_{field_name}Controller.text) ?? 0.0"
        elif dart_type == 'bool':
            return f"_{field_name}Controller.text.toLowerCase() == 'true'"
        else:
            return f"_{field_name}Controller.text"


    def _sanitize(self, text: str) -> str:
        """Normaliza texto y elimina caracteres problemáticos."""
        text = unicodedata.normalize("NFC", text)
        # Reemplazar signos que a veces fallan en YAML
        text = (
            text.replace("¿", "?")
                .replace("¡", "!")
                .replace("“", '"')
                .replace("”", '"')
                .replace("‘", "'")
                .replace("’", "'")
        )
        return text

    def _generate_dispose_controllers(self, attributes, is_numeric_pk=False, parent_class=None):
        """Genera dispose para los controladores que realmente existen"""
        disposes = []
        for i, attr in enumerate(attributes):
            # Si es la PK (primer atributo) y es numérica, NO hay controlador
            if i == 0 and is_numeric_pk:
                continue
            disposes.append(f"    _{attr['name']}Controller.dispose();")
        return '\n'.join(disposes)

