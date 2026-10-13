package com.crazy4lamb.crmbi.core;

import java.util.Map;
import org.postgresql.util.PSQLException;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

@RestControllerAdvice
public class ApiExceptionHandler {
  @ExceptionHandler(ApiException.class)
  ResponseEntity<?> api(ApiException error) {
    return ResponseEntity.status(error.status()).body(Map.of("code", error.status(), "message", error.getMessage()));
  }

  @ExceptionHandler(Exception.class)
  ResponseEntity<?> other(Exception error) {
    Throwable cause = error;
    while (cause.getCause() != null) cause = cause.getCause();
    int status = 500;
    if (cause instanceof PSQLException pg) {
      String state = pg.getSQLState();
      if (state != null && (state.startsWith("22") || state.startsWith("23"))) status = 400;
      else if ("42501".equals(state)) status = 403;
      else if ("P0002".equals(state)) status = 404;
    }
    String message = cause.getMessage() == null ? error.getMessage() : cause.getMessage();
    return ResponseEntity.status(status).body(Map.of("code", status, "message", message));
  }
}
