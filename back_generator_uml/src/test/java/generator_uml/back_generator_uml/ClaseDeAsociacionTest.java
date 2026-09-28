package generator_uml.back_generator_uml;

import com.github.mustachejava.DefaultMustacheFactory;
import generator_uml.back_generator_uml.entity.*;
import generator_uml.back_generator_uml.service.PostmanCollectionGenerator;
import generator_uml.back_generator_uml.service.ProjectGenerator;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.zeroturnaround.zip.ZipUtil;

import java.nio.file.*;
import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

/**
 * Una clase de asociación (la que cuelga de una relación N:M para darle atributos
 * propios) tiene que salir como UNA entidad intermedia con el nombre que le puso el
 * usuario, no como dos tablas equivocadas.
 *
 * El diagrama de prueba es el de la empresa: Venta *..* Producto con "Item" colgando,
 * más Cliente 1..* Venta para comprobar que lo demás sigue igual.
 */
class ClaseDeAsociacionTest {

    private static Path proyecto;

    @BeforeAll
    static void generar() throws Exception {
        Path zip = new ProjectGenerator(new DefaultMustacheFactory(), new PostmanCollectionGenerator())
                .generate(diagramaEmpresa(), "com.example.demo", "demo");

        proyecto = Files.createTempDirectory("test-gen");
        ZipUtil.unpack(zip.toFile(), proyecto.toFile());
    }

    /** Lee un archivo generado, o falla indicando cuál falta. */
    private static String leer(String rutaRelativa) {
        Path p = proyecto.resolve(rutaRelativa);
        assertTrue(Files.exists(p), "no se generó " + rutaRelativa);
        try {
            return Files.readString(p);
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    private static Path modelo(String nombre) {
        return proyecto.resolve("src/main/java/com/example/demo/model/" + nombre + ".java");
    }

    @Test
    @DisplayName("la entidad intermedia se llama como la clase de asociación")
    void usaElNombreDelUsuario() {
        assertTrue(Files.exists(modelo("Item")), "falta Item.java");
        assertFalse(Files.exists(modelo("ProductoVenta")),
                "no debería inventar ProductoVenta cuando el usuario ya nombró la clase");
    }

    @Test
    @DisplayName("no queda además una entidad suelta duplicada")
    void noDuplicaLaClase() throws Exception {
        try (var archivos = Files.list(proyecto.resolve("src/main/java/com/example/demo/model"))) {
            List<String> nombres = archivos.map(p -> p.getFileName().toString()).sorted().toList();
            assertEquals(List.of("Cliente.java", "Item.java", "Producto.java", "Venta.java"), nombres);
        }
    }

    @Test
    @DisplayName("Item lleva los atributos que escribió el usuario")
    void conservaLosAtributos() {
        String item = leer("src/main/java/com/example/demo/model/Item.java");
        assertTrue(item.contains("private Integer cantidad;"), "falta cantidad:\n" + item);
        assertTrue(item.contains("private Double descuento;"), "falta descuento:\n" + item);
    }

    @Test
    @DisplayName("Item tiene clave propia y las dos foráneas (opción A)")
    void claveSinteticaYForaneas() {
        String item = leer("src/main/java/com/example/demo/model/Item.java");
        assertTrue(item.contains("@Id"), "Item debe tener @Id");
        assertTrue(item.contains("private Long id;"), "la PK de Item es un Long propio");
        assertTrue(item.contains("private Venta venta;"), "falta la relación hacia Venta");
        assertTrue(item.contains("private Producto producto;"), "falta la relación hacia Producto");
        // cantidad no puede ser la PK: ese era el bug
        assertFalse(item.matches("(?s).*@Id\\s*+private Integer cantidad.*"),
                "cantidad no debe ser clave primaria");
    }

    @Test
    @DisplayName("el par de foráneas queda protegido por una restricción única")
    void restriccionUnica() {
        String item = leer("src/main/java/com/example/demo/model/Item.java");
        assertTrue(item.contains("@Table(uniqueConstraints = @UniqueConstraint(columnNames = {\"producto_id\", \"venta_id\"}))")
                        || item.contains("@Table(uniqueConstraints = @UniqueConstraint(columnNames = {\"venta_id\", \"producto_id\"}))"),
                "falta el @Table con la restricción única:\n" + item);
    }

    @Test
    @DisplayName("Venta y Producto apuntan a Item, no a una entidad inventada")
    void lasDosPuntasApuntanAItem() {
        String venta = leer("src/main/java/com/example/demo/model/Venta.java");
        String producto = leer("src/main/java/com/example/demo/model/Producto.java");

        assertTrue(venta.contains("List<Item>"), "Venta debe tener una colección de Item:\n" + venta);
        assertTrue(venta.contains("mappedBy = \"venta\""), "mappedBy incorrecto en Venta:\n" + venta);

        assertTrue(producto.contains("List<Item>"), "Producto debe tener una colección de Item:\n" + producto);
        assertTrue(producto.contains("mappedBy = \"producto\""), "mappedBy incorrecto en Producto:\n" + producto);

        assertFalse(venta.contains("ProductoVenta"), "quedó una referencia a la entidad inventada");
    }

    @Test
    @DisplayName("se genera el CRUD completo de Item")
    void crudCompleto() {
        assertTrue(Files.exists(proyecto.resolve("src/main/java/com/example/demo/repository/ItemRepository.java")));
        assertTrue(Files.exists(proyecto.resolve("src/main/java/com/example/demo/service/ItemService.java")));

        String controller = leer("src/main/java/com/example/demo/controller/ItemController.java");
        assertTrue(controller.contains("@RequestMapping(\"/api/item\")"), controller);
        // La PK es simple, así que la ruta es la misma forma que la del resto
        assertTrue(controller.contains("@GetMapping(\"/{id}\")"));
        assertTrue(controller.contains("@PathVariable(\"id\") Long id"), controller);
    }

    @Test
    @DisplayName("la colección de Postman documenta Item una sola vez")
    void postmanCoherente() {
        String postman = leer("demo-postman-collection.json");

        assertTrue(postman.contains("/api/item"), "Postman debe apuntar a /api/item");
        assertFalse(postman.contains("productoventa"),
                "Postman no debe apuntar a la entidad inventada");

        // Una sola carpeta para Item: la de la relación
        int carpetas = postman.split("\"name\" : \"Item", -1).length - 1;
        assertEquals(1, carpetas, "Item aparece " + carpetas + " veces como carpeta");

        // El cuerpo del POST tiene que traer los atributos propios. Va embebido como
        // string dentro del JSON, así que sus comillas están escapadas.
        String cuerpos = postman.replace("\\\"", "\"");
        assertTrue(cuerpos.contains("\"cantidad\""), "falta cantidad en el body de Postman");
        assertTrue(cuerpos.contains("\"descuento\""), "falta descuento en el body de Postman");
        assertTrue(cuerpos.contains("\"ventaid\"") && cuerpos.contains("\"productoid\""),
                "faltan las dos foráneas en el body de Postman");
    }

    @Test
    @DisplayName("sin clase colgada, la entidad intermedia se sigue inventando como antes")
    void relacionNmSinClaseDeAsociacion() throws Exception {
        // El comportamiento viejo tiene que sobrevivir: es el que se usa cuando el
        // docente dibuja un N:M pelado, sin atributos en el medio.
        UmlClass venta = clase("c2", "Venta", attr("id", "Int"));
        UmlClass producto = clase("c3", "Producto", attr("id", "Int"));

        UmlSchema schema = new UmlSchema();
        schema.setClasses(List.of(venta, producto));
        schema.setRelationships(List.of(rel("r1", "association", "c2", "c3", "1..*", "1..*")));

        Path zip = new ProjectGenerator(new DefaultMustacheFactory(), new PostmanCollectionGenerator())
                .generate(schema, "com.example.demo", "demo");
        Path salida = Files.createTempDirectory("test-gen-sin-assoc");
        ZipUtil.unpack(zip.toFile(), salida.toFile());

        Path modelos = salida.resolve("src/main/java/com/example/demo/model");
        assertTrue(Files.exists(modelos.resolve("ProductoVenta.java")),
                "sin clase de asociación se sigue inventando ProductoVenta");

        String intermedia = Files.readString(modelos.resolve("ProductoVenta.java"));
        assertTrue(intermedia.contains("private Long id;"));
        assertTrue(intermedia.contains("@Table(uniqueConstraints"),
                "la restricción única también aplica acá");
    }

    // ==================================================================
    // Diagrama de prueba
    // ==================================================================

    private static UmlSchema diagramaEmpresa() {
        UmlClass cliente = clase("c1", "Cliente", attr("id", "Int"), attr("nombre", "String"));
        UmlClass venta = clase("c2", "Venta", attr("id", "Int"), attr("fecha", "Date"));
        UmlClass producto = clase("c3", "Producto", attr("id", "Int"), attr("precio", "Float"));
        UmlClass item = clase("c4", "Item", attr("cantidad", "Int"), attr("descuento", "Double"));

        // Venta *..* Producto, con Item colgando del conector
        UmlRelationship nm = rel("r1", "association", "c2", "c3", "1..*", "1..*");
        UmlRelationship colgada = rel("r2", "associationClass", "r1", "c4");
        UmlRelationship clienteVenta = rel("r3", "association", "c1", "c2", "1", "1..*");

        UmlSchema schema = new UmlSchema();
        schema.setClasses(List.of(cliente, venta, producto, item));
        schema.setRelationships(List.of(nm, colgada, clienteVenta));
        return schema;
    }

    private static UmlClass clase(String id, String nombre, UmlAttribute... attrs) {
        UmlClass c = new UmlClass();
        c.setId(id);
        c.setName(nombre);
        c.setAttributes(List.of(attrs));
        c.setMethods(List.of());
        return c;
    }

    private static UmlAttribute attr(String nombre, String tipo) {
        UmlAttribute a = new UmlAttribute();
        a.setName(nombre);
        a.setType(tipo);
        return a;
    }

    private static UmlRelationship rel(String id, String tipo, String source, String target, String... labels) {
        UmlRelationship r = new UmlRelationship();
        r.setId(id);
        r.setType(tipo);
        r.setSourceId(source);
        r.setTargetId(target);
        r.setLabels(List.of(labels));
        return r;
    }
}
