package generator_uml.back_generator_uml.entity;

import lombok.Data;
import java.util.List;

@Data
public class UmlRelationship {
    private String id;
    private String type;
    private String sourceId;
    private String targetId;
    private List<String> labels;
}

