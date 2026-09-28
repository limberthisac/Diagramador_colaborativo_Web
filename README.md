# Diagramador UML Colaborativo

Herramienta CASE web para modelar diagramas de clases UML en equipo y en tiempo real, y generar a partir de ellos la base de datos y un backend listo para ejecutar.

**Aplicación desplegada:** https://diagramadorcolaborativo.netlify.app/

## Funcionalidades

**Modelado UML**
- Clases con nombre, atributos y métodos, editables directamente en el lienzo.
- Relaciones: asociación, agregación, composición, generalización, dependencia y clase de asociación (para el muchos a muchos), con multiplicidades y etiquetas.
- Zoom, desplazamiento, copiar, pegar, duplicar y cortar.

**Colaboración**
- Salas identificadas por un código: quien lo recibe entra al mismo lienzo.
- Los cambios se propagan en vivo entre los participantes.
- Indicador de las personas conectadas a la sala.
- Respaldo del diagrama en el servidor al salir de la sala, que se recupera al volver a entrar.

**Inteligencia artificial** (Google Gemini)
- Asistente que crea o modifica el diagrama a partir de una descripción en texto o por voz.
- Importación de un diagrama desde una imagen.
- Análisis del modelo para detectar relaciones incorrectas.

**Importación y exportación**
- Importación desde Enterprise Architect (XMI).
- Exportación a imagen PNG, script SQL (PostgreSQL), colección de Postman y XML para Enterprise Architect.
- Generación de un proyecto backend Spring Boot comprimido en ZIP.

## Arquitectura

El repositorio contiene tres proyectos:

| Carpeta | Tecnología | Responsabilidad |
|---|---|---|
| `front_generador_bd/` | Angular 20, JointJS, Tailwind CSS | Editor web: lienzo, paneles, exportaciones e importaciones |
| `back_generador_bd/` | Django 5.2, Django REST Framework, Channels, Redis, PostgreSQL | Salas en tiempo real por WebSocket, servicios de IA y respaldo de diagramas |
| `back_generator_uml/` | Spring Boot 3.5, Java 21 | Generación del proyecto backend Spring Boot a partir del diagrama |

```
Navegador (Angular)
 ├── WebSocket  ──► Django Channels ──► Redis        (salas y cambios en vivo)
 ├── WebRTC     ◄─► otros participantes              (canal directo entre navegadores)
 ├── HTTP       ──► Django REST     ──► PostgreSQL   (IA y respaldo)
 └── HTTP       ──► Spring Boot                      (proyecto generado en ZIP)
```

Django hace de servidor de señalización: los navegadores se encuentran por la sala del WebSocket y luego intercambian los cambios del diagrama por un canal WebRTC directo.

### Servicios del backend Django

| Ruta | Uso |
|---|---|
| `POST /api/chatbot/` | Genera o modifica el diagrama a partir de un texto |
| `POST /api/uml_from_image/` | Extrae un diagrama de una imagen |
| `POST /api/set_backup_uml/<sala>/` | Guarda el respaldo de una sala |
| `GET /api/get_backup_uml/<sala>/` | Recupera el respaldo de una sala |
| `ws/canvas/<sala>/` | Sala colaborativa |
| `ws/uml/` | Análisis del modelo con IA |

El backend Spring Boot expone `POST /generate`, que recibe el diagrama y devuelve el proyecto en ZIP.

## Ejecución en local

### Requisitos

- Node.js 20 o superior
- Python 3.11 o superior
- Java 21
- Redis y PostgreSQL, o Docker para levantarlos
- Una clave de la API de Google Gemini

### 1. Backend Django

Crear `back_generador_bd/.env`:

```
GEMINI_API_KEY=tu_clave
```

**Con Docker** (desde la raíz del repositorio):

```bash
docker network create backend
docker compose -f docker-compose.db.yml up -d      # PostgreSQL (puerto 5433) y pgAdmin (5050)
docker compose -f docker-compose.app.yml up --build django redis
```

**Sin Docker**, con Redis en el puerto 6379 y PostgreSQL en el 5433 (base `uml_bd`):

```bash
cd back_generador_bd
python -m venv venv
venv\Scripts\activate            # En Linux o macOS: source venv/bin/activate
pip install -r requirements.txt
python manage.py makemigrations uml_api
python manage.py migrate
python manage.py runserver 8000
```

La conexión a la base se configura con las variables `PGHOST`, `PGPORT`, `PGUSER`, `PGPASSWORD` y `PGDATABASE`. Sin ellas se usan los valores locales de `docker-compose.db.yml`.

> Las migraciones no se versionan (están en `.gitignore`). En una base de datos nueva hay que ejecutar `makemigrations uml_api` antes de `migrate`.

### 2. Frontend Angular

```bash
cd front_generador_bd
npm install
npm start
```

Abrir http://localhost:4200.

Al ejecutarse en `localhost`, la colaboración se conecta al Django local en `ws://localhost:8000`, así que el paso 1 debe estar en marcha. Los servicios HTTP (IA y respaldo) y el generador Spring Boot apuntan a las URL configuradas en `src/environments/`.

### 3. Generador Spring Boot (opcional)

```bash
cd back_generator_uml
mvnw spring-boot:run             # En Linux o macOS: ./mvnw spring-boot:run
```

Escucha en el puerto definido por la variable `PORT` (8080 si no se define).

## Despliegue

| Componente | Plataforma |
|---|---|
| Frontend | Netlify |
| Backend Django, Redis y PostgreSQL | Railway |
| Generador Spring Boot | Railway |

Las URL de producción están en `front_generador_bd/src/environments/`. Cuando la aplicación se sirve por HTTPS, el WebSocket usa `wss://` hacia el backend Django de Railway.
