package generator_uml.back_generator_uml.service;

import com.github.mustachejava.Mustache;
import com.github.mustachejava.MustacheFactory;
import generator_uml.back_generator_uml.entity.UmlClass;
import generator_uml.back_generator_uml.entity.UmlSchema;
import lombok.RequiredArgsConstructor;
import org.springframework.stereotype.Service;
import org.zeroturnaround.zip.ZipUtil;

import java.io.*;
import java.nio.file.*;
import java.util.*;
import java.util.stream.Collectors;

@Service
@RequiredArgsConstructor
public class ProjectGenerator {

    private final MustacheFactory mustacheFactory;
    private final PostmanCollectionGenerator postmanCollectionGenerator;

    public Path generate(UmlSchema schema, String basePackage, String artifactId) throws Exception {
        Path root = Files.createTempDirectory("gen-" + artifactId);
        Path srcMain = root.resolve("src/main/java/" + basePackage.replace(".", "/"));
        Path srcRes = root.resolve("src/main/resources");
        Files.createDirectories(srcMain);
        Files.createDirectories(srcRes);

        // pom y Application
        render("pom.mustache", Map.of(
                "groupId", "com.example",
                "artifactId", artifactId,
                "basePackage", basePackage
        ), root.resolve("pom.xml"));

        render("Application.mustache", Map.of("basePackage", basePackage),
                srcMain.resolve("GenAppApplication.java"));

        // application.properties
        Map<String, Object> props = Map.of(
                "serverPort", 9000,
                "dbHost", "localhost",
                "dbPort", "5432",
                "dbName", "mi_base",
                "dbUser", "postgres",
                "dbPassword", "123456",
                "dbDriver", "org.postgresql.Driver",
                "dbDialect", "org.hibernate.dialect.PostgreSQLDialect"
        );
        render("application-properties.mustache", props, srcRes.resolve("application.properties"));

        // carpetas
        Path modelDir = srcMain.resolve("model");
        Path repoDir  = srcMain.resolve("repository");
        Path svcDir   = srcMain.resolve("service");
        Path ctrlDir  = srcMain.resolve("controller");
        Files.createDirectories(modelDir);
        Files.createDirectories(repoDir);
        Files.createDirectories(svcDir);
        Files.createDirectories(ctrlDir);

        // normalizar
        schema = JsonNormalizer.normalize(schema);

        // ====== CLASES DE ASOCIACIÓN ======
        // Si el usuario colgó una clase de una relación N:M, esa clase ES la entidad
        // intermedia: no se inventa una y no se genera además la clase suelta.
        Map<String, UmlClass> assocPorConector = AssociationClassUtil.porConector(schema);
        Set<String> assocIds = AssociationClassUtil.ids(schema);

        // ====== DETECTAR RELACIONES MUCHOS A MUCHOS Y CREAR ENTIDADES INTERMEDIAS ======
        List<Map<String, Object>> intermediateEntities = new ArrayList<>();
        Set<String> processedManyToManyRelations = new HashSet<>();

        if (schema.getRelationships() != null) {
            for (var rel : schema.getRelationships()) {
                if ("association".equals(rel.getType())
                        || "aggregation".equals(rel.getType())
                        || "composition".equals(rel.getType())
                        || "dependency".equals(rel.getType())) {
                    
                    String sourceName = schema.getClasses().stream()
                            .filter(cl -> cl.getId().equals(rel.getSourceId()))
                            .map(UmlClass::getName)
                            .findFirst().orElse(null);

                    String targetName = schema.getClasses().stream()
                            .filter(cl -> cl.getId().equals(rel.getTargetId()))
                            .map(UmlClass::getName)
                            .findFirst().orElse(null);

                    if (sourceName == null || targetName == null) continue;

                    String sourceCard = rel.getLabels().size() > 0 ? rel.getLabels().get(0).trim() : "";
                    String targetCard = rel.getLabels().size() > 1 ? rel.getLabels().get(1).trim() : "";

                    if (sourceCard.isEmpty() && "dependency".equals(rel.getType())) {
                        sourceCard = "*";
                        targetCard = "1";
                    }

                    boolean sourceIsMany = sourceCard.contains("*");
                    boolean targetIsMany = targetCard.contains("*");

                    // Si es ManyToMany, crear entidad intermedia
                    if (sourceIsMany && targetIsMany) {
                        String sourceEntity = NamingUtil.toJavaClass(sourceName);
                        String targetEntity = NamingUtil.toJavaClass(targetName);
                        
                        // Crear clave única para evitar duplicados (ordenar alfabéticamente)
                        String relKey = sourceEntity.compareTo(targetEntity) < 0 
                                ? sourceEntity + "_" + targetEntity 
                                : targetEntity + "_" + sourceEntity;
                        
                        if (!processedManyToManyRelations.contains(relKey)) {
                            processedManyToManyRelations.add(relKey);
                            
                            // Ordenar para consistencia en nombres
                            String firstEntity = sourceEntity.compareTo(targetEntity) < 0 ? sourceEntity : targetEntity;
                            String secondEntity = sourceEntity.compareTo(targetEntity) < 0 ? targetEntity : sourceEntity;
                            String firstEntityField = NamingUtil.toField(firstEntity);
                            String secondEntityField = NamingUtil.toField(secondEntity);
                            
                            // Nombre de la entidad intermedia: el que puso el usuario si
                            // colgó una clase de asociación, o el inventado si no.
                            UmlClass asociacion = assocPorConector.get(rel.getId());
                            String intermediateEntityName =
                                    AssociationClassUtil.nombreIntermedia(sourceEntity, targetEntity, asociacion);

                            // Crear contexto para la entidad intermedia
                            Map<String, Object> intermediateCtx = new HashMap<>();
                            intermediateCtx.put("basePackage", basePackage);
                            intermediateCtx.put("EntityName", intermediateEntityName);
                            intermediateCtx.put("plural", intermediateEntityName.toLowerCase());
                            
                            // Atributo ID autogenerado
                            List<Map<String, Object>> intermediateAttrs = new ArrayList<>();
                            intermediateAttrs.add(Map.of(
                                "isId", true,
                                "type", "Long",
                                "name", "id",
                                "generated", true
                            ));

                            // Atributos propios de la clase de asociación (cantidad,
                            // descuento...). Se saltean los que chocarían con el id
                            // sintético o con los dos campos de relación.
                            if (asociacion != null && asociacion.getAttributes() != null) {
                                Set<String> ocupados = new HashSet<>(
                                        List.of("id", firstEntityField, secondEntityField));
                                for (var attr : asociacion.getAttributes()) {
                                    String nombre = NamingUtil.toField(attr.getName());
                                    if (!ocupados.add(nombre)) continue;
                                    intermediateAttrs.add(Map.of(
                                        "isId", false,
                                        "type", TypeMapper.toJava(attr.getType()),
                                        "name", nombre
                                    ));
                                }
                            }
                            intermediateCtx.put("attributes", intermediateAttrs);

                            // Opción A: la clave primaria es el id propio, y el par de
                            // foráneas queda protegido por una restricción única para
                            // que no se cargue dos veces la misma combinación.
                            intermediateCtx.put("hasTableConstraint", true);
                            // Se arman acá las llaves del arreglo: en la plantilla, un
                            // "{" pegado a "{{{" se vuelve ambiguo para Mustache.
                            intermediateCtx.put("uniqueColumns",
                                    "{\"" + firstEntityField + "_id\", \"" + secondEntityField + "_id\"}");

                            // Dos relaciones ManyToOne con configuración para evitar loops
                            List<Map<String, Object>> intermediateManyToOne = new ArrayList<>();
                            intermediateManyToOne.add(Map.of(
                                "TargetEntity", firstEntity,
                                "targetField", firstEntityField,
                                "ignoreBackReference", NamingUtil.toField(intermediateEntityName)
                            ));
                            intermediateManyToOne.add(Map.of(
                                "TargetEntity", secondEntity,
                                "targetField", secondEntityField,
                                "ignoreBackReference", NamingUtil.toField(intermediateEntityName)
                            ));
                            intermediateCtx.put("manyToOne", intermediateManyToOne);
                            intermediateCtx.put("hasManyToOne", true);
                            
                            // Sin otras relaciones
                            intermediateCtx.put("oneToMany", new ArrayList<>());
                            intermediateCtx.put("oneToOne", new ArrayList<>());
                            intermediateCtx.put("manyToMany", new ArrayList<>());
                            intermediateCtx.put("methods", new ArrayList<>());
                            intermediateCtx.put("isParent", false);
                            intermediateCtx.put("needsOnDeleteImport", false);
                            intermediateCtx.put("hasOneToOne", false);
                            
                            // PK info
                            intermediateCtx.put("pkName", "id");
                            intermediateCtx.put("pkType", "Long");
                            intermediateCtx.put("pkSetter", "setId");
                            intermediateCtx.put("pkGetter", "getId");
                            intermediateCtx.put("pkGenerated", true);
                            intermediateCtx.put("hasPk", true);
                            
                            intermediateEntities.add(intermediateCtx);
                        }
                    }
                }
            }
        }

        for (UmlClass c : schema.getClasses()) {
            // Las clases de asociación ya se generaron como entidad intermedia de su
            // relación N:M. Si además se generaran acá quedarían dos tablas para el
            // mismo concepto, y esta tomaría su primer atributo como clave primaria.
            if (assocIds.contains(c.getId())) continue;

            String entityName = NamingUtil.toJavaClass(c.getName());

            // ====== DETECTAR PADRE (herencia) ANTES ======
            String parentClass = null;
            if (schema.getRelationships() != null) {
                for (var rel : schema.getRelationships()) {
                    if ("generalization".equals(rel.getType()) && rel.getSourceId().equals(c.getId())) {
                        parentClass = schema.getClasses().stream()
                                .filter(pc -> pc.getId().equals(rel.getTargetId()))
                                .map(UmlClass::getName)
                                .map(NamingUtil::toJavaClass)
                                .findFirst()
                                .orElse(null);
                    }
                }
            }
            boolean isChild = parentClass != null;

            // ====== ATRIBUTOS (PK dinámica: num -> Long autoinc, String -> PK sin autoinc) ======
            List<Map<String, Object>> attrs = new ArrayList<>();
            boolean pkAssigned = false;
            String pkName = null;
            String pkType = null;

            // Si tiene padre (herencia), NO debe asignar PK propia
            // La PK viene del padre
            for (var attr : c.getAttributes()) {
                Map<String, Object> a = new HashMap<>();
                String type = TypeMapper.toJava(attr.getType());
                String name = NamingUtil.toField(attr.getName());

                boolean isNumeric = type.equalsIgnoreCase("int")
                        || type.equalsIgnoreCase("Integer")
                        || type.equalsIgnoreCase("long")
                        || type.equalsIgnoreCase("Long")
                        || type.equalsIgnoreCase("short")
                        || type.equalsIgnoreCase("byte");

                // SOLO asignar PK si NO tiene padre Y es el primer atributo Y no se ha asignado aún
                if (!isChild && !pkAssigned) {
                    if (isNumeric) {
                        a.put("isId", true);
                        a.put("type", "Long");
                        a.put("generated", true);
                        pkAssigned = true;
                        pkName = name;
                        pkType = "Long";
                    } else if (type.equalsIgnoreCase("String")
                            || type.equalsIgnoreCase("char")
                            || type.equalsIgnoreCase("Character")) {
                        a.put("isId", true);
                        a.put("type", "String");
                        a.put("generated", false);
                        pkAssigned = true;
                        pkName = name;
                        pkType = "String";
                    } else {
                        a.put("isId", false);
                        a.put("type", type);
                    }
                } else {
                    // Si tiene padre, TODOS los atributos son normales (no PK)
                    a.put("isId", false);
                    a.put("type", type);
                }
                a.put("name", name);
                attrs.add(a);
            }

            // ====== RELACIONES ======
            List<Map<String, Object>> oneToMany = new ArrayList<>();
            List<Map<String, Object>> manyToOne = new ArrayList<>();
            List<Map<String, Object>> oneToOne  = new ArrayList<>();
            List<Map<String, Object>> manyToMany = new ArrayList<>();
            boolean needsOnDeleteImport = false;

            // Para eliminar atributos ‘xxxId’ redundantes si hay relación
            Set<String> fkPlaceholderNames = new HashSet<>();

            if (schema.getRelationships() != null) {
                for (var rel : schema.getRelationships()) {
                    String sourceName = schema.getClasses().stream()
                            .filter(cl -> cl.getId().equals(rel.getSourceId()))
                            .map(UmlClass::getName)
                            .findFirst().orElse(null);

                    String targetName = schema.getClasses().stream()
                            .filter(cl -> cl.getId().equals(rel.getTargetId()))
                            .map(UmlClass::getName)
                            .findFirst().orElse(null);

                    if (sourceName == null || targetName == null) continue;

                    String sourceEntity = NamingUtil.toJavaClass(sourceName);
                    String targetEntity = NamingUtil.toJavaClass(targetName);

                    if ("generalization".equals(rel.getType()) && rel.getSourceId().equals(c.getId())) {
                        parentClass = targetEntity;
                    }

                    // ---- Asociaciones / Agregación / Composición / Dependencia ----
                    if ("association".equals(rel.getType())
                            || "aggregation".equals(rel.getType())
                            || "composition".equals(rel.getType())
                            || "dependency".equals(rel.getType())) {

                        // 1) Normalizar etiquetas (vacías -> "1")
                        String rawSource = (rel.getLabels().size() > 0 && rel.getLabels().get(0) != null)
                                ? rel.getLabels().get(0).trim()
                                : "";
                        String rawTarget = (rel.getLabels().size() > 1 && rel.getLabels().get(1) != null)
                                ? rel.getLabels().get(1).trim()
                                : "";

                        String sourceCard = rawSource.isEmpty() ? "*" : rawSource;
                        String targetCard = rawTarget.isEmpty() ? "1" : rawTarget;

                        // 2) Regla por defecto para dependency SIN multiplicidades (o vacías)
                        if ("dependency".equals(rel.getType())) {
                            boolean noMultis = (rawSource.isEmpty() && rawTarget.isEmpty());
                            if (noMultis) {
                                // por defecto: muchos dependientes (*)
                                // apuntan a un principal (1)
                                sourceCard = "*";
                                targetCard = "1";
                            }
                        }

                        // 3) Detectar "many"
                        boolean sourceIsMany = sourceCard.contains("*");
                        boolean targetIsMany = targetCard.contains("*");

                        // 👇 Nuevo: nunca dejes que dependency sea tratado como 1..1
                        if ("dependency".equals(rel.getType()) && !sourceIsMany && !targetIsMany) {
                            sourceIsMany = true;
                            targetIsMany = false;
                        }


                        // === Lado SOURCE = esta clase ===
                        if (c.getName().equals(sourceName)) {
                            if (sourceIsMany && !targetIsMany) {
                                // source *..1 target => Source tiene ManyToOne hacia Target
                                manyToOne.add(Map.of(
                                        "TargetEntity", targetEntity,
                                        "targetField", NamingUtil.toField(targetEntity)
                                ));
                            } else if (!sourceIsMany && !targetIsMany) {
                                // 1..1 => OneToOne
                                boolean isComposition = "composition".equals(rel.getType());
                                oneToOne.add(Map.of(
                                        "TargetEntity", targetEntity,
                                        "targetField", NamingUtil.toField(targetEntity),
                                        "composition", isComposition
                                ));
                                if (isComposition) {
                                    needsOnDeleteImport = true;
                                }
                            } else if (sourceIsMany && targetIsMany) {
                                // *..* => Crear OneToMany hacia entidad intermedia
                                String intermediateEntityName = AssociationClassUtil.nombreIntermedia(
                                        sourceEntity, targetEntity, assocPorConector.get(rel.getId()));
                                String mappedByField = NamingUtil.toField(sourceEntity);
                                
                                oneToMany.add(Map.of(
                                        "TargetEntity", intermediateEntityName,
                                        "collectionField", NamingUtil.toField(intermediateEntityName),
                                        "mappedBy", mappedByField
                                ));
                            } else if (!sourceIsMany && targetIsMany) {
                                // source 1..* target => Source tiene OneToMany
                                oneToMany.add(Map.of(
                                        "TargetEntity", targetEntity,
                                        "collectionField", NamingUtil.toField(targetEntity),
                                        "mappedBy", NamingUtil.toField(sourceEntity)
                                ));
                            }
                        }

                        // === Lado TARGET = esta clase (inversos) ===
                        if (c.getName().equals(targetName)) {
                            if (!targetIsMany && sourceIsMany) {
                                // source *..1 target => Target tiene OneToMany hacia Source
                                oneToMany.add(Map.of(
                                        "TargetEntity", sourceEntity,
                                        "collectionField", NamingUtil.toField(sourceEntity),
                                        "mappedBy", NamingUtil.toField(targetEntity)
                                ));
                            } else if (targetIsMany && !sourceIsMany) {
                                // source 1..* target => Target tiene ManyToOne hacia Source
                                manyToOne.add(Map.of(
                                        "TargetEntity", sourceEntity,
                                        "targetField", NamingUtil.toField(sourceEntity)
                                ));
                            } else if (targetIsMany && sourceIsMany) {
                                // source *..* target => Target también tiene OneToMany hacia entidad intermedia
                                String intermediateEntityName = AssociationClassUtil.nombreIntermedia(
                                        sourceEntity, targetEntity, assocPorConector.get(rel.getId()));
                                String mappedByField = NamingUtil.toField(targetEntity);
                                
                                oneToMany.add(Map.of(
                                        "TargetEntity", intermediateEntityName,
                                        "collectionField", NamingUtil.toField(intermediateEntityName),
                                        "mappedBy", mappedByField
                                ));
                            }
                            // 1..1 no se duplica si ya lo generaste en source
                        }
                    }
                }

                // Si la clase hereda de otra, eliminar atributos duplicados del padre
                if (parentClass != null) {
                    final String parentClassName = parentClass;
                    UmlClass parent = schema.getClasses().stream()
                            .filter(pc -> NamingUtil.toJavaClass(pc.getName()).equals(parentClassName))
                            .findFirst()
                            .orElse(null);

                    if (parent != null) {
                        final Set<String> parentAttrs = parent.getAttributes().stream()
                                .map(a -> NamingUtil.toField(a.getName()))
                                .collect(Collectors.toSet());

                        attrs.removeIf(a -> parentAttrs.contains((String) a.get("name")));
                    }
                }
            }

            // ====== ELIMINAR placeholders “xxxId” si hubo relaciones que los sustituyen ======
            if (!fkPlaceholderNames.isEmpty()) {
                attrs.removeIf(a -> fkPlaceholderNames.contains(((String) a.get("name")).toLowerCase()));
            }

            // ====== MÉTODOS VACÍOS ======
            List<Map<String, Object>> methods = new ArrayList<>();
            for (var m : c.getMethods()) {
                Map<String, Object> mm = new HashMap<>();
                String returnType = (m.getReturnType() == null || m.getReturnType().isBlank()) ? "void" : TypeMapper.toJava(m.getReturnType());
                mm.put("name", m.getName());
                mm.put("parameters", m.getParameters() == null ? "" : m.getParameters());
                mm.put("returnType", returnType);

                String defaultReturn = switch (returnType) {
                    case "int", "long", "short", "byte" -> "0";
                    case "double", "float" -> "0.0";
                    case "boolean" -> "false";
                    case "char" -> "'\\u0000'";
                    default -> "null";
                };
                mm.put("defaultReturn", defaultReturn);
                methods.add(mm);
            }

            boolean isParent = schema.getRelationships().stream()
                    .anyMatch(r -> "generalization".equals(r.getType()) && r.getTargetId().equals(c.getId()));

            // ====== CONTEXTO MUSTACHE ======
            Map<String, Object> entityCtx = new HashMap<>();
            entityCtx.put("basePackage", basePackage);
            entityCtx.put("EntityName", entityName);
            entityCtx.put("attributes", attrs);
            entityCtx.put("oneToMany", oneToMany);
            entityCtx.put("manyToOne", manyToOne);
            entityCtx.put("oneToOne", oneToOne);
            entityCtx.put("manyToMany", manyToMany);
            entityCtx.put("parentClass", parentClass);
            entityCtx.put("methods", methods);
            entityCtx.put("isParent", isParent);
            entityCtx.put("plural", entityName.toLowerCase());
            entityCtx.put("needsOnDeleteImport", needsOnDeleteImport);
            entityCtx.put("hasManyToOne", !manyToOne.isEmpty());
            entityCtx.put("hasOneToOne", !oneToOne.isEmpty());

            // PK para Controller/Service
            if (isChild) {
                final String parentClassName = parentClass;
                UmlClass parent = schema.getClasses().stream()
                        .filter(pc -> NamingUtil.toJavaClass(pc.getName()).equals(parentClassName))
                        .findFirst()
                        .orElse(null);

                if (parent != null && !parent.getAttributes().isEmpty()) {
                    String parentPkName = NamingUtil.toField(parent.getAttributes().get(0).getName());
                    String parentPkType = TypeMapper.toJava(parent.getAttributes().get(0).getType());
                    String pkSetter = "set" + Character.toUpperCase(parentPkName.charAt(0)) + parentPkName.substring(1);
                    String pkGetter = "get" + Character.toUpperCase(parentPkName.charAt(0)) + parentPkName.substring(1);
                    
                    // Determinar si la PK del padre es autogenerada (numérica)
                    boolean pkGenerated = isNumericType(parentPkType);

                    entityCtx.put("pkName", parentPkName);
                    entityCtx.put("pkType", parentPkType);
                    entityCtx.put("pkSetter", pkSetter);
                    entityCtx.put("pkGetter", pkGetter);
                    entityCtx.put("pkGenerated", pkGenerated);
                    entityCtx.put("hasPk", true);
                } else {
                    entityCtx.put("hasPk", false);
                }
            } else if (pkAssigned) {
                String pkSetter = "set" + Character.toUpperCase(pkName.charAt(0)) + pkName.substring(1);
                String pkGetter = "get" + Character.toUpperCase(pkName.charAt(0)) + pkName.substring(1);
                
                // Determinar si es autogenerada basándose en el tipo
                boolean pkGenerated = isNumericType(pkType);
                
                entityCtx.put("pkName", pkName);
                entityCtx.put("pkType", pkType);
                entityCtx.put("pkSetter", pkSetter);
                entityCtx.put("pkGetter", pkGetter);
                entityCtx.put("pkGenerated", pkGenerated);
                entityCtx.put("hasPk", true);
            } else {
                entityCtx.put("hasPk", false);
            }

            // render
            render("Entity.mustache", entityCtx, modelDir.resolve(entityName + ".java"));
            render("Repository.mustache", entityCtx, repoDir.resolve(entityName + "Repository.java"));
            render("Service.mustache", entityCtx, svcDir.resolve(entityName + "Service.java"));
            render("Controller.mustache", entityCtx, ctrlDir.resolve(entityName + "Controller.java"));
        }

        // ====== GENERAR ENTIDADES INTERMEDIAS ======
        for (Map<String, Object> intermediateCtx : intermediateEntities) {
            String intermediateEntityName = (String) intermediateCtx.get("EntityName");
            render("Entity.mustache", intermediateCtx, modelDir.resolve(intermediateEntityName + ".java"));
            render("Repository.mustache", intermediateCtx, repoDir.resolve(intermediateEntityName + "Repository.java"));
            render("Service.mustache", intermediateCtx, svcDir.resolve(intermediateEntityName + "Service.java"));
            render("Controller.mustache", intermediateCtx, ctrlDir.resolve(intermediateEntityName + "Controller.java"));
        }

        // ====== GENERAR COLECCIÓN DE POSTMAN ======
        Path postmanJson = postmanCollectionGenerator.generatePostmanCollection(schema, "http://localhost:9000", artifactId);
        Files.copy(postmanJson, root.resolve(artifactId + "-postman-collection.json"));
        Files.deleteIfExists(postmanJson); // Limpiar temporal

        Path zip = root.getParent().resolve(artifactId + ".zip");
        ZipUtil.pack(root.toFile(), zip.toFile());
        return zip;
    }

    private boolean isNumericType(String javaType) {
        return javaType.equalsIgnoreCase("int") || javaType.equalsIgnoreCase("Integer")
                || javaType.equalsIgnoreCase("long") || javaType.equalsIgnoreCase("Long")
                || javaType.equalsIgnoreCase("short") || javaType.equalsIgnoreCase("byte");
    }

    private void render(String template, Map<String, Object> ctx, Path target) throws IOException {
        Mustache mustache = mustacheFactory.compile("templates/" + template);
        try (Writer w = new FileWriter(target.toFile())) {
            mustache.execute(w, ctx).flush();
        }
    }
}
