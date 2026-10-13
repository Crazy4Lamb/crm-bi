package com.crazy4lamb.crmbi.security;

import com.crazy4lamb.crmbi.core.ApiException;
import com.crazy4lamb.crmbi.core.UserPrincipal;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.Map;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

@Component
public class JwtService {
  private final byte[] secret;
  private final int hours;
  private final ObjectMapper json;
  private final Base64.Encoder encoder = Base64.getUrlEncoder().withoutPadding();
  private final Base64.Decoder decoder = Base64.getUrlDecoder();

  public JwtService(@Value("${app.jwt-secret}") String secret, @Value("${app.jwt-hours:12}") int hours, ObjectMapper json) {
    if (secret == null || secret.length() < 32) throw new IllegalStateException("JWT_SECRET must contain at least 32 characters");
    this.secret = secret.getBytes(StandardCharsets.UTF_8); this.hours = hours; this.json = json;
  }

  public String sign(UserPrincipal user) {
    try {
      String header = encoder.encodeToString("{\"alg\":\"HS256\",\"typ\":\"JWT\"}".getBytes(StandardCharsets.UTF_8));
      Map<String,Object> claims = new LinkedHashMap<>();
      claims.put("uid", user.id()); claims.put("username", user.username()); claims.put("role", user.role());
      claims.put("iat", Instant.now().getEpochSecond()); claims.put("exp", Instant.now().plusSeconds(hours * 3600L).getEpochSecond());
      String payload = encoder.encodeToString(json.writeValueAsBytes(claims));
      String unsigned = header + "." + payload;
      return unsigned + "." + encoder.encodeToString(hmac(unsigned));
    } catch (Exception error) { throw new IllegalStateException("Cannot create token", error); }
  }

  public Map<String,Object> verify(String token) {
    try {
      String[] parts = token.split("\\.");
      if (parts.length != 3) throw new IllegalArgumentException();
      byte[] expected = hmac(parts[0] + "." + parts[1]);
      if (!java.security.MessageDigest.isEqual(expected, decoder.decode(parts[2]))) throw new IllegalArgumentException();
      Map<String,Object> claims = json.readValue(decoder.decode(parts[1]), new TypeReference<>() {});
      if (((Number) claims.get("exp")).longValue() < Instant.now().getEpochSecond()) throw new IllegalArgumentException();
      return claims;
    } catch (Exception error) { throw new ApiException(401, "登录状态无效，请重新登录"); }
  }

  private byte[] hmac(String value) throws Exception {
    Mac mac = Mac.getInstance("HmacSHA256");
    mac.init(new SecretKeySpec(secret, "HmacSHA256"));
    return mac.doFinal(value.getBytes(StandardCharsets.UTF_8));
  }
}
