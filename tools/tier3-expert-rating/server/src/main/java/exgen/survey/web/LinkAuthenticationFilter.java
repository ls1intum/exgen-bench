package exgen.survey.web;

import exgen.survey.rating.SurveyStore;
import exgen.survey.rating.SurveyStore.Holder;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.Cookie;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.io.IOException;
import java.util.Arrays;
import java.util.List;
import org.springframework.security.authentication.UsernamePasswordAuthenticationToken;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.web.filter.OncePerRequestFilter;

/** Resolves the session cookie to who holds the link: the study team or a rater. */
class LinkAuthenticationFilter extends OncePerRequestFilter {
    private final SurveyStore store;
    private final String cookie;

    LinkAuthenticationFilter(SurveyStore store, String cookie) {
        this.store = store;
        this.cookie = cookie;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain)
            throws ServletException, IOException {
        var cookies = request.getCookies() == null ? new Cookie[0] : request.getCookies();
        Arrays.stream(cookies)
                .filter(candidate -> candidate.getName().equals(cookie))
                .findFirst()
                .flatMap(candidate -> store.holderOf(candidate.getValue()))
                .ifPresent(holder -> {
                    var role = holder instanceof Holder.Admin ? "ROLE_ADMIN" : "ROLE_RATER";
                    var context = SecurityContextHolder.createEmptyContext();
                    context.setAuthentication(UsernamePasswordAuthenticationToken.authenticated(
                            holder, null, List.of(new SimpleGrantedAuthority(role))));
                    SecurityContextHolder.setContext(context);
                });
        chain.doFilter(request, response);
    }
}
