package generator_uml.back_generator_uml.service;

import generator_uml.back_generator_uml.entity.UmlAttribute;
import generator_uml.back_generator_uml.entity.UmlClass;
import generator_uml.back_generator_uml.entity.UmlMethod;
import generator_uml.back_generator_uml.entity.UmlRelationship;
import generator_uml.back_generator_uml.entity.UmlSchema;

import java.util.*;
import java.util.stream.Collectors;

public class JsonNormalizer {

    public static UmlSchema normalize(UmlSchema schema) {
        if (schema == null) return null;

        // Normalizar clases
        List<UmlClass> classes = schema.getClasses().stream().map(JsonNormalizer::normalizeClass).collect(Collectors.toList());

        // Normalizar relaciones
        List<UmlRelationship> relationships = schema.getRelationships().stream().map(JsonNormalizer::normalizeRelationship).collect(Collectors.toList());

        UmlSchema normalized = new UmlSchema();
        normalized.setClasses(classes);
        normalized.setRelationships(relationships);

        return normalized;
    }

    private static UmlClass normalizeClass(UmlClass c) {
        UmlClass nc = new UmlClass();
        nc.setId(c.getId());
        nc.setName(capitalize(c.getName())); // Clase con mayúscula inicial

        // Atributos
        List<UmlAttribute> attrs = c.getAttributes().stream().map(a -> {
            UmlAttribute na = new UmlAttribute();
            na.setName(toCamelCase(a.getName())); // nombre en camelCase
            na.setType(TypeMapper.toJava(a.getType())); // normaliza tipo
            return na;
        }).collect(Collectors.toList());
        nc.setAttributes(attrs);

        // Métodos
        List<UmlMethod> methods = c.getMethods().stream().map(m -> {
            UmlMethod nm = new UmlMethod();
            nm.setName(toCamelCase(m.getName()));
            nm.setReturnType(TypeMapper.toJava(m.getReturnType()));

            // Normalizar parámetros "nombre:Tipo"
            if (m.getParameters() != null && !m.getParameters().isBlank()) {
                String[] parts = m.getParameters().split(",");
                String normalizedParams = Arrays.stream(parts).map(p -> {
                    String[] kv = p.split(":");
                    if (kv.length == 2) {
                        String paramName = toCamelCase(kv[0].trim());
                        String paramType = TypeMapper.toJava(kv[1].trim());
                        return paramType + " " + paramName;
                    } else {
                        return p.trim();
                    }
                }).collect(Collectors.joining(", "));
                nm.setParameters(normalizedParams);
            } else {
                nm.setParameters("");
            }

            return nm;
        }).collect(Collectors.toList());
        nc.setMethods(methods);

        return nc;
    }

    private static UmlRelationship normalizeRelationship(UmlRelationship r) {
        if (r.getLabels() == null || r.getLabels().isEmpty()) {
            r.setLabels(List.of("1", "1"));
        }
        return r;
    }

    private static String capitalize(String s) {
        if (s == null || s.isBlank()) return s;
        return s.substring(0, 1).toUpperCase() + s.substring(1).toLowerCase();
    }

    private static String toCamelCase(String s) {
        if (s == null || s.isBlank()) return s;
        s = s.trim();
        return s.substring(0, 1).toLowerCase() + s.substring(1);
    }
}
