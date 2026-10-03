package generator_uml.back_generator_uml;

import com.github.mustachejava.DefaultMustacheFactory;
import generator_uml.back_generator_uml.entity.UmlAttribute;
import generator_uml.back_generator_uml.entity.UmlClass;
import generator_uml.back_generator_uml.entity.UmlRelationship;
import generator_uml.back_generator_uml.entity.UmlSchema;
import generator_uml.back_generator_uml.service.PostmanCollectionGenerator;
import generator_uml.back_generator_uml.service.ProjectGenerator;
import org.junit.jupiter.api.Test;
import org.zeroturnaround.zip.ZipUtil;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;

import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

class RelacionRecursivaTest {

    @Test
    void generaRelacionUnoAMuchosConRolesDistintos() throws Exception {
        Path project = generate("1", "0..*", "supervisor", "subordinates");
        String employee = Files.readString(project.resolve(
                "src/main/java/com/example/demo/model/Employee.java"));

        assertTrue(employee.contains("private Employee supervisor;"), employee);
        assertTrue(employee.contains("private List<Employee> subordinates"), employee);
        assertTrue(employee.contains("mappedBy = \"supervisor\""), employee);
    }

    @Test
    void generaEntidadIntermediaRecursivaConDosCamposDistintos() throws Exception {
        Path project = generate("0..*", "0..*", "mentor", "mentee");
        String link = Files.readString(project.resolve(
                "src/main/java/com/example/demo/model/EmployeeMentorMentee.java"));

        assertTrue(link.contains("private Employee mentor;"), link);
        assertTrue(link.contains("private Employee mentee;"), link);
        assertTrue(link.contains("{\"mentor_id\", \"mentee_id\"}"), link);
    }

    @Test
    void noGeneraUnaClaseQueSeExtiendeASiMisma() throws Exception {
        UmlSchema schema = schema("1", "1", "parent", "child");
        schema.getRelationships().get(0).setType("generalization");
        Path project = unpack(new ProjectGenerator(new DefaultMustacheFactory(), new PostmanCollectionGenerator())
                .generate(schema, "com.example.demo", "demo"));
        String employee = Files.readString(project.resolve(
                "src/main/java/com/example/demo/model/Employee.java"));

        assertFalse(employee.contains("class Employee extends Employee"), employee);
    }

    private static Path generate(String sourceCard, String targetCard,
                                 String sourceRole, String targetRole) throws Exception {
        return unpack(new ProjectGenerator(new DefaultMustacheFactory(), new PostmanCollectionGenerator())
                .generate(schema(sourceCard, targetCard, sourceRole, targetRole),
                        "com.example.demo", "demo"));
    }

    private static Path unpack(Path zip) throws Exception {
        Path output = Files.createTempDirectory("test-recursive");
        ZipUtil.unpack(zip.toFile(), output.toFile());
        return output;
    }

    private static UmlSchema schema(String sourceCard, String targetCard,
                                    String sourceRole, String targetRole) {
        UmlAttribute id = new UmlAttribute();
        id.setName("id");
        id.setType("Int");

        UmlClass employee = new UmlClass();
        employee.setId("employee");
        employee.setName("Employee");
        employee.setAttributes(List.of(id));
        employee.setMethods(List.of());

        UmlRelationship relation = new UmlRelationship();
        relation.setId("recursive");
        relation.setType("association");
        relation.setSourceId("employee");
        relation.setTargetId("employee");
        relation.setLabels(List.of(sourceCard, targetCard, sourceRole, targetRole));

        UmlSchema schema = new UmlSchema();
        schema.setClasses(List.of(employee));
        schema.setRelationships(List.of(relation));
        return schema;
    }
}
