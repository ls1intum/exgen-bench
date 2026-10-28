package exgen.survey.web;

import exgen.survey.SurveyProperties;

/**
 * The session cookie a personal link is exchanged for. Over HTTPS it carries the {@code __Host-}
 * prefix, which browsers accept only from a secure origin, for the whole host and no subdomain.
 */
final class LinkCookie {
    private LinkCookie() {}

    static String name(SurveyProperties properties) {
        return properties.secureCookies() ? "__Host-exgen-survey" : "exgen-survey";
    }
}
