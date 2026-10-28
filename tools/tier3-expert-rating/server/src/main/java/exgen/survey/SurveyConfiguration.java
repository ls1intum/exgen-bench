package exgen.survey;

import exgen.survey.rating.SurveyStore;
import exgen.survey.study.LoadedStudy;
import exgen.survey.study.StudyLoader;
import java.time.InstantSource;
import org.springframework.boot.jackson.autoconfigure.JsonMapperBuilderCustomizer;
import org.springframework.boot.sql.init.dependency.DependsOnDatabaseInitialization;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import tools.jackson.databind.DeserializationFeature;

@Configuration(proxyBeanMethods = false)
public class SurveyConfiguration {

    /**
     * The study, loaded and verified against its frozen build, and recorded in the database before
     * the server takes its first request. Any mismatch stops the server here.
     */
    @Bean
    @DependsOnDatabaseInitialization
    LoadedStudy study(SurveyProperties properties, SurveyStore store) {
        var loaded = StudyLoader.load(properties.studyPath(), properties.instrumentPath());
        store.synchronize(loaded);
        return loaded;
    }

    @Bean
    InstantSource clock() {
        return InstantSource.system();
    }

    /** Requests are refused with an unknown field, as a misspelt answer must not vanish silently. */
    @Bean
    JsonMapperBuilderCustomizer strictRequests() {
        return builder -> builder.enable(DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES);
    }
}
