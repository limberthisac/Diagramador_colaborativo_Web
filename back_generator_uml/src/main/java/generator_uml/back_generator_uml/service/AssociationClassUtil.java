package generator_uml.back_generator_uml.service;

import generator_uml.back_generator_uml.entity.UmlClass;
import generator_uml.back_generator_uml.entity.UmlSchema;

import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;

/**
 * Clases de asociación: la clase que el usuario cuelga de una relación N:M para
 * darle atributos propios (por ejemplo "Item" colgando de Venta *..* Producto).
 *
 * El diagramador las manda como una relación aparte, de tipo "associationClass",
 * donde el {@code sourceId} es el **id del conector** N:M —no el de una clase— y
 * el {@code targetId} es la clase colgada.
 *
 * Sin esto, el generador producía dos tablas equivocadas para un mismo concepto:
 * una entidad intermedia inventada ("ProductoVenta") sin los atributos que el
 * usuario había escrito, y además la clase colgada suelta, sin relación con nada
 * y tomando su primer atributo como clave primaria.
 */
public final class AssociationClassUtil {

    private AssociationClassUtil() {
    }

    /**
     * Indexa las clases de asociación por el id del conector del que cuelgan.
     * La clave es el id de la relación N:M, así que cada sitio que procesa esa
     * relación puede preguntar si alguien le colgó una clase.
     */
    public static Map<String, UmlClass> porConector(UmlSchema schema) {
        Map<String, UmlClass> index = new HashMap<>();
        if (schema.getRelationships() == null || schema.getClasses() == null) return index;

        for (var rel : schema.getRelationships()) {
            if (!"associationClass".equals(rel.getType())) continue;
            schema.getClasses().stream()
                    .filter(cl -> cl.getId().equals(rel.getTargetId()))
                    .findFirst()
                    .ifPresent(cl -> index.put(rel.getSourceId(), cl));
        }
        return index;
    }

    /**
     * Ids de las clases que son de asociación. Sirve para saltearlas en el bucle
     * que genera una entidad por clase: no van como entidad suelta, sino como la
     * entidad intermedia de su relación.
     */
    public static Set<String> ids(UmlSchema schema) {
        Set<String> ids = new HashSet<>();
        for (UmlClass c : porConector(schema).values()) ids.add(c.getId());
        return ids;
    }

    /**
     * Nombre de la entidad intermedia de una relación N:M.
     *
     * Si el usuario colgó una clase de asociación, se usa el nombre que él le
     * puso. Si no, se inventa concatenando las dos entidades en orden alfabético,
     * que es lo que el generador hacía siempre.
     *
     * Toda la generación tiene que pasar por acá: el nombre aparece en la entidad,
     * en el {@code mappedBy} de las dos puntas y en la colección de Postman, y si
     * dos sitios no coinciden el proyecto generado no compila.
     */
    public static String nombreIntermedia(String sourceEntity, String targetEntity, UmlClass asociacion) {
        if (asociacion != null) return NamingUtil.toJavaClass(asociacion.getName());
        return sourceEntity.compareTo(targetEntity) < 0
                ? sourceEntity + targetEntity
                : targetEntity + sourceEntity;
    }
}
