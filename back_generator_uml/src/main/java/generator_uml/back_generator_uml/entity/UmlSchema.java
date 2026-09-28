package generator_uml.back_generator_uml.entity;

import lombok.Data;
import java.util.List;

@Data
public class UmlSchema {
    private List<UmlClass> classes;
    private List<UmlRelationship> relationships;
}

