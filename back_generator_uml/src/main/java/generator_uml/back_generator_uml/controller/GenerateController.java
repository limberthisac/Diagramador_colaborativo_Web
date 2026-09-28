package generator_uml.back_generator_uml.controller;

import generator_uml.back_generator_uml.entity.UmlSchema;
import generator_uml.back_generator_uml.service.ProjectGenerator;
import lombok.RequiredArgsConstructor;
import org.springframework.http.*;
import org.springframework.web.bind.annotation.*;

import java.nio.file.Files;
import java.nio.file.Path;

@RestController
@RequestMapping("/generate")
@RequiredArgsConstructor
public class GenerateController {

    private final ProjectGenerator projectGenerator;

    @PostMapping(produces = MediaType.APPLICATION_OCTET_STREAM_VALUE)
    public ResponseEntity<byte[]> generate(@RequestBody UmlSchema schema,
                                           @RequestParam(defaultValue = "com.example.genapp") String basePackage,
                                           @RequestParam(defaultValue = "generated-app") String artifactId) throws Exception {
        Path zipPath = projectGenerator.generate(schema, basePackage, artifactId);
        byte[] bytes = Files.readAllBytes(zipPath);

        return ResponseEntity.ok()
                .header(HttpHeaders.CONTENT_DISPOSITION, "attachment; filename=" + artifactId + ".zip")
                .body(bytes);
    }

}

