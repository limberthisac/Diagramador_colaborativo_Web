import re
import requests
import json
import time
from django.conf import settings

from uuid import uuid4




# GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent"
GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent"


class GeminiServiceError(Exception):
    """Error base controlado para las llamadas al proveedor de IA."""


class GeminiUnavailableError(GeminiServiceError):
    """El proveedor no esta disponible despues de los reintentos."""


class GeminiTimeoutError(GeminiServiceError):
    """El proveedor supero el tiempo maximo de espera."""


class GeminiResponseError(GeminiServiceError):
    """El proveedor rechazo la solicitud o devolvio contenido invalido."""


def _request_gemini(data, *, read_timeout=60, max_attempts=3):
    """Ejecuta una solicitud a Gemini con limites y reintentos controlados."""
    api_key = getattr(settings, "GEMINI_API_KEY", None)
    headers = {
        "Content-Type": "application/json",
        "x-goog-api-key": api_key,
    }
    transient_statuses = {429, 500, 502, 503, 504}
    timeout_attempts = min(max_attempts, 2)

    for attempt in range(1, max_attempts + 1):
        try:
            response = requests.post(
                GEMINI_API_URL,
                headers=headers,
                json=data,
                timeout=(10, read_timeout),
            )
        except requests.Timeout as exc:
            if attempt < timeout_attempts:
                time.sleep(2 ** (attempt - 1))
                continue
            raise GeminiTimeoutError(
                "Gemini tardo demasiado en responder"
            ) from exc
        except requests.ConnectionError as exc:
            if attempt < max_attempts:
                time.sleep(2 ** (attempt - 1))
                continue
            raise GeminiUnavailableError(
                "No se pudo conectar con Gemini"
            ) from exc
        except requests.RequestException as exc:
            raise GeminiResponseError(
                "No se pudo completar la solicitud a Gemini"
            ) from exc

        if response.status_code in transient_statuses:
            if attempt < max_attempts:
                time.sleep(2 ** (attempt - 1))
                continue
            raise GeminiUnavailableError(
                f"Gemini no esta disponible (estado {response.status_code})"
            )

        if response.status_code >= 400:
            raise GeminiResponseError(
                f"Gemini rechazo la solicitud (estado {response.status_code})"
            )

        try:
            return response.json()
        except ValueError as exc:
            raise GeminiResponseError(
                "Gemini devolvio una respuesta que no es JSON"
            ) from exc

    raise GeminiUnavailableError("No se pudo obtener respuesta de Gemini")


def _extract_text(result):
    try:
        return result["candidates"][0]["content"]["parts"][0]["text"]
    except (KeyError, IndexError, TypeError) as exc:
        raise GeminiResponseError(
            "Gemini no devolvio contenido utilizable"
        ) from exc


def call_gemini(prompt: str, current_diagram=None):
    if not isinstance(current_diagram, dict):
        current_diagram = {"classes": [], "relationships": []}

    diagram_context = json.dumps(
        current_diagram,
        ensure_ascii=False,
        indent=2,
    )

    # Detectar si es una solicitud de eliminación
    delete_keywords = ["eliminar", "elimina", "borra", "borrar",
                       "quitar", "quita", "remover", "remueve",
                       "sacar", "saca", "delete", "remove"]
    is_delete_request = any(keyword in prompt.lower()
                            for keyword in delete_keywords)

    # Detectar si es una solicitud de edición
    edit_keywords = ["cambies", "cambiar", "cambia",
                     "edites", "edita", "editar",
                     "modifiques", "modifica", "modificar",
                     "actualices", "actualizar", "actualiza",
                     "añadir", "añade", "agregar", "agrega", "agregue",
                     "incorporar", "incorpora"
                     ]
    is_edit_request = any(keyword in prompt.lower()
                          for keyword in edit_keywords)

    if is_delete_request:
        # Prompt para eliminación - devolver un solo JSON con marcadores de eliminación
        prompt_text = f"""
Analiza el siguiente prompt de eliminación y devuelve UN SOLO JSON con los elementos marcados para eliminar.

IMPORTANTE: El usuario quiere ELIMINAR elementos (clases, atributos, métodos o relaciones). Debes:

1. Identificar QUÉ se debe eliminar según el prompt
2. Marcar esos elementos con "eliminar": true
3. Devolver SOLO los elementos que se deben eliminar

Formato de respuesta:
```json
{{
  "classes": [
    {{
      "id": "uuid_o_nombre_clase",
      "name": "NombreClase",
      "eliminar": true,
      "attributes": [
        {{"name": "atributo_a_eliminar", "type": "tipo", "eliminar": true}}
      ],
      "methods": [
        {{"name": "metodo_a_eliminar", "parameters": "", "returnType": "", "eliminar": true}}
      ]
    }}
  ],
  "relationships": [
    {{
      "id": "uuid_relacion",
      "type": "association | generalization | aggregation | composition | dependency",
      "sourceId": "nombre_clase_origen",
      "targetId": "nombre_clase_destino",
      "eliminar": true
    }}
  ]
}}
```

REGLAS IMPORTANTES:
- Si se debe eliminar UNA CLASE COMPLETA, marca la clase con "eliminar": true y NO incluyas attributes/methods
- Si se debe eliminar UN ATRIBUTO específico, incluye solo ese atributo con "eliminar": true dentro de la clase
- Si se debe eliminar UN MÉTODO específico, incluye solo ese método con "eliminar": true dentro de la clase
- Si se debe eliminar UNA RELACIÓN, márcala con "eliminar": true e identifícala por sourceId/targetId (nombres de clases)
- Usa nombres de clases (no UUIDs) para sourceId y targetId en relaciones
- NO incluyas elementos que NO se deben eliminar
- NO devuelvas nada más, solo el JSON

Ejemplos:
- "elimina la clase Usuario" → {{"classes": [{{"name": "Usuario", "eliminar": true}}]}}
- "quita el atributo edad de Persona" → {{"classes": [{{"name": "Persona", "attributes": [{{"name": "edad", "eliminar": true}}]}}]}}
- "borra la relación entre Persona y Cliente" → {{"relationships": [{{"sourceId": "Persona", "targetId": "Cliente", "eliminar": true}}]}}

Prompt del usuario:
{prompt}

DIAGRAMA ACTUAL DEL USUARIO:
{diagram_context}

Usa exclusivamente los nombres e identificadores que aparecen en el diagrama actual.
Si el elemento solicitado no existe, devuelve las listas vacías correspondientes.
"""
    elif is_edit_request:
        # Prompt para edición - devolver dos JSONs
        prompt_text = f"""
Analiza el siguiente prompt de edición y devuelve DOS JSONs separados:

IMPORTANTE: El usuario quiere editar/modificar una tabla o relación existente. Debes devolver:

1. **JSON ORIGINAL**: El modelo UML completo como está actualmente (sin cambios)
2. **JSON EDITADO**: Solo los elementos modificados aplicando EXACTAMENTE los cambios solicitados

Ejemplo de cambio de atributo:
- Si el prompt dice "cambia fecha:Date a fecha_Hora:String"
- En "editado" debe aparecer: {{"name": "fecha_Hora", "type": "String", "editado": true}}

Formato de respuesta:
```json
{{
  "original": {{
    "classes": [
      {{
        "id": "uuid",
        "name": "NombreClase",
        "attributes": [
          {{"name": "atributo_original", "type": "tipo_original"}}
        ],
        "methods": [
          {{"name": "metodo_original", "parameters": "", "returnType": ""}}
        ]
      }}
    ],
    "relationships": [
      {{
        "id": "uuid",
        "type": "association | generalization | aggregation | composition | dependency",
        "sourceId": "uuid",
        "targetId": "uuid",
        "labels": ["1..*", "1"]
      }}
    ]
  }},
  "editado": {{
    "classes": [
      {{
        "id": "mismo_id_del_original",
        "name": "NombreClaseModificado",
        "attributes": [
          {{"name": "nuevo_nombre_atributo", "type": "nuevo_tipo", "editado": true}}
        ],
        "methods": [
          {{"name": "nuevo_nombre_metodo", "parameters": "nuevos_params", "returnType": "nuevo_tipo", "editado": true}}
        ],
        "editado": true
      }}
    ],
    "relationships": [
      {{
        "id": "mismo_id_del_original",
        "type": "nuevo_tipo_relacion",
        "sourceId": "uuid",
        "targetId": "uuid",
        "labels": ["nueva_etiqueta1", "nueva_etiqueta2"],
        "editado": true
      }}
    ]
  }}
}}
```

REGLAS CRÍTICAS:
- Aplica EXACTAMENTE los cambios solicitados en el prompt
- Si el prompt dice "cambia X a Y", en "editado" debe aparecer Y, NO X
- En "editado" solo incluye los elementos que REALMENTE cambiaron con sus NUEVOS valores
- Usa los mismos UUIDs en ambos JSONs para la misma entidad
- Marca con "editado": true SOLO los elementos que sufrieron modificaciones
- NO devuelvas nada más, solo el JSON

Prompt del usuario:
{prompt}

DIAGRAMA ACTUAL DEL USUARIO:
{diagram_context}

El bloque "original" debe copiar del diagrama actual únicamente los elementos afectados.
Conserva exactamente sus IDs. No inventes clases, atributos ni relaciones existentes.
"""
    else:
        # Prompt normal - devolver un solo JSON
        prompt_text = f"""
Convierte el siguiente prompt en un JSON UML válido. 
El JSON **debe seguir exactamente** esta estructura:

{{
  "classes": [
    {{
      "id": "uuid",
      "name": "NombreClase",
      "attributes": [
        {{"name": "atributo", "type": "tipo"}}
      ],
      "methods": [
        {{"name": "metodo", "parameters": "", "returnType": ""}}
      ]
    }}
  ],
  "relationships": [
    {{
      "id": "uuid",
      "type": "association | generalization | aggregation | composition | dependency",
      "sourceId": "uuid",
      "targetId": "uuid",
      "labels": ["1..*", "1"]
    }}
  ]
}}

Usa UUIDs generados aleatoriamente como 'id'.
NO devuelvas nada más, solo el JSON.

Prompt del usuario:
{prompt}

DIAGRAMA ACTUAL DEL USUARIO:
{diagram_context}

Si la instrucción crea elementos nuevos, devuelve solamente los elementos nuevos.
Si crea una relación entre clases existentes, utiliza los IDs exactos del diagrama actual.
No vuelvas a crear una clase que ya existe.
"""

    data = {
        "contents": [
            {
                "parts": [
                    {
                        "text": prompt_text
                    }
                ]
            }
        ]
    }

    result = _request_gemini(data)
    return _extract_text(result)


def call_gemini_analysis(prompt: str):
    data = {
        "contents": [
            {
                "parts": [
                    {
                        "text": f"""
Analiza este modelo UML y responde SOLO en formato JSON.

Estructura de salida obligatoria:
{{
  "validas": [
    {{
      "relacion": "Texto corto con tipo y tablas",
      "razon": "Por qué es válida"
    }}
  ],
  "errores": [
    {{
      "relacion": "Texto corto con tipo y tablas",
      "problema": "Qué está mal",
      "sugerencia": "Cómo corregirlo"
    }}
  ]
}}

No escribas explicaciones fuera del JSON.
Prompt:
{prompt}
"""
                    }
                ]
            }
        ]
    }

    result = _request_gemini(data)
    return _extract_text(result)


# ===============================================================
# 🔹 Nuevo servicio: Procesar imagen UML → devolver JSON
# ===============================================================
# ===============================================================
# 🔹 Servicio: Procesar imagen UML → devolver JSON limpio y estructurado
# ===============================================================
def call_gemini_from_image(image_base64: str, mime_type: str = "image/png"):
    """
    Envía una imagen UML a Gemini (1.5-pro) y devuelve un JSON estructurado con:
    - Clases (nombre, atributos, métodos)
    - Relaciones clasificadas visualmente (composition, aggregation, generalization, association)
    """

  #GEMINI_API_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent"

    # ===============================================================
    # 📘 Prompt mejorado: primero descripción visual, luego JSON UML
    # ===============================================================
    prompt_text = """
Analiza cuidadosamente la imagen de un **diagrama de clases UML**.

🎯 **OBJETIVO**: Identificar TODAS las clases y relaciones visibles.

**PASO 1: Identificar clases**
Detecta todos los rectángulos que representan clases con:
- Nombre de la clase (en la parte superior)
- Atributos en formato `nombre:tipo`
- Métodos en formato `nombre():tipoRetorno` o `nombre(params):tipoRetorno`

**PASO 2: Identificar relaciones**
Para CADA línea/conector entre clases, describe:

📍 **Símbolos en los extremos**:
- **Triángulo blanco/vacío GRANDE** → indica HERENCIA (generalization)
- **Rombo blanco/vacío** → indica AGREGACIÓN (aggregation)
- **Rombo negro/relleno** → indica COMPOSICIÓN (composition)
- **Flecha simple** o **ningún símbolo** → indica ASOCIACIÓN (association)
- **Línea punteada** → indica DEPENDENCIA (dependency)

📍 **Ubicación del símbolo**: 
- Si el símbolo (triángulo, rombo) está en el EXTREMO DERECHO o SUPERIOR de la línea → ese es el HEAD (destino)
- Si está en el EXTREMO IZQUIERDO o INFERIOR → ese es el TAIL (origen)

📍 **Etiquetas de cardinalidad**: Busca números cerca de los extremos como "1", "0..1", "1..*", "*"
   - Si una línea tiene etiquetas en AMBOS extremos (ej: "1..*" cerca de Persona y "0..1" cerca de Perro)
   - Reporta las etiquetas como: ["1..*", "0..1"]
   - NO crees dos relaciones separadas, es UNA SOLA relación bidireccional

**REGLAS CRÍTICAS**:
1. NO inventes relaciones que no existen visualmente
2. Una línea = UNA relación (incluso si tiene etiquetas en ambos extremos)
3. Si una línea tiene múltiples etiquetas, inclúyelas TODAS en el array "labels"
4. Cuenta las líneas FÍSICAS en la imagen, NO las etiquetas
5. Reporta EXACTAMENTE lo que ves

⚠️ **FORMATO DE SALIDA** (JSON exacto sin explicaciones):

{
  "nodes": [
    {
      "id": "uuid1",
      "name": "NombreClase",
      "attributes": [
        {"name": "atributo", "type": "tipo"}
      ],
      "methods": [
        {"name": "metodo", "parameters": "", "returnType": "tipo"}
      ]
    }
  ],
  "edges_raw": [
    {
      "id": "edge-uuid1",
      "sourceName": "ClaseOrigen",
      "targetName": "ClaseDestino",
      "head": {
        "shape": "triangle|diamond|none",
        "fill": "solid|none|white|black",
        "size": "small|large|medium"
      },
      "tail": {
        "shape": "triangle|diamond|none",
        "diamond": "none|white|black",
        "fill": "solid|none|white|black"
      },
      "line": {
        "style": "solid|dashed"
      },
      "labels": ["etiqueta_extremo1", "etiqueta_extremo2"]
    }
  ]
}

**EJEMPLO IMPORTANTE**:
Si ves una línea entre Persona y Perro con "1..*" cerca de Persona y "0..1" cerca de Perro:
```json
{
  "id": "edge-1",
  "sourceName": "Persona",
  "targetName": "Perro",
  "labels": ["1..*", "0..1"]
}
```
NO crees dos edges separadas. Es una sola línea física.

**IMPORTANTE**: 
- sourceName y targetName deben ser nombres exactos de clases detectadas
- Para cada relación, identifica CLARAMENTE qué símbolo está en qué extremo
- NO uses "unknown" a menos que sea completamente imposible determinarlo
- Cuenta líneas físicas, no etiquetas

NO escribas texto fuera del JSON.
"""

    # ===============================================================
    # 🚀 Enviar imagen a Gemini
    # ===============================================================
    data = {
        "contents": [
            {
                "parts": [
                    {"text": prompt_text},
                    {"inline_data": {"mime_type": mime_type, "data": image_base64}},
                ]
            }
        ]
    }

    result = _request_gemini(data, read_timeout=120)
    text_output = _extract_text(result)
    text_output = re.sub(r"^```json\s*|\s*```$", "",
                         text_output.strip(), flags=re.MULTILINE)
    try:
        parsed = json.loads(text_output)
    except (TypeError, json.JSONDecodeError) as exc:
        raise GeminiResponseError(
            "Gemini devolvio una estructura UML invalida"
        ) from exc

    # Postprocesar relaciones segun reglas deterministicas
    return _map_edges_to_relationships(parsed)

# ===============================================================
# 🔸 Clasificar conectores visuales → tipo UML
# ===============================================================


def _edge_to_relationship_type(edge):
    """
    Determina el tipo de relación UML a partir de los rasgos visuales detectados por Gemini.
    Retorna (tipo_relacion, posicion_del_simbolo)
    """
    head = edge.get("head", {})
    tail = edge.get("tail", {})
    line = edge.get("line", {})

    head_shape = head.get("shape")
    head_fill = head.get("fill")
    head_size = head.get("size")
    tail_shape = tail.get("shape")
    tail_diamond = tail.get("diamond")
    tail_fill = tail.get("fill")
    line_style = line.get("style")

    # 🔸 Reglas determinísticas
    
    # Verificar rombos en TAIL (composition/aggregation)
    if tail_diamond == "black" or (tail_shape == "diamond" and tail_fill == "black"):
        return "composition", "tail"
    if tail_diamond == "white" or (tail_shape == "diamond" and (tail_fill in ["white", "none", None])):
        return "aggregation", "tail"
    
    # Verificar rombos en HEAD (composition/aggregation)
    if head_shape == "diamond":
        if head_fill == "solid" or head_fill == "black":
            return "composition", "head"
        else:
            return "aggregation", "head"
    
    # Verificar línea punteada (dependency)
    if line_style == "dashed":
        return "dependency", "none"

    # Verificar triángulos en HEAD (generalization)
    if head_shape == "triangle":
        if head_fill == "none" or head_fill == "white" or head_size == "large":
            return "generalization", "head"
    
    # Verificar triángulos en TAIL (generalization)
    if tail_shape == "triangle":
        if tail_fill == "none" or tail_fill == "white":
            return "generalization", "tail"

    # Por defecto: association
    return "association", "none"


def _map_edges_to_relationships(parsed_json):
    """
    Convierte los edges detectados por Gemini en relaciones UML bien orientadas.
    Corrige dirección si los símbolos están en el lado contrario.
    """
    nodes = parsed_json.get("nodes", [])
    edges = parsed_json.get("edges_raw", [])

    # Crear IDs por nombre
    name_to_id = {n.get("name"): (n.get("id") or str(uuid4())) for n in nodes}

    classes = [
        {
            "id": name_to_id[n.get("name")],
            "name": n.get("name"),
            "attributes": n.get("attributes", []),
            "methods": n.get("methods", []),
        }
        for n in nodes
    ]

    relationships = []
    seen_relationships = set()  # Para evitar duplicados
    relationship_labels = {}  # Para acumular labels de relaciones bidireccionales

    for e in edges:
        rel_type, symbol_position = _edge_to_relationship_type(e)
        src = e.get("sourceName")
        tgt = e.get("targetName")
        labels = e.get("labels", [])

        if not src or not tgt:
            continue

        # 🔹 Corrección automática de dirección según posición del símbolo
        # 
        # REGLAS UML:
        # - AGGREGATION: El rombo blanco está en el lado del TODO/CONTENEDOR
        #   Ejemplo: Si Persona◇---Comida, entonces Persona contiene Comida
        #   Si el rombo está en tail (Comida◇---Persona), invertir para que sea Persona→Comida
        #
        # - COMPOSITION: El rombo negro está en el lado del TODO/CONTENEDOR
        #   Mantener dirección tal como Gemini la detecta (NO invertir)
        #
        # - GENERALIZATION: El triángulo apunta a la CLASE BASE/PADRE
        #   Ejemplo: Si Perro---▷Gato, entonces Perro hereda de Gato
        #   Si el triángulo está en head, la dirección es correcta (Perro→Gato)
        
        if rel_type == "aggregation":
            # Si el rombo blanco está en tail (origen), NO invertir (ya está correcto)
            # Si el rombo blanco está en head (destino), SÍ invertir
            if symbol_position == "head":
                src, tgt = tgt, src
        elif rel_type == "composition":
            # Para composition NO invertir nunca, mantener dirección original
            pass
        elif rel_type == "generalization":
            # Si el triángulo está en head (destino), NO invertir (apunta al padre)
            # Si el triángulo está en tail (origen), SÍ invertir
            if symbol_position == "tail":
                src, tgt = tgt, src
        # Para association y dependency no hay corrección de dirección necesaria
        
        src_id = name_to_id.get(src)
        tgt_id = name_to_id.get(tgt)
        
        # Crear claves para detectar duplicados (considerando bidireccionalidad)
        rel_key = f"{src_id}-{tgt_id}-{rel_type}"
        rel_key_reverse = f"{tgt_id}-{src_id}-{rel_type}"
        
        # Verificar si ya existe esta relación o su inversa
        if rel_key in seen_relationships:
            # Ya existe, solo acumular labels si hay
            if labels:
                clean_labels = [label for label in labels if label is not None and label != "null" and label != ""]
                if clean_labels and rel_key in relationship_labels:
                    relationship_labels[rel_key].extend(clean_labels)
            continue
        
        if rel_key_reverse in seen_relationships:
            # Existe la relación inversa, acumular labels
            if labels:
                clean_labels = [label for label in labels if label is not None and label != "null" and label != ""]
                if clean_labels and rel_key_reverse in relationship_labels:
                    relationship_labels[rel_key_reverse].extend(clean_labels)
            continue
        
        seen_relationships.add(rel_key)
        
        # Limpiar labels (eliminar nulls, vacíos y duplicados)
        clean_labels = [label for label in labels if label is not None and label != "null" and label != ""]
        relationship_labels[rel_key] = clean_labels

        relationships.append(
            {
                "id": e.get("id") or str(uuid4()),
                "type": rel_type,
                "sourceId": src_id,
                "targetId": tgt_id,
                "labels": clean_labels,
            }
        )
    
    # Actualizar labels acumuladas en las relaciones finales
    for rel in relationships:
        rel_key = f"{rel['sourceId']}-{rel['targetId']}-{rel['type']}"
        if rel_key in relationship_labels:
            # Eliminar duplicados manteniendo el orden
            rel['labels'] = list(dict.fromkeys(relationship_labels[rel_key]))

    return {"classes": classes, "relationships": relationships}
