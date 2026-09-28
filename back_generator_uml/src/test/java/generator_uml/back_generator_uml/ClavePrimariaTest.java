package generator_uml.back_generator_uml;

import com.github.mustachejava.DefaultMustacheFactory;
import generator_uml.back_generator_uml.entity.*;
import generator_uml.back_generator_uml.service.PostmanCollectionGenerator;
import generator_uml.back_generator_uml.service.ProjectGenerator;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.zeroturnaround.zip.ZipUtil;

import java.nio.file.*;
import java.util.List;

import static org.junit.jupiter.api.Assertions.*;

/**
 * La anotación {@code @JsonIdentityInfo} le dice a Jackson por qué propiedad
 * identificar cada objeto al serializarlo. Tiene que nombrar la clave primaria real
 * de la clase, que es el primer atributo que dibujó el usuario y no siempre se llama
 * "id".
 *
 * Si no coinciden, Jackson no encuentra la propiedad y la entidad falla al
 * serializarse: en Postman se ve como un error 500 en el GET, no como un dato mal
 * formateado. Importa porque el diagrama del examen lo dibuja el docente, y puede
 * nombrar la clave "id_cliente", "codigo" o "cedula".
 */
class ClavePrimariaTest {

    /** Genera un proyecto con una sola clase y devuelve su entidad ya renderizada. */
    private static String entidadDe(String nombreClase, UmlAttribute... atributos) throws Exception {
        UmlClass c = new UmlClass();
        c.setId("c1");
        c.setName(nombreClase);
        c.setAttributes(List.of(atributos));
        c.setMethods(List.of());

        UmlSchema schema = new UmlSchema();
        schema.setClasses(List.of(c));
        schema.setRelationships(List.of());

        Path zip = new ProjectGenerator(new DefaultMustacheFactory(), new PostmanCollectionGenerator())
                .generate(schema, "com.example.demo", "demo");
        Path salida = Files.createTempDirectory("test-pk");
        ZipUtil.unpack(zip.toFile(), salida.toFile());

        return Files.readString(salida.resolve(
                "src/main/java/com/example/demo/model/" + nombreClase + ".java"));
    }

    private static UmlAttribute attr(String nombre, String tipo) {
        UmlAttribute a = new UmlAttribute();
        a.setName(nombre);
        a.setType(tipo);
        return a;
    }

    @Test
    @DisplayName("clave llamada 'id': sigue saliendo igual que siempre")
    void claveLlamadaId() throws Exception {
        String entidad = entidadDe("Cliente", attr("id", "Int"), attr("nombre", "String"));

        assertTrue(entidad.contains("property = \"id\""), entidad);
        assertTrue(entidad.contains("private Long id;"), entidad);
    }

    @Test
    @DisplayName("clave llamada 'id_cliente': la anotación usa el nombre real, en camelCase")
    void claveConGuionBajo() throws Exception {
        String entidad = entidadDe("Cliente", attr("id_cliente", "Int"), attr("nombre", "String"));

        // El campo Java se llama idCliente; Jackson busca propiedades Java, no columnas,
        // así que la anotación tiene que decir exactamente eso.
        assertTrue(entidad.contains("private Long idCliente;"), entidad);
        assertTrue(entidad.contains("property = \"idCliente\""),
                "la anotación quedó apuntando a una propiedad que no existe:\n" + entidad);
        assertFalse(entidad.contains("property = \"id\","),
                "no puede seguir diciendo \"id\" fijo:\n" + entidad);
    }

    @Test
    @DisplayName("clave con otro nombre cualquiera: también la respeta")
    void claveConNombrePropio() throws Exception {
        String entidad = entidadDe("Mascota", attr("codigo", "String"), attr("raza", "String"));

        assertTrue(entidad.contains("property = \"codigo\""), entidad);
        // Una clave de texto no se autogenera
        assertTrue(entidad.contains("private String codigo;"), entidad);
        assertFalse(entidad.contains("@GeneratedValue"), entidad);
    }

    @Test
    @DisplayName("la clave es el primer atributo que sirve, no necesariamente el primero")
    void primerAtributoUtilizable() throws Exception {
        // Un decimal no puede ser clave, así que el generador sigue buscando. La
        // anotación tiene que nombrar al que finalmente quedó.
        String entidad = entidadDe("Lectura", attr("valor", "Float"), attr("nro_serie", "Int"));

        assertTrue(entidad.contains("property = \"nroSerie\""), entidad);
        assertTrue(entidad.contains("private Long nroSerie;"), entidad);
        assertTrue(entidad.contains("private Float valor;"), entidad);
    }

    @Test
    @DisplayName("clase sin clave primaria: no se emite la anotación")
    void sinClavePrimaria() throws Exception {
        // El generador recorre los atributos y toma como clave el primero que sea
        // entero o de texto. Si ninguno lo es —acá los dos son decimales—, la clase
        // queda sin clave y la anotación no tendría ninguna propiedad que nombrar.
        String entidad = entidadDe("Medicion", attr("valor", "Float"), attr("margen", "Double"));

        assertFalse(entidad.contains("@JsonIdentityInfo"),
                "sin clave primaria la anotación no debe emitirse:\n" + entidad);
    }
}
