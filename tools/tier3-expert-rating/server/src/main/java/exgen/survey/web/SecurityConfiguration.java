package exgen.survey.web;

import exgen.survey.SurveyProperties;
import exgen.survey.rating.SurveyStore;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.Map;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configuration.EnableWebSecurity;
import org.springframework.security.config.annotation.web.configurers.AbstractHttpConfigurer;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.core.userdetails.UserDetailsService;
import org.springframework.security.provisioning.InMemoryUserDetailsManager;
import org.springframework.security.web.SecurityFilterChain;
import org.springframework.security.web.header.HeaderWriterFilter;
import org.springframework.security.web.header.writers.CrossOriginOpenerPolicyHeaderWriter.CrossOriginOpenerPolicy;
import org.springframework.security.web.header.writers.ReferrerPolicyHeaderWriter.ReferrerPolicy;
import org.springframework.security.web.header.writers.StaticHeadersWriter;
import tools.jackson.databind.json.JsonMapper;

/**
 * Who may call what. A personal link is exchanged for a session cookie once, and every request
 * carries that cookie; there are no accounts or passwords.
 *
 * <p>Spring Security's CSRF tokens are off on purpose: the cookie is {@code SameSite=Strict}, every
 * request that changes state must come from this host ({@link SameOriginFilter}) and send JSON,
 * which a cross-site form cannot, and no GET request changes state.
 */
@Configuration(proxyBeanMethods = false)
@EnableWebSecurity
public class SecurityConfiguration {

    /**
     * Scripts and style sheets come only from this server. Inline style attributes are allowed, and
     * nothing else inline: PlantUML's engine sets them on the SVG it assembles in the page, they
     * cannot run code, statement HTML loses its own style attributes to the sanitizer, and
     * {@code img-src} keeps any URL in them on this server.
     */
    static final String CONTENT_SECURITY_POLICY = "default-src 'self'; script-src 'self'; style-src 'self'; "
            + "style-src-attr 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; "
            + "object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

    @Bean
    SecurityFilterChain filterChain(HttpSecurity http, SurveyStore store, SurveyProperties properties, JsonMapper json)
            throws Exception {
        http.csrf(AbstractHttpConfigurer::disable)
                .formLogin(AbstractHttpConfigurer::disable)
                .httpBasic(AbstractHttpConfigurer::disable)
                .logout(AbstractHttpConfigurer::disable)
                .requestCache(AbstractHttpConfigurer::disable)
                .sessionManagement(session -> session.sessionCreationPolicy(SessionCreationPolicy.STATELESS))
                .addFilterAfter(new SameOriginFilter(json), HeaderWriterFilter.class)
                .addFilterAfter(
                        new LinkAuthenticationFilter(store, LinkCookie.name(properties)), SameOriginFilter.class)
                .authorizeHttpRequests(requests -> requests.requestMatchers("/api/site", "/api/legal/**")
                        .permitAll()
                        .requestMatchers("/api/admin/**")
                        .hasRole("ADMIN")
                        .requestMatchers("/api/session")
                        .authenticated()
                        .requestMatchers("/api/**")
                        .hasRole("RATER")
                        .anyRequest()
                        .permitAll())
                .exceptionHandling(errors -> errors.authenticationEntryPoint(
                                (request, response, error) -> refuse(json, request, response))
                        .accessDeniedHandler((request, response, error) -> refuse(json, request, response)))
                .headers(headers -> headers.contentSecurityPolicy(csp -> csp.policyDirectives(CONTENT_SECURITY_POLICY))
                        .referrerPolicy(referrer -> referrer.policy(ReferrerPolicy.NO_REFERRER))
                        .frameOptions(frame -> frame.deny())
                        .httpStrictTransportSecurity(hsts -> hsts.maxAgeInSeconds(31_536_000))
                        .crossOriginOpenerPolicy(coop -> coop.policy(CrossOriginOpenerPolicy.SAME_ORIGIN))
                        .addHeaderWriter(new StaticHeadersWriter(
                                "Permissions-Policy", "camera=(), microphone=(), geolocation=()"))
                        .addHeaderWriter(new StaticHeadersWriter("X-Robots-Tag", "noindex, nofollow")));
        return http.build();
    }

    /** No user accounts exist; this keeps Spring Boot from generating a default password. */
    @Bean
    UserDetailsService noUsers() {
        return new InMemoryUserDetailsManager();
    }

    /** A request without the right link: the browser app explains how to get in. */
    private static void refuse(JsonMapper json, HttpServletRequest request, HttpServletResponse response)
            throws IOException {
        var message = request.getRequestURI().startsWith("/api/admin/")
                ? "the study team's link is required"
                : "open your personal link to continue";
        response.setStatus(HttpStatus.UNAUTHORIZED.value());
        response.setContentType(MediaType.APPLICATION_JSON_VALUE);
        json.writeValue(response.getOutputStream(), Map.of("error", message));
    }
}
