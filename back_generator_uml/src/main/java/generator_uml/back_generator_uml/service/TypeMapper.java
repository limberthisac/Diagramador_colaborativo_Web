package generator_uml.back_generator_uml.service;

public class TypeMapper {
    public static String toJava(String t) {
        if (t == null) return "String";
        String s = t.trim().toLowerCase();

        return switch (s) {
            case "int", "integer" -> "Integer";
            case "long" -> "Long";
            case "string" -> "String";   // 🔥 corregido
            case "bool", "boolean" -> "Boolean";
            case "float" -> "Float";
            case "double" -> "Double";
            default -> "String"; // fallback seguro
        };
    }
}
