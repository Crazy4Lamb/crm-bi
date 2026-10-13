package com.crazy4lamb.crmbi;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.scheduling.annotation.EnableScheduling;

@SpringBootApplication
@EnableScheduling
public class CrmBiApplication {
  public static void main(String[] args) {
    loadDotEnv();
    SpringApplication.run(CrmBiApplication.class, args);
  }

  private static void loadDotEnv() {
    Path file = Path.of(".env");
    if (!Files.isRegularFile(file)) return;
    try {
      for (String line : Files.readAllLines(file)) {
        String value = line.trim();
        if (value.isEmpty() || value.startsWith("#") || !value.contains("=")) continue;
        int split = value.indexOf('=');
        String key = value.substring(0, split).trim();
        if (System.getenv(key) == null && System.getProperty(key) == null) {
          System.setProperty(key, value.substring(split + 1).trim());
        }
      }
    } catch (IOException error) {
      throw new IllegalStateException("Cannot read .env", error);
    }
  }
}
