package generator_uml.back_generator_uml.entity;

import lombok.Data;
import java.util.List;

@Data
public class UmlClass {
    private String id;
    private String name;
    private List<UmlAttribute> attributes;
    private List<UmlMethod> methods;
}
