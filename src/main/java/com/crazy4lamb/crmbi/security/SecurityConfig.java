package com.crazy4lamb.crmbi.security;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.authentication.UsernamePasswordAuthenticationFilter;

@Configuration
public class SecurityConfig {
  @Bean PasswordEncoder passwords() { return new BCryptPasswordEncoder(); }
  @Bean SecurityFilterChain security(HttpSecurity http, AuthFilter filter) throws Exception {
    return http.csrf(csrf -> csrf.disable())
        .sessionManagement(session -> session.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
        .authorizeHttpRequests(auth -> auth.requestMatchers("/api/health", "/api/auth/login", "/api/auth/demo-accounts", "/", "/index.html", "/login.html", "/css/**", "/js/**", "/lib/**").permitAll().anyRequest().authenticated())
        .addFilterBefore(filter, UsernamePasswordAuthenticationFilter.class)
        .build();
  }
}
