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
 * El pom del proyecto generado tiene que producir siempre la misma construccion.
 *
 * El proyecto no hereda de spring-boot-starter-parent: usa dependencyManagement con
 * spring-boot-dependencies importado, y eso fija versiones de dependencias pero NO de
 * plugins. Si el plugin de Spring Boot queda sin version, Maven descarga la ultima que
 * exista en ese momento y el mismo ZIP se construye distinto segun el dia.
 *
 * Paso de verdad: en la maquina de desarrollo aparecieron dos versiones descargadas del
 * plugin (3.5.5 y 4.2.0-M1, esta ultima preliminar) para el mismo pom.
 */
class PomGeneradoTest {

    private static String pom;

    @BeforeAll
    static void generar() throws Exception {
        UmlClass c = new UmlClass();
        c.setId("c1");
        c.setName("Cliente");
        UmlAttribute a = new UmlAttribute();
        a.setName("id");
        a.setType("Int");
        c.setAttributes(List.of(a));
        c.setMethods(List.of());

        UmlSchema schema = new UmlSchema();
        schema.setClasses(List.of(c));
        schema.setRelationships(List.of());

        Path zip = new ProjectGenerator(new DefaultMustacheFactory(), new PostmanCollectionGenerator())
                .generate(schema, "com.example.demo", "demo");
        Path salida = Files.createTempDirectory("test-pom");
        ZipUtil.unpack(zip.toFile(), salida.toFile());

        pom = Files.readString(salida.resolve("pom.xml"));
    }

    @Test
    @DisplayName("el plugin de Spring Boot lleva version fija")
    void pluginConVersion() {
        int inicio = pom.indexOf("<artifactId>spring-boot-maven-plugin</artifactId>");
        assertTrue(inicio > 0, "no se encontro el plugin en el pom:\n" + pom);

        String resto = pom.substring(inicio, pom.indexOf("</plugin>", inicio));
        assertTrue(resto.contains("<version>"),
                "el plugin quedo sin version, Maven va a bajar la ultima que exista:\n" + resto);
    }

    @Test
    @DisplayName("la version del plugin es la misma que la del resto de Spring Boot")
    void versionCoherente() {
        int inicio = pom.indexOf("<artifactId>spring-boot-maven-plugin</artifactId>");
        String resto = pom.substring(inicio, pom.indexOf("</plugin>", inicio));

        // Se usa la propiedad, no un numero suelto: asi no hay dos versiones que
        // mantener en paralelo.
        assertTrue(resto.contains("<version>${spring.boot.version}</version>"),
                "el plugin deberia usar la propiedad spring.boot.version:\n" + resto);
        assertTrue(pom.contains("<spring.boot.version>"),
                "falta la propiedad spring.boot.version en el pom");
    }
}
