package generator_uml.back_generator_uml.service;

import org.apache.commons.text.WordUtils;

public class NamingUtil {

    public static String toJavaClass(String name) {
        String cleaned = name.replaceAll("[^\\p{IsAlphabetic}\\p{IsDigit}]+"," ");
        return WordUtils.capitalizeFully(cleaned).replace(" ","");
    }

    public static String toField(String name) {
        String cls = toJavaClass(name);
        return Character.toLowerCase(cls.charAt(0)) + cls.substring(1);
    }

    public static String plural(String name) {
        if (name.endsWith("s")) return name + "es";
        return name + "s";
    }
}

